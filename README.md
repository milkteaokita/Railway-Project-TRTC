# Railway-Project-TRTC

**台北捷運（TRTC）即時到站 API 中繼代理、區間車同向合併與動態倒數快取服務**（建構於 **Cloudflare Workers + TypeScript**，零外部執行期相依套件）。

---

## 專案定位與解決問題

台北捷運官方 `TrackInfo` SOAP API 在實務串接上有幾項痛點：
1. **特殊的「JSON + XML 混合格式」**：回應主體前方直接輸出 JSON 陣列，後方緊接空的 SOAP Envelope XML，一般 REST 客戶端無法直接解析。
2. **區間車與全程車方向拆分**：上游僅提供列車終點站（`DestinationName`），未提供物理行駛方向，導致往同方向的區間車（如往北投、大安、亞東醫院、昆陽、台電大樓）與全程車各自獨立，乘客難以一眼得知哪一班車先到。
3. **跨線終點站撞名**：上游無路線代碼欄位，而板南線（`BL`）與文湖線（`BR`）終點站同為「南港展覽館站」，在交會站「忠孝復興站」容易混淆。
4. **上游呼叫額度限制**：單次呼叫即回傳全系統約 320 筆列車狀態，若直接由前端輪詢或以單站為單位快取，極易耗盡 API 額度。

本專案部署於 Cloudflare Workers 邊緣節點，負責完成**混合格式清理、路線歸屬推斷、同向區間車合併排序、清客列車過濾，以及基於時間差的動態倒數快取推算**。

---

## 系統架構與快取流程

```mermaid
flowchart TD
    Client["前端 / 客戶端 GET /api/arrivals"] --> Router["宣告式路由層 (router.ts)"]
    Router --> Service["到站核心服務層 (arrival.service.ts)"]
    Service --> Cache["雙層全系統快照快取 (snapshot-cache.ts)"]
    Cache -->|"1. L1 Isolate 記憶體 / 2. L2 caches.default"| Eval{"快取有效性評估"}
    Eval -->|"命中且 elapsed < 45s 且首班車 > 0s"| Project["動態推算 remainingSeconds = initial - elapsed"]
    Eval -->|"Miss / >= 45s / 首班車 <= 0s (已過 5s 冷卻)"| Lock["Single-Flight 併發合併鎖"]
    Lock --> Provider["北捷 SOAP 呼叫與混合解析器 (trtc-soap.provider.ts)"]
    Provider -->|"更新全系統快照"| Cache
    Project --> Response["回傳排序後之標準 JSON"]
```

### 核心目錄結構

```text
Railway-Project-TRTC/
├── src/
│   ├── index.ts                      # Cloudflare Worker 進入點
│   ├── config/
│   │   ├── constants.ts              # 服務識別資訊與執行期預設參數
│   │   └── trtc-network.ts           # 北捷路網設定檔（車站清單、終點方向、區間車映射規則）
│   ├── providers/
│   │   └── trtc-soap.provider.ts     # 北捷 SOAP 請求組裝與 JSON+XML 混合格式解析器
│   ├── cache/
│   │   └── snapshot-cache.ts         # L1 Isolate + Single-Flight + L2 Cache API 雙層快取管理
│   ├── services/
│   │   └── arrival.service.ts        # 驗證、區間車合併、動態秒數推算與重抓決策邏輯
│   ├── routes/
│   │   └── router.ts                 # 宣告式路由表（/, /health, /api/lines, /api/arrivals）
│   ├── types/
│   │   ├── env.ts                    # Worker Env 與機密變數型別定義
│   │   └── arrival.ts                # 領域資料結構與抽象 TrackDataProvider 介面
│   └── utils/
│       ├── http.ts                   # 統一 JSON / CORS / AppError 回應工具
│       ├── station.ts                # 站名正規化（「台北車站」防呆）與倒數字串解析
│       └── xml.ts                    # SOAP XML 特殊字元跳脫工具
├── test/                             # Vitest 單元與整合測試
├── .dev.vars.example                 # 本機環境變數範本（不含真實網址與憑證）
└── wrangler.jsonc                    # Cloudflare Workers 部署設定
```

---

## 支援路線與區間車合併規則

