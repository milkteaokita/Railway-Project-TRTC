/**
 * @module config/trtc-network
 * @description 台北捷運 (TRTC) 路網定義、車站清單、終點站方向與區間車合併規則設定檔。
 *
 * 擴充指南：
 * 1. 若未來新增路線（例如環狀線成環營運啟用 `Y`、萬大線 `LG`）：
 *    只需於 `TRTC_LINES` 調整 `supported: true` 並補上 `directions` 規則即可，無須修改核心快取或服務層邏輯。
 * 2. 若新增或變更區間車終點站：
 *    直接於對應路線的 `directions` 設定 `shortTurnDestinations`（查全程終點且開啟 flag 時納入）
 *    以及區間終點本身的 `alwaysIncludeDestinations`（查區間終點時無條件納入同向全程車）。
 */

import type { RawTrtcTrackItem, SupportedTrtcLineCode, TrtcLineCode } from '../types/arrival';
import { normalizeStationName } from '../utils/station';

/**
 * 單一營運方向與區間車／全程車合併規則定義
 */
export interface DirectionRule {
  /** 查詢指定之目標終點站（標準帶「站」格式，例如 `"淡水站"` 或 `"大安站"`） */
  terminal: string;
  /** 方向描述（供文件與 `/api/lines` 元資料端點說明） */
  description: string;
  /**
   * 無論 `includeShortTurn` 為 `true` 或 `false`，一律自動合併納入的同向全程車終點站清單。
   * 適用情境：當查詢區間車終點站（如 `大安站`、`北投站`、`台電大樓站`、`昆陽站`、`亞東醫院站`）時，
   * 同方向的全程車必定會停靠該站，因此預設一併回傳。
   */
  alwaysIncludeDestinations?: readonly string[];
  /**
   * 選填：僅當查詢車站位於此集合內時，才套用 `alwaysIncludeDestinations`（例如新北投支線折返北投站時不納入淡水站）。
   */
  alwaysIncludeApplicableStations?: ReadonlySet<string>;
  /**
   * 選填：限制允許查詢此 `terminal` 的有效起點車站集合（防止在已過區間終點站的下游車站誤查反方向）。
   */
  validOriginStations?: ReadonlySet<string>;
  /** 當查詢站不在 `validOriginStations` 內時回傳的引導提示訊息 */
  invalidOriginMessage?: string;
  /**
   * 當 `includeShortTurn=true` 時額外納入同向合併排序的區間車／共線支線終點站清單。
   * 註：程式執行時會自動過濾 `destination === 當前查詢車站` 的清客不載客列車。
   */
  shortTurnDestinations: readonly string[];
  /**
   * 選填：僅當查詢車站位於此集合內時，才允許套用 `shortTurnDestinations` 合併。
   * 例如中和新蘆線 (O)「民權西路站～南勢角站」共線段規則（大橋頭與分線段不合併）。
   */
  shortTurnApplicableStations?: ReadonlySet<string>;
}

/**
 * 單一路線完整設定結構
 */
export interface TrtcLineDefinition {
  /** 路線標準代碼 */
  code: TrtcLineCode;
  /** 路線官方中文名稱 */
  name: string;
  /** 接受的查詢別名（大小寫不敏感，例如 `["R", "淡水信義線", "紅線"]`） */
  aliases: readonly string[];
  /** 是否對外開放查詢（環狀線 Y 尚未成環營運，目前設為 `false`） */
  supported: boolean;
  /** 不支援時的友善提示訊息 */
  unsupportedReason?: string;
  /** 該路線所屬全數車站（正規化帶「站」字尾） */
  stations: readonly string[];
  /** 該路線屬於「區間車終點站」的站名集合（用於正確標記回傳列車的 `isShortTurn` 屬性） */
  shortTurnTerminals: ReadonlySet<string>;
  /** 支援查詢的方向與區間車映射清單 */
  directions: readonly DirectionRule[];
  /** 已停用／變更之舊終點站提示映射（例如象山站延伸至廣慈/奉天宮站） */
  deprecatedTerminals?: Readonly<Record<string, string>>;
}

// ============================================================================
// 路線主線有序車站定義與區間切片工具（避免手動維護站名清單產生遺漏）
// ============================================================================

function stationsBefore(orderedStations: readonly string[], pivotStation: string): Set<string> {
  const idx = orderedStations.indexOf(pivotStation);
  return new Set(idx > 0 ? orderedStations.slice(0, idx) : []);
}

