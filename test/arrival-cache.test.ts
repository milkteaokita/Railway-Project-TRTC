import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotCacheManager, resetGlobalMemoryCache } from '../src/cache/snapshot-cache';
import { resolveRuntimeConfig } from '../src/config/constants';
import { normalizeTrtcTrackItems } from '../src/providers/trtc-soap.provider';
import { dispatchRequest } from '../src/routes/router';
import { ArrivalService } from '../src/services/arrival.service';
import type { RawTrtcTrackItem, TrackDataProvider } from '../src/types/arrival';

describe('Dynamic Countdown & Cache Invalidation Lifecycle', () => {
  let currentNowMs = 1_700_000_000_000;
  let upstreamPayload: RawTrtcTrackItem[] = [];
  let upstreamCallCount = 0;

  beforeEach(() => {
    resetGlobalMemoryCache();
    currentNowMs = 1_700_000_000_000;
    upstreamCallCount = 0;
    upstreamPayload = [
      {
        TrainNumber: '121',
        StationName: '中山站',
        DestinationName: '淡水站',
        CountDown: '列車進站', // 10s
        NowDateTime: '2026-10-26 20:45:50',
      },
      {
        TrainNumber: '135',
        StationName: '台北車站',
        DestinationName: '淡水站',
        CountDown: '02:00', // 120s
        NowDateTime: '2026-10-26 20:45:50',
      },
    ];
  });

  function createService() {
    const provider: TrackDataProvider = {
      providerId: 'mock-upstream',
      system: 'TRTC',
      fetchNormalizedRecords: vi.fn(async () => {
        upstreamCallCount++;
        return normalizeTrtcTrackItems(upstreamPayload, 10);
      }),
    };

    const cacheManager = new SnapshotCacheManager(provider, {
      edgeCache: null,
      nowFn: () => currentNowMs,
    });

    return new ArrivalService({
      cacheManager,
      config: resolveRuntimeConfig({
        CACHE_MAX_AGE_SECONDS: '45',
        ARRIVING_DEFAULT_SECONDS: '10',
        MIN_REFETCH_INTERVAL_SECONDS: '5',
      }),
      nowFn: () => currentNowMs,
    });
  }

  it('shares system-wide cache across different stations and dynamically deducts elapsed seconds', async () => {
    const service = createService();

    // t = 0s：查詢中山站 -> Cache Miss，呼叫上游第 1 次
    const first = await service.queryArrivals({ line: 'R', station: '中山', dest: '淡水' });
    expect(first.cache.hit).toBe(false);
    expect(first.cache.status).toBe('CACHE_MISS');
    expect(first.trains[0]?.remainingSeconds).toBe(10);
    expect(upstreamCallCount).toBe(1);

    // t = 7s：查詢另一站「台北車站」 -> 共用快取 Hit，剩餘秒數由 120s 推算為 113s
    currentNowMs += 7_000;
    const second = await service.queryArrivals({ line: 'R', station: '台北車站', dest: '淡水' });
    expect(second.cache.hit).toBe(true);
    expect(second.cache.status).toBe('HIT');
    expect(second.cache.elapsedSeconds).toBe(7);
    expect(second.trains[0]?.remainingSeconds).toBe(113);
    expect(upstreamCallCount).toBe(1);
  });

  it('re-fetches when nearest train reaches remainingSeconds <= 0 without infinite loop if still 列車進站', async () => {
    const service = createService();

    // t = 0s：中山站「列車進站」取得初始 10 秒
    await service.queryArrivals({ line: 'R', station: '中山', dest: '淡水' });
    expect(upstreamCallCount).toBe(1);

    // t = 10s：10 - 10 = 0 <= 0，觸發 TRAIN_ARRIVED_REFRESH；上游依然回傳「列車進站」
    currentNowMs += 10_000;
    const refreshed = await service.queryArrivals({ line: 'R', station: '中山', dest: '淡水' });
    expect(upstreamCallCount).toBe(2);
    expect(refreshed.cache.hit).toBe(false);
    expect(refreshed.cache.status).toBe('TRAIN_ARRIVED_REFRESH');
    expect(refreshed.cache.elapsedSeconds).toBe(0);
    expect(refreshed.trains[0]?.remainingSeconds).toBe(10);

    // 同 1 秒內再次查詢：因為新快照剛抓回來 (elapsed = 0, remaining = 10)，直接命中快取不重抓！
    const immediateFollowUp = await service.queryArrivals({ line: 'R', station: '中山', dest: '淡水' });
    expect(upstreamCallCount).toBe(2);
    expect(immediateFollowUp.cache.hit).toBe(true);
    expect(immediateFollowUp.trains[0]?.remainingSeconds).toBe(10);
  });

  it('respects MIN_REFETCH_INTERVAL_SECONDS cooldown during midnight off-hours (0 trains)', async () => {
    upstreamPayload = []; // 模擬收班無任何列車
    const service = createService();

    await service.queryArrivals({ line: 'R', station: '大安', dest: '淡水' });
    expect(upstreamCallCount).toBe(1);

    // 2 秒後再查：雖無車，但未滿 5 秒冷卻時間，不打爆上游 API
    currentNowMs += 2_000;
    const withinCooldown = await service.queryArrivals({ line: 'R', station: '大安', dest: '淡水' });
    expect(withinCooldown.cache.hit).toBe(true);
    expect(upstreamCallCount).toBe(1);

    // 滿 5 秒後再查：允許重抓更新
    currentNowMs += 3_000;
    const afterCooldown = await service.queryArrivals({ line: 'R', station: '大安', dest: '淡水' });
    expect(afterCooldown.cache.status).toBe('NO_TRAINS_REFRESH');
    expect(upstreamCallCount).toBe(2);
  });

  it('forces upstream refresh when elapsedSeconds >= CACHE_MAX_AGE_SECONDS (45s) even if remainingSeconds > 0', async () => {
    const service = createService();

    // t = 0s：台北車站列車還有 120 秒
    await service.queryArrivals({ line: 'R', station: '台北車站', dest: '淡水' });
    expect(upstreamCallCount).toBe(1);

    // t = 45s：雖然推算還剩 75 秒 (> 0)，但已達 45 秒最大信賴門檻，強制重抓
    currentNowMs += 45_000;
    const res = await service.queryArrivals({ line: 'R', station: '台北車站', dest: '淡水' });
    expect(res.cache.status).toBe('MAX_AGE_EXPIRED');
    expect(upstreamCallCount).toBe(2);
  });

  it('coalesces concurrent cold-cache requests via Single-Flight lock into 1 upstream call', async () => {
    const provider: TrackDataProvider = {
      providerId: 'slow-upstream',
      system: 'TRTC',
      fetchNormalizedRecords: async () => {
        upstreamCallCount++;
        await new Promise((r) => setTimeout(r, 30));
        return normalizeTrtcTrackItems(upstreamPayload, 10);
      },
    };
    const cacheManager = new SnapshotCacheManager(provider, { edgeCache: null });
    const service = new ArrivalService({
      cacheManager,
      config: resolveRuntimeConfig({}),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.queryArrivals({ line: 'R', station: '台北車站', dest: '淡水' }),
      ),
    );

    expect(upstreamCallCount).toBe(1);
    for (const r of results) {
      expect(r.trains[0]?.destination).toBe('淡水站');
    }
  });
});

describe('HTTP Router Endpoints', () => {
  const mockEnv = {
    TRTC_API_URL: 'https://example.com/TrackInfo.asmx',
    TRTC_API_USERNAME: 'demo_user',
    TRTC_API_PASSWORD: 'demo_password',
  };

  it('serves service identity metadata at GET /', async () => {
    const res = await dispatchRequest(new Request('https://trtc.example.com/'), mockEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: { name: string } };
    expect(body.ok).toBe(true);
    expect(body.service.name).toBe('railway-project-trtc');
  });

  it('serves readiness status at GET /health without exposing credentials', async () => {
    const res = await dispatchRequest(new Request('https://trtc.example.com/health'), mockEnv);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('demo_password');
    expect(raw).not.toContain('example.com/TrackInfo.asmx');
  });

  it('serves supported lines metadata at GET /api/lines', async () => {
    const res = await dispatchRequest(new Request('https://trtc.example.com/api/lines'), mockEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: Array<{ code: string; supported: boolean }> };
    expect(body.lines.find((l) => l.code === 'R')?.supported).toBe(true);
    expect(body.lines.find((l) => l.code === 'Y')?.supported).toBe(false);
  });
});
