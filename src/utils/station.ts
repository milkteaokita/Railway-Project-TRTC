/**
 * @module utils/station
 * @description 台北捷運車站名稱正規化、布林參數解析與倒數時間字串轉換工具。
 */

/** 常見車站簡稱／俗稱對應表（統一轉為北捷官方 API 使用的標準名稱） */
const STATION_ALIASES: Readonly<Record<string, string>> = {
  台北: '台北車站',
  北車: '台北車站',
  台北車: '台北車站',
  台北101: '台北101/世貿站',
  世貿: '台北101/世貿站',
  廣慈: '廣慈/奉天宮站',
  奉天宮: '廣慈/奉天宮站',
  小巨蛋: '台北小巨蛋站',
};

/**
 * 將使用者輸入或上游回傳的車站名稱正規化為北捷標準「帶『站』字尾」且統一使用「台」字的格式。
 *
 * 範例：
 * - `"大安"` -> `"大安站"`
 * - `"大安站"` -> `"大安站"`
 * - `"台北車站"` -> `"台北車站"`（避免誤砍「站」字變成 `"台北車"`，或誤補成 `"台北車站站"`）
 * - `"臺北車站"` / `"北車"` -> `"台北車站"`
 * - `"臺電大樓"` -> `"台電大樓站"`
 */
export function normalizeStationName(rawName: string): string {
  const cleaned = rawName.trim().replace(/臺/g, '台');
  if (!cleaned) return '';

  const aliasMatched = STATION_ALIASES[cleaned];
  if (aliasMatched) {
    return aliasMatched;
  }

  // 若有人傳入去掉「站」後的別名（例如「廣慈/奉天宮」），直接補上「站」
  return cleaned.endsWith('站') ? cleaned : `${cleaned}站`;
}

/**
 * 解析北捷上游 `CountDown` 倒數字串為初始秒數 (`initialSeconds`)。
 *
 * 規則：
 * 1. `"MM:SS"` 格式（如 `"02:15"`）：轉換為總秒數（`135` 秒）；若出現 `"00:00"` 視為即將進站以防快取立即失效迴圈。
 * 2. 包含 `"進站"` 字樣（如 `"列車進站"`、`"即將進站"`）：賦予 `arrivingDefaultSeconds`（預設 `10` 秒）。
 * 3. 其他狀態字串（如 `"資料擷取中"`、空字串）：回傳 `null`，代表非有效倒數班次。
 */
export function parseCountDownToSeconds(
  rawCountDown: string,
  arrivingDefaultSeconds: number,
): number | null {
  const text = rawCountDown.trim();
  if (!text) return null;

  if (text.includes('進站')) {
    return arrivingDefaultSeconds;
  }

  const mmssMatch = /^(\d{1,3}):(\d{2})$/.exec(text);
  if (mmssMatch) {
    const minutes = Number.parseInt(mmssMatch[1]!, 10);
    const seconds = Number.parseInt(mmssMatch[2]!, 10);
    if (seconds >= 60) return null;

    const totalSeconds = minutes * 60 + seconds;
    return totalSeconds === 0 ? arrivingDefaultSeconds : totalSeconds;
  }

  return null;
}

/**
 * 解析 Query Parameter 中的布林值（支援 `true`, `1`, `yes`, `false`, `0`, `no`）。
 * 未提供時回傳 `defaultValue`；格式不合法時回傳 `null` 供呼叫端回報 400 錯誤。
 */
export function parseBooleanParam(
  raw: string | null,
  defaultValue = false,
): boolean | null {
  if (raw === null || raw.trim() === '') {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return null;
}