function stationsAfter(orderedStations: readonly string[], pivotStation: string): Set<string> {
  const idx = orderedStations.indexOf(pivotStation);
  return new Set(idx >= 0 ? orderedStations.slice(idx + 1) : []);
}

/** 淡水信義線主線有序車站（由南至北：R01 廣慈/奉天宮站 -> R28 淡水站） */
const R_MAIN_SOUTH_TO_NORTH = [
  '廣慈/奉天宮站',
  '象山站',
  '台北101/世貿站',
  '信義安和站',
  '大安站',
  '大安森林公園站',
  '東門站',
  '中正紀念堂站',
  '台大醫院站',
  '台北車站',
  '中山站',
  '雙連站',
  '民權西路站',
  '圓山站',
  '劍潭站',
  '士林站',
  '芝山站',
  '明德站',
  '石牌站',
  '唭哩岸站',
  '奇岩站',
  '北投站',
  '復興崗站',
  '忠義站',
  '關渡站',
  '竹圍站',
  '紅樹林站',
  '淡水站',
] as const;

/** 松山新店線主線有序車站（由南至北：G01 新店站 -> G19 松山站） */
const G_MAIN_SOUTH_TO_NORTH = [
  '新店站',
  '新店區公所站',
  '七張站',
  '大坪林站',
  '景美站',
  '萬隆站',
  '公館站',
  '台電大樓站',
  '古亭站',
  '中正紀念堂站',
  '小南門站',
  '西門站',
  '北門站',
  '中山站',
  '松江南京站',
  '南京復興站',
  '台北小巨蛋站',
  '南京三民站',
  '松山站',
] as const;

/** 板南線全線有序車站（由西至東：BL01 頂埔站 -> BL23 南港展覽館站） */
const BL_WEST_TO_EAST = [
  '頂埔站',
  '永寧站',
  '土城站',
  '海山站',
  '亞東醫院站',
  '府中站',
  '板橋站',
  '新埔站',
  '江子翠站',
  '龍山寺站',
  '西門站',
  '台北車站',
  '善導寺站',
  '忠孝新生站',
  '忠孝復興站',
  '忠孝敦化站',
  '國父紀念館站',
  '市政府站',
  '永春站',
  '後山埤站',
  '昆陽站',
  '南港站',
  '南港展覽館站',
] as const;

// 各區間終點站之上游有效區間集合
const R_SOUTH_OF_BEITOU = stationsBefore(R_MAIN_SOUTH_TO_NORTH, '北投站'); // 廣慈/奉天宮站 ～ 奇岩站
const R_VALID_FOR_BEITOU_DEST: ReadonlySet<string> = new Set([
  ...R_SOUTH_OF_BEITOU,
  '新北投站',
]);
const R_NORTH_OF_DAAN = stationsAfter(R_MAIN_SOUTH_TO_NORTH, '大安站'); // 大安森林公園站 ～ 淡水站
const G_NORTH_OF_TAIPOWER = stationsAfter(G_MAIN_SOUTH_TO_NORTH, '台電大樓站'); // 古亭站 ～ 松山站
const BL_WEST_OF_KUNYANG = stationsBefore(BL_WEST_TO_EAST, '昆陽站'); // 頂埔站 ～ 後山埤站
const BL_EAST_OF_FAR_EASTERN = stationsAfter(BL_WEST_TO_EAST, '亞東醫院站'); // 府中站 ～ 南港展覽館站

/**
 * 中和新蘆線 (O) 允許透過 `includeShortTurn=true` 合併「往迴龍 / 往蘆洲」的共線區間車站（民權西路站～南勢角站，共 11 站）。
 * 依專案規格：大橋頭站及蘆洲／新莊分線段內不支援此合併標記。
 */
export const O_LINE_SHARED_TRUNK_MERGE_STATIONS: ReadonlySet<string> = new Set([
  '南勢角站',
  '景安站',
  '永安市場站',
  '頂溪站',
  '古亭站',
  '東門站',
  '忠孝新生站',
  '松江南京站',
  '行天宮站',
  '中山國小站',
  '民權西路站',
]);

/**
 * 台北捷運全路網設定註冊表
 */