> 註：環狀線（`Y`）因目前尚未成環營運，暫不開放查詢（設定檔已預留結構，未來成環可直接啟用）。

| 路線代碼 | 路線名稱 | 支援查詢終點站 (`dest`) | 合併邏輯（全程終點 vs 區間終點） | 特殊邊界規則 |
| :--- | :--- | :--- | :--- | :--- |
| `BR` | 文湖線 | `南港展覽館`、`動物園` | 無區間車 | 於 `忠孝復興站` 自動與 `BL` 區分 |
| `R` | 淡水信義線 | 全程：`淡水`、`廣慈/奉天宮`<br>區間：`北投`、`大安`<br>支線：`新北投` | • 查全程終點（`淡水` / `廣慈/奉天宮`）：開啟 `includeShortTurn=true` 時納入 `北投` / `大安`<br>• **查區間終點（`北投` / `大安`）：不論有無帶 flag，預設一律合併同向全程車** | 南向終點已延伸為 `廣慈/奉天宮站`（不再支援 `象山`）；已過區間終點之下游車站會防呆阻擋反方向誤查 |
| `G` | 松山新店線 | 全程：`松山`、`新店`<br>區間：`台電大樓`<br>支線：`小碧潭`、`七張` | • 查 `新店`：開啟 `includeShortTurn=true` 時納入 `台電大樓`<br>• **查 `台電大樓`：不論有無帶 flag，預設一律合併 `新店` 全程車** | — |
| `O` | 中和新蘆線 | `南勢角`、`迴龍`、`蘆洲` | 查 `迴龍` ↔ 開啟 `includeShortTurn=true` 時合併 `蘆洲` | **僅限 `民權西路站 ～ 南勢角站` 共 11 站區間有效**；`大橋頭站` 與兩條分線段內不合併 |
| `BL` | 板南線 | 全程：`南港展覽館`、`頂埔`<br>區間：`昆陽`、`亞東醫院` | • 查全程終點：開啟 `includeShortTurn=true` 時納入 `昆陽` / `亞東醫院`<br>• **查區間終點（`昆陽` / `亞東醫院`）：不論有無帶 flag，預設一律合併同向全程車** | 於 `忠孝復興站` 自動透過車次與鄰站特徵與 `BR` 區分 |

- **清客列車防呆**：當使用者所在查詢站即為區間車終點站（例如人在 `大安站` 查往 `廣慈/奉天宮` 並開啟 `includeShortTurn=true`），系統會自動剔除 `DestinationName === "大安站"` 的清客不載客列車。

---

## API 端點說明

| 方法 | 路徑 | 說明 |
| :--- | :--- | :--- |
| `GET` | `/` | 服務身分資訊、支援路線摘要與所有可用端點導覽 |
| `GET` | `/health` | 檢查服務狀態與上游憑證環境變數是否已配置（不暴露機密內容） |
| `GET` | `/api/lines` | 取得完整路網設定、各線車站清單與區間車合併規則 |
| `GET` | `/api/arrivals` | 查詢即時列車到站倒數與區間車合併結果 |

### `GET /api/arrivals` 查詢參數

| 參數 | 必填 | 範例 | 說明 |
| :--- | :---: | :--- | :--- |
| `line` | 建議提供 | `R` 或 `淡水信義線` | 路線代碼或中文名稱。若省略且該站與終點站組合唯一，系統會自動推斷；若於 `忠孝復興` 查 `南港展覽館` 則必須提供以區分 `BL` / `BR`。 |
| `station` | **必填** | `大安` 或 `大安站` | 查詢車站名稱（自動正規化補齊「站」字，並內建 `台北車站` / `北車` / `臺`→`台` 轉換防呆）。 |
| `dest` | **必填** | `淡水` | 目標終點站名稱。 |
| `includeShortTurn` | 選填 | `true` / `false` | 預設 `false`。設為 `true` 時將同向區間車納入並依剩餘秒數由小到大合併排序。 |

### 回應範例

`GET /api/arrivals?line=R&station=大安&dest=淡水&includeShortTurn=true`

