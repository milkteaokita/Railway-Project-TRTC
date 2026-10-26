/**
 * @module cache/snapshot-cache
 * @description 全系統軌道動態快照的雙層快取管理器（L1 Isolate 記憶體 + Single-Flight 併發鎖 + L2 Cloudflare Cache API）。
 *
 * 架構設計目的：
 * 1. 全系統單一顆粒度：北捷 `TrackInfo` 單次呼叫即回傳全系統約 320 筆列車狀態，所有路線／車站查詢共用同一份快照。
 * 2. L1 Isolate 記憶體快取：同一個暖啟動 Worker 實例內零序列化延遲，且在 `*.workers.dev` 或本機測試環境亦可生效。
 * 3. L2 Cloudflare Cache API (`caches.default`)：綁定自訂網域（Custom Domain）時跨同節點實例共享快取，且無 KV 寫入次數限制。
 * 4. Single-Flight 併發合併：當快取失效瞬間湧入多筆請求時，合併為單一上游 Promise，徹底保護北捷 API 呼叫額度。
 */

import { DEFAULT_CONFIG } from '../config/constants';
import type {
  CacheLayerSource,
  SystemTrackSnapshot,
  TrackDataProvider,
} from '../types/arrival';

export interface SnapshotReadResult {
  snapshot: SystemTrackSnapshot | null;
  layer: CacheLayerSource | null;
}

export interface SnapshotCacheOptions {
  /** 自訂快取鍵值 URL（預設使用 `DEFAULT_CONFIG.INTERNAL_SNAPSHOT_CACHE_KEY`） */
  cacheKeyUrl?: string;
  /** Edge Cache 底層保留秒數（預設 60 秒） */
  edgeCacheTtlSeconds?: number;
  /** 可注入時間函式（方便單元測試精準控制時間流逝） */
  nowFn?: () => number;
  /** 可注入 Cache 實例（預設自動取用全域 `caches.default`） */
  edgeCache?: Cache | null;
  /** Cloudflare Worker `ExecutionContext`（用於非同步 `waitUntil` 寫入 Edge Cache） */
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
}

/** 預設全域 L1 狀態（供同一 Worker Isolate 跨請求重用） */
let globalL1Snapshot: SystemTrackSnapshot | null = null;
let globalInflightPromise: Promise<SystemTrackSnapshot> | null = null;

/**
 * 重置模組層級 L1 快取（供單元測試隔離狀態使用）
 */
export function resetGlobalMemoryCache(): void {
  globalL1Snapshot = null;
  globalInflightPromise = null;
}

/**
 * 全系統軌道快照快取協調器
 */
export class SnapshotCacheManager {
  private readonly provider: TrackDataProvider;
  private readonly cacheKeyUrl: string;
  private readonly edgeCacheTtlSeconds: number;
  private readonly nowFn: () => number;
  private readonly edgeCache: Cache | null;
  private readonly executionCtx?: Pick<ExecutionContext, 'waitUntil'>;

  constructor(provider: TrackDataProvider, options: SnapshotCacheOptions = {}) {
    this.provider = provider;
    this.cacheKeyUrl = options.cacheKeyUrl ?? DEFAULT_CONFIG.INTERNAL_SNAPSHOT_CACHE_KEY;
    this.edgeCacheTtlSeconds = options.edgeCacheTtlSeconds ?? DEFAULT_CONFIG.EDGE_CACHE_TTL_SECONDS;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.edgeCache =
      options.edgeCache !== undefined ? options.edgeCache : getDefaultEdgeCache();
    this.executionCtx = options.executionCtx;
  }

  /**
   * 依序嘗試從 L1 記憶體與 L2 Edge Cache 讀取現有快照
   */
  public async getSnapshot(): Promise<SnapshotReadResult> {
    if (globalL1Snapshot && globalL1Snapshot.system === this.provider.system) {
      return { snapshot: globalL1Snapshot, layer: 'L1_MEMORY' };
    }

    if (this.edgeCache) {
      try {
        const cacheReq = new Request(this.cacheKeyUrl, { method: 'GET' });
        const cachedRes = await this.edgeCache.match(cacheReq);
        if (cachedRes) {
          const parsed = (await cachedRes.json()) as SystemTrackSnapshot;
          if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.records)) {
            globalL1Snapshot = parsed;
            return { snapshot: parsed, layer: 'L2_EDGE' };
          }
        }
      } catch {
        // 若執行環境不支援 Cache API，靜默降級使用 L1 與上游重抓
      }
    }

    return { snapshot: null, layer: null };
  }

  /**
   * 強制向北捷上游拉取最新全系統資料並更新 L1 + L2 快取（內建 Single-Flight 併發防護）
   */
  public async refreshFromUpstream(): Promise<SystemTrackSnapshot> {
    if (globalInflightPromise) {
      return globalInflightPromise;
    }

    const fetchTask = (async (): Promise<SystemTrackSnapshot> => {
      const records = await this.provider.fetchNormalizedRecords();
      const freshSnapshot: SystemTrackSnapshot = {
        schemaVersion: 1,
        system: this.provider.system,
        providerId: this.provider.providerId,
        fetchedAtMs: this.nowFn(),
        records,
      };

      globalL1Snapshot = freshSnapshot;
      await this.writeToEdgeCache(freshSnapshot);
      return freshSnapshot;
    })();

    globalInflightPromise = fetchTask;

    try {
      return await fetchTask;
    } finally {
      if (globalInflightPromise === fetchTask) {
        globalInflightPromise = null;
      }
    }
  }

  private async writeToEdgeCache(snapshot: SystemTrackSnapshot): Promise<void> {
    if (!this.edgeCache) return;

    const cacheReq = new Request(this.cacheKeyUrl, { method: 'GET' });
    const cacheRes = new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, s-maxage=${this.edgeCacheTtlSeconds}`,
      },
    });

    const putPromise = this.edgeCache.put(cacheReq, cacheRes).catch(() => {
      // 忽略特定環境（如 workers.dev 子網域）寫入 Cache API 失敗
    });

    if (this.executionCtx) {
      this.executionCtx.waitUntil(putPromise);
    } else {
      await putPromise;
    }
  }
}

function getDefaultEdgeCache(): Cache | null {
  try {
    if (typeof caches !== 'undefined' && 'default' in caches) {
      return (caches as unknown as { default: Cache }).default;
    }
  } catch {
    // Node.js 測試環境無全域 caches
  }
  return null;
}