export const TRTC_LINES: Readonly<Record<TrtcLineCode, TrtcLineDefinition>> = {
  BR: {
    code: 'BR',
    name: '文湖線',
    aliases: ['BR', '文湖線', '文湖', '棕線'],
    supported: true,
    shortTurnTerminals: new Set(),
    stations: [
      '動物園站',
      '木柵站',
      '萬芳社區站',
      '萬芳醫院站',
      '辛亥站',
      '麟光站',
      '六張犁站',
      '科技大樓站',
      '大安站',
      '忠孝復興站',
      '南京復興站',
      '中山國中站',
      '松山機場站',
      '大直站',
      '劍南路站',
      '西湖站',
      '港墘站',
      '文德站',
      '內湖站',
      '大湖公園站',
      '葫洲站',
      '東湖站',
      '南港軟體園區站',
      '南港展覽館站',
    ],
    directions: [
      {
        terminal: '南港展覽館站',
        description: '往南港展覽館方向（北／東向）',
        shortTurnDestinations: [],
      },
      {
        terminal: '動物園站',
        description: '往動物園方向（南／西向）',
        shortTurnDestinations: [],
      },
    ],
  },

  R: {
    code: 'R',
    name: '淡水信義線',
    aliases: ['R', '淡水信義線', '淡水信義', '紅線', '新北投支線'],
    supported: true,
    shortTurnTerminals: new Set(['北投站', '大安站']),
    stations: [...R_MAIN_SOUTH_TO_NORTH, '新北投站'],
    directions: [
      {
        terminal: '淡水站',
        description: '往淡水方向（北向；開啟 includeShortTurn 可合併往北投區間車）',
        shortTurnDestinations: ['北投站'],
        shortTurnApplicableStations: R_VALID_FOR_BEITOU_DEST,
      },
      {
        terminal: '廣慈/奉天宮站',
        description: '往廣慈/奉天宮方向（南向；開啟 includeShortTurn 可合併往大安區間車）',
        shortTurnDestinations: ['大安站'],
        shortTurnApplicableStations: R_NORTH_OF_DAAN,
      },
      {
        terminal: '北投站',
        description: '往北投方向（北向區間終點／新北投支線折返；於主線自動包含往淡水全程車）',
        alwaysIncludeDestinations: ['淡水站'],
        alwaysIncludeApplicableStations: R_SOUTH_OF_BEITOU,
        validOriginStations: R_VALID_FOR_BEITOU_DEST,
        invalidOriginMessage:
          '查詢車站位於「北投站」以北，無北上往北投列車；若欲南下前往北投站，請改查詢 dest=廣慈/奉天宮（或 dest=大安）。',
        shortTurnDestinations: [],
      },
      {
        terminal: '大安站',
        description: '往大安方向（南向區間終點；自動包含往廣慈/奉天宮全程車）',
        alwaysIncludeDestinations: ['廣慈/奉天宮站'],
        alwaysIncludeApplicableStations: R_NORTH_OF_DAAN,
        validOriginStations: R_NORTH_OF_DAAN,
        invalidOriginMessage:
          '查詢車站位於「大安站」以南（或支線），無南下往大安列車；若欲北上前往大安站，請改查詢 dest=淡水 或 dest=北投。',
        shortTurnDestinations: [],
      },
      {
        terminal: '新北投站',
        description: '往新北投方向（新北投支線）',
        shortTurnDestinations: [],
      },
    ],
    deprecatedTerminals: {
      象山站:
        '淡水信義線南向終點站已延伸變更為「廣慈/奉天宮站」，不再支援以「象山站」作為終點查詢，請改用 dest=廣慈/奉天宮。',
    },
  },

  G: {
    code: 'G',
    name: '松山新店線',
    aliases: ['G', '松山新店線', '松山新店', '綠線', '小碧潭支線'],
    supported: true,
    shortTurnTerminals: new Set(['台電大樓站']),
    stations: [...G_MAIN_SOUTH_TO_NORTH, '小碧潭站'],
    directions: [
      {
        terminal: '松山站',
        description: '往松山方向（北／東向）',
        shortTurnDestinations: [],
      },
      {
        terminal: '新店站',
        description: '往新店方向（南向；開啟 includeShortTurn 可合併往台電大樓區間車）',
        shortTurnDestinations: ['台電大樓站'],
        shortTurnApplicableStations: G_NORTH_OF_TAIPOWER,
      },
      {
        terminal: '台電大樓站',
        description: '往台電大樓方向（南向區間終點；自動包含往新店全程車）',
        alwaysIncludeDestinations: ['新店站'],
        alwaysIncludeApplicableStations: G_NORTH_OF_TAIPOWER,
        validOriginStations: G_NORTH_OF_TAIPOWER,
        invalidOriginMessage:
          '查詢車站位於「台電大樓站」以南，無南下往台電大樓列車；若欲北上前往台電大樓站，請改查詢 dest=松山。',
        shortTurnDestinations: [],
      },
      {
        terminal: '小碧潭站',
        description: '往小碧潭方向（小碧潭支線）',
        shortTurnDestinations: [],
      },
      {
        terminal: '七張站',
        description: '往七張方向（小碧潭支線折返）',
        shortTurnDestinations: [],
      },
    ],
  },

  O: {
    code: 'O',
    name: '中和新蘆線',
    aliases: ['O', '中和新蘆線', '中和新蘆', '橘線'],
    supported: true,
    shortTurnTerminals: new Set(),
    stations: [
      '南勢角站',
      '景安站',
      '永安市場站',
      '頂溪站',
      '古亭站',
      '東門站',
      '忠孝新生站',
      '松江南京站',
      '行天宮站',
      '中山國小站',
      '民權西路站',
      '大橋頭站',
      '台北橋站',
      '菜寮站',
      '三重站',
      '先嗇宮站',
      '頭前庄站',
      '新莊站',
      '輔大站',
      '丹鳳站',
      '迴龍站',
      '三重國小站',
      '三和國中站',
      '徐匯中學站',
      '三民高中站',
      '蘆洲站',
    ],
    directions: [
      {
        terminal: '南勢角站',
        description: '往南勢角方向（南向）',
        shortTurnDestinations: [],
      },
      {
        terminal: '迴龍站',
        description: '往迴龍方向（北向；於民權西路站～南勢角站區間開啟 includeShortTurn 可合併往蘆洲列車）',
        shortTurnDestinations: ['蘆洲站'],
        shortTurnApplicableStations: O_LINE_SHARED_TRUNK_MERGE_STATIONS,
      },
      {
        terminal: '蘆洲站',
        description: '往蘆洲方向（北向；於民權西路站～南勢角站區間開啟 includeShortTurn 可合併往迴龍列車）',
        shortTurnDestinations: ['迴龍站'],
        shortTurnApplicableStations: O_LINE_SHARED_TRUNK_MERGE_STATIONS,
      },
    ],
  },

  BL: {
    code: 'BL',
    name: '板南線',
    aliases: ['BL', '板南線', '板南', '藍線'],
    supported: true,
    shortTurnTerminals: new Set(['昆陽站', '亞東醫院站']),
    stations: [...BL_WEST_TO_EAST],
    directions: [
      {
        terminal: '南港展覽館站',
        description: '往南港展覽館方向（東向；開啟 includeShortTurn 可合併往昆陽區間車）',
        shortTurnDestinations: ['昆陽站'],
        shortTurnApplicableStations: BL_WEST_OF_KUNYANG,
      },
      {
        terminal: '頂埔站',
        description: '往頂埔方向（西向；開啟 includeShortTurn 可合併往亞東醫院區間車）',
        shortTurnDestinations: ['亞東醫院站'],
        shortTurnApplicableStations: BL_EAST_OF_FAR_EASTERN,
      },
      {
        terminal: '昆陽站',
        description: '往昆陽方向（東向區間終點；自動包含往南港展覽館全程車）',
        alwaysIncludeDestinations: ['南港展覽館站'],
        alwaysIncludeApplicableStations: BL_WEST_OF_KUNYANG,
        validOriginStations: BL_WEST_OF_KUNYANG,
        invalidOriginMessage:
          '查詢車站位於「昆陽站」以東，無東向往昆陽列車；若欲西向前往昆陽站，請改查詢 dest=頂埔 或 dest=亞東醫院。',
        shortTurnDestinations: [],
      },
      {
        terminal: '亞東醫院站',
        description: '往亞東醫院方向（西向區間終點；自動包含往頂埔全程車）',
        alwaysIncludeDestinations: ['頂埔站'],
        alwaysIncludeApplicableStations: BL_EAST_OF_FAR_EASTERN,
        validOriginStations: BL_EAST_OF_FAR_EASTERN,
        invalidOriginMessage:
          '查詢車站位於「亞東醫院站」以西，無西向往亞東醫院列車；若欲東向前往亞東醫院站，請改查詢 dest=南港展覽館 或 dest=昆陽。',
        shortTurnDestinations: [],
      },
    ],
  },

  Y: {
    code: 'Y',
    name: '環狀線',
    aliases: ['Y', '環狀線', '環狀', '黃線'],
    supported: false,
    shortTurnTerminals: new Set(),
    unsupportedReason: '環狀線 (Y) 目前尚未成環營運，本服務暫不開放查詢（僅支援 BR, R, G, O, BL）。',
    stations: [
      '大坪林站',
      '十四張站',
      '秀朗橋站',
      '景平站',
      '景安站',
      '中和站',
      '橋和站',
      '中原站',
      '板新站',
      '板橋站',
      '新埔民生站',
      '頭前庄站',
      '幸福站',
      '新北產業園區站',
    ],
    directions: [],
  },
};

