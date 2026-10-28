/**
 * @module config/constants
 * @description 服務識別資訊與執行期預設常數設定。
 */

import type { Env, RuntimeConfig } from '../types/env';

/** 服務公開識別資訊（用於根路由 `/`、健康檢查與回應標頭，清楚標示服務身分） */
export const SERVICE_METADATA = {
  name: 'railway-project-trtc',
  title: '台北捷運 (TRTC) 即時到站動態快取與區間車整合代理 API',
  version: '1.2.0',
  system: 'TRTC',
  runtime: 'Cloudflare Workers',
} as const;

/** 系統預設參數值 */
export const DEFAULT_CONFIG = {
  /** 快取最大有效秒數（45 秒後強制重抓，防止列車途中延誤造成長倒數失真） */
  CACHE_MAX_AGE_SECONDS: 45,
  /** 「列車進站 / 即將進站」預設秒數 */
  ARRIVING_DEFAULT_SECONDS: 10,
  /** 最小重抓冷卻秒數（防止收班時段無車或邊界狀態造成同一秒無限重抓） */
  MIN_REFETCH_INTERVAL_SECONDS: 5,
  /** 呼叫北捷 SOAP API 逾時毫秒數 */
  UPSTREAM_TIMEOUT_MS: 8000,
  /** Edge Cache API 底層 TTL（略大於業務層 45 秒，由業務層精準控制失效時機） */
  EDGE_CACHE_TTL_SECONDS: 60,
  /** Cloudflare Cache API 內部專用合成鍵值 URL */
  INTERNAL_SNAPSHOT_CACHE_KEY: 'https://cache.trtc.internal/v1/system-track-snapshot',
} as const;

/**
 * 從 Worker `Env` 安全解析執行期設定，若未設定或格式異常則退回預設值
 */
export function resolveRuntimeConfig(env: Partial<Env>): RuntimeConfig {
  return {
    cacheMaxAgeSeconds: parsePositiveInt(
      env.CACHE_MAX_AGE_SECONDS,
      DEFAULT_CONFIG.CACHE_MAX_AGE_SECONDS,
    ),
    arrivingDefaultSeconds: parsePositiveInt(
      env.ARRIVING_DEFAULT_SECONDS,
      DEFAULT_CONFIG.ARRIVING_DEFAULT_SECONDS,
    ),
    minRefetchIntervalSeconds: parsePositiveInt(
      env.MIN_REFETCH_INTERVAL_SECONDS,
      DEFAULT_CONFIG.MIN_REFETCH_INTERVAL_SECONDS,
    ),
    upstreamTimeoutMs: parsePositiveInt(
      env.UPSTREAM_TIMEOUT_MS,
      DEFAULT_CONFIG.UPSTREAM_TIMEOUT_MS,
    ),
    corsAllowOrigin: env.CORS_ALLOW_ORIGIN?.trim() || '*',
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
