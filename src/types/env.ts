/**
 * @module types/env
 * @description Cloudflare Workers 執行環境變數與綁定型別定義。
 *
 * 敏感憑證（TRTC_API_*）：
 * - 本機開發：設定於 `.dev.vars`（已被 `.gitignore` 排除，不會進版控）
 * - 正式環境：透過 `npx wrangler secret put <KEY>` 加密儲存於 Cloudflare Secrets
 *
 * 非機密調校參數：
 * - 設定於 `wrangler.jsonc` 的 `vars` 區塊，未設定時由系統自動套用預設值。
 */

export interface Env {
  /** 台北捷運 TrackInfo SOAP API 完整端點網址（Secret） */
  TRTC_API_URL: string;
  /** 台北捷運 API 認證帳號（Secret） */
  TRTC_API_USERNAME: string;
  /** 台北捷運 API 認證密碼（Secret） */
  TRTC_API_PASSWORD: string;

  /** 快取最大信賴秒數（預設 "45" 秒，超過即主動重新向北捷拉取） */
  CACHE_MAX_AGE_SECONDS?: string;
  /** 「列車進站 / 即將進站」預設賦予的初始倒數秒數（預設 "10" 秒） */
  ARRIVING_DEFAULT_SECONDS?: string;
  /** 最小重抓冷卻秒數（預設 "5" 秒，防止收班無車或狀態邊界造成無限重抓迴圈） */
  MIN_REFETCH_INTERVAL_SECONDS?: string;
  /** 呼叫上游北捷 API 的逾時毫秒數（預設 "8000" ms） */
  UPSTREAM_TIMEOUT_MS?: string;
  /** 允許的 CORS Origin（預設 "*"） */
  CORS_ALLOW_ORIGIN?: string;
}

/**
 * 解析並驗證後的執行期數值設定
 */
export interface RuntimeConfig {
  cacheMaxAgeSeconds: number;
  arrivingDefaultSeconds: number;
  minRefetchIntervalSeconds: number;
  upstreamTimeoutMs: number;
  corsAllowOrigin: string;
}