// ============================================================================
// 快速查詢索引（模組載入時預先建立，確保每次 Request 查詢皆為 O(1)）
// ============================================================================

const LINE_STATION_SETS: Readonly<Record<TrtcLineCode, ReadonlySet<string>>> = {
  BR: new Set(TRTC_LINES.BR.stations),
  R: new Set(TRTC_LINES.R.stations),
  G: new Set(TRTC_LINES.G.stations),
  O: new Set(TRTC_LINES.O.stations),
  BL: new Set(TRTC_LINES.BL.stations),
  Y: new Set(TRTC_LINES.Y.stations),
};

const ALIAS_TO_LINE_CODE = new Map<string, TrtcLineCode>();
for (const line of Object.values(TRTC_LINES)) {
  for (const alias of line.aliases) {
    ALIAS_TO_LINE_CODE.set(alias.toUpperCase(), line.code);
  }
}

/** 唯一對應單一路線的終點站索引（不含 BL/BR 共用的「南港展覽館站」） */
const UNIQUE_DESTINATION_TO_LINE: Readonly<Record<string, TrtcLineCode>> = {
  動物園站: 'BR',
  麟光站: 'BR',
  淡水站: 'R',
  北投站: 'R',
  新北投站: 'R',
  '廣慈/奉天宮站': 'R',
  象山站: 'R',
  大安站: 'R',
  松山站: 'G',
  新店站: 'G',
  台電大樓站: 'G',
  小碧潭站: 'G',
  七張站: 'G',
  南勢角站: 'O',
  迴龍站: 'O',
  蘆洲站: 'O',
  頂埔站: 'BL',
  亞東醫院站: 'BL',
  昆陽站: 'BL',
  大坪林站: 'Y',
  新北產業園區站: 'Y',
};