```json
{
  "ok": true,
  "system": "TRTC",
  "query": {
    "line": "R",
    "lineName": "淡水信義線",
    "station": "大安站",
    "dest": "淡水站",
    "includeShortTurn": true,
    "effectiveDestinations": [
      "淡水站",
      "北投站"
    ]
  },
  "cache": {
    "hit": true,
    "status": "HIT",
    "layer": "L2_EDGE",
    "fetchedAt": "2026-10-26T13:24:43.642Z",
    "elapsedSeconds": 12
  },
  "trains": [
    {
      "trainNumber": "",
      "lineCode": "R",
      "lineName": "淡水信義線",
      "destination": "北投站",
      "isShortTurn": true,
      "rawCountDown": "01:23",
      "initialSeconds": 83,
      "remainingSeconds": 71,
      "sourceTime": "2026-10-26 21:24:36"
    },
    {
      "trainNumber": "102",
      "lineCode": "R",
      "lineName": "淡水信義線",
      "destination": "淡水站",
      "isShortTurn": false,
      "rawCountDown": "04:49",
      "initialSeconds": 289,
      "remainingSeconds": 277,
      "sourceTime": "2026-10-26 21:24:36"
    }
  ]
}
```

---

## 本機開發與部署指南（機密資訊保護）

為確保專案可安全公開於 GitHub，**北捷 API 網址與帳號密碼嚴禁寫入程式碼或 `wrangler.jsonc`**。

### 1. 安裝相依套件

```bash
npm install
```

### 2. 設定本機環境變數（`.dev.vars`）

複製 `.dev.vars.example` 為 `.dev.vars`（已被 `.gitignore` 排除）：

```ini
TRTC_API_URL="https://your-trtc-endpoint.example.com/TrackInfo.asmx"
TRTC_API_USERNAME="your_username_here"
TRTC_API_PASSWORD="your_password_here"
```

啟動本機開發伺服器或執行測試：

```bash
# 執行型別檢查與單元測試
npm run typecheck
npm test

# 啟動本機 Cloudflare Worker 開發環境
npm run dev
```

### 3. 正式環境部署（Cloudflare Workers + Custom Domain）

1. **上傳加密 Secrets**：
   ```bash
   npx wrangler secret put TRTC_API_URL
   npx wrangler secret put TRTC_API_USERNAME
   npx wrangler secret put TRTC_API_PASSWORD
   ```
2. **綁定自訂網域（Custom Domain）**：
   - Cloudflare 原生 `caches.default`（Edge Cache API）在免費的 `*.workers.dev` 子網域上不會啟用，請於 `wrangler.jsonc` 的 `routes` 設定或至 Cloudflare Dashboard **Workers & Pages > Triggers > Custom Domains** 綁定你的自訂網域。
3. **執行部署**：
   ```bash
   npm run deploy
   ```

### 執行期調校參數（`wrangler.jsonc` `vars`）

| 變數名稱 | 預設值 | 說明 |
| :--- | :---: | :--- |
| `CACHE_MAX_AGE_SECONDS` | `"45"` | 快取最大信賴秒數，超過即強制向北捷重抓 |
| `ARRIVING_DEFAULT_SECONDS` | `"10"` | 遇到「列車進站／即將進站」時賦予的預設初始秒數 |
| `MIN_REFETCH_INTERVAL_SECONDS` | `"5"` | 最小重抓冷卻秒數（防止收班無車或狀態邊界造成無限重抓） |
| `UPSTREAM_TIMEOUT_MS` | `"8000"` | 呼叫北捷 SOAP API 的逾時毫秒數 |

---

## 未來擴充指南

1. **啟用新路線或修改區間車規則**：編輯 `src/config/trtc-network.ts` 中的 `TRTC_LINES` 註冊表（例如環狀線成環營運時，將 `Y.supported` 改為 `true` 並填入 `directions` 即可自動對外生效）。
2. **串接新上游資料源（如車廂擁擠度、TDX 備援或其他軌道系統）**：實作 `src/types/arrival.ts` 中的 `TrackDataProvider` 介面，即可直接重用 `SnapshotCacheManager` 雙層快取與併發鎖機制。
3. **新增 API 路由端點**：於 `src/routes/router.ts` 的 `ROUTE_DEFINITIONS` 新增一筆路由定義，根路徑 `GET /` 將自動同步更新端點導覽說明。