/**
 * 將使用者輸入的 `line` 參數解析為路線定義物件
 */
export function findLineByInput(rawLine: string): TrtcLineDefinition | null {
  const key = rawLine.trim().replace(/臺/g, '台').toUpperCase();
  const code = ALIAS_TO_LINE_CODE.get(key);
  return code ? TRTC_LINES[code] : null;
}

/**
 * 檢查某車站是否屬於指定路線
 */
export function isStationOnLine(lineCode: TrtcLineCode, normalizedStation: string): boolean {
  return LINE_STATION_SETS[lineCode].has(normalizedStation);
}

/**
 * 當呼叫端未傳入 `line` 時，依據 `(station, dest)` 自動推斷唯一所屬路線。
 */
export function inferLinesByStationAndDest(
  normalizedStation: string,
  normalizedDest: string,
): SupportedTrtcLineCode[] {
  const candidates: SupportedTrtcLineCode[] = [];
  const supportedCodes: SupportedTrtcLineCode[] = ['BR', 'R', 'G', 'O', 'BL'];

  for (const code of supportedCodes) {
    const line = TRTC_LINES[code];
    if (!LINE_STATION_SETS[code].has(normalizedStation)) continue;

    const hasDestOrDeprecated =
      line.directions.some((d) => d.terminal === normalizedDest) ||
      Boolean(line.deprecatedTerminals?.[normalizedDest]);

    if (hasDestOrDeprecated) {
      candidates.push(code);
    }
  }

  return candidates;
}

/**
 * 判定一筆列車是否應標記為區間車／非指定支線列車 (`isShortTurn`)：
 * - 在 R / G / BL 線：依據列車實際終點站是否屬於該路線之區間終點站（如北投、大安、台電大樓、昆陽、亞東醫院）判定，
 *   因此即使使用者查詢 `dest=大安`，往「廣慈/奉天宮站」的全程車仍正確標示 `isShortTurn: false`，往「大安站」則為 `isShortTurn: true`
 *   （特例：新北投支線於「新北投站」開往「北投站」之折返車為支線全程車，`isShortTurn: false`）。
 * - 在 O 線共線段：當合併「迴龍站 / 蘆洲站」雙支線時，與使用者指定 `queryDest` 不同的另一支線標記為 `true`。
 */
export function isShortTurnTrain(
  lineCode: SupportedTrtcLineCode,
  queryStation: string,
  queryDest: string,
  trainDestination: string,
): boolean {
  if (lineCode === 'O') {
    return trainDestination !== queryDest;
  }
  if (lineCode === 'R' && queryStation === '新北投站' && trainDestination === '北投站') {
    return false;
  }
  return TRTC_LINES[lineCode].shortTurnTerminals.has(trainDestination);
}

/**
 * 推斷北捷上游單筆原始資料所屬之路線代碼（解決上游無 Line 欄位及「忠孝復興 → 南港展覽館」BL/BR 撞名問題）。
 */
export function inferRecordLineCode(
  station: string,
  destination: string,
  trainNumber: string,
  index: number,
  rawArray: readonly RawTrtcTrackItem[],
): TrtcLineCode | 'UNKNOWN' {
  const byUniqueDest = UNIQUE_DESTINATION_TO_LINE[destination];
  if (byUniqueDest) {
    return byUniqueDest;
  }

  if (destination === '南港展覽館站') {
    const onBL = LINE_STATION_SETS.BL.has(station);
    const onBR = LINE_STATION_SETS.BR.has(station);

    if (onBL && !onBR) return 'BL';
    if (onBR && !onBL) return 'BR';

    if (trainNumber.trim() !== '') {
      return 'BL';
    }

    const prevStation = rawArray[index - 1]
      ? normalizeStationName(rawArray[index - 1]!.StationName)
      : '';
    const nextStation = rawArray[index + 1]
      ? normalizeStationName(rawArray[index + 1]!.StationName)
      : '';

    const neighborOnBROnly =
      (prevStation && LINE_STATION_SETS.BR.has(prevStation) && !LINE_STATION_SETS.BL.has(prevStation)) ||
      (nextStation && LINE_STATION_SETS.BR.has(nextStation) && !LINE_STATION_SETS.BL.has(nextStation));
    if (neighborOnBROnly) return 'BR';

    const neighborOnBLOnly =
      (prevStation && LINE_STATION_SETS.BL.has(prevStation) && !LINE_STATION_SETS.BR.has(prevStation)) ||
      (nextStation && LINE_STATION_SETS.BL.has(nextStation) && !LINE_STATION_SETS.BR.has(nextStation));
    if (neighborOnBLOnly) return 'BL';

    return 'BR';
  }

  return 'UNKNOWN';
}

/**
 * 依據路線、查詢車站、目標終點站與 `includeShortTurn` 計算實際應納入篩選的終點站清單。
 * 已內建：
 * 1. 查詢區間終點站（如 `大安`、`北投`、`台電大樓`、`昆陽`、`亞東醫院`）時，不論 `includeShortTurn` 為何，無條件納入同向全程車終點站。
 * 2. 中和新蘆線 (O) 共線段限制（僅民權西路站～南勢角站合併迴龍／蘆洲）。
 * 3. 清客防呆（自動排除 `DestinationName === 當前查詢車站` 的區間終點車）。
 */
export function resolveEffectiveDestinations(
  _lineDef: TrtcLineDefinition,
  normalizedStation: string,
  directionRule: DirectionRule,
  includeShortTurn: boolean,
): string[] {
  const destinations = new Set<string>([directionRule.terminal]);

  // 1. 無論 flag 為何皆自動納入的同向全程車（如查往大安時自動納入廣慈/奉天宮）
  if (directionRule.alwaysIncludeDestinations && directionRule.alwaysIncludeDestinations.length > 0) {
    const isEligible =
      !directionRule.alwaysIncludeApplicableStations ||
      directionRule.alwaysIncludeApplicableStations.has(normalizedStation);

    if (isEligible) {
      for (const mainDest of directionRule.alwaysIncludeDestinations) {
        destinations.add(mainDest);
      }
    }
  }

  // 2. 當 includeShortTurn=true 時額外納入的同向區間車／共線支線
  if (includeShortTurn && directionRule.shortTurnDestinations.length > 0) {
    const isStationEligible =
      !directionRule.shortTurnApplicableStations ||
      directionRule.shortTurnApplicableStations.has(normalizedStation);

    if (isStationEligible) {
      for (const shortTurnDest of directionRule.shortTurnDestinations) {
        destinations.add(shortTurnDest);
      }
    }
  }

  // 3. 邊界防呆：若某區間車（或終點站）即為當前查詢車站，列車進站後僅清客不載客，予以排除
  destinations.delete(normalizedStation);

  return [...destinations];
}
