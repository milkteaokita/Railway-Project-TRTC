import { beforeEach, describe, expect, it } from 'vitest';
import { SnapshotCacheManager, resetGlobalMemoryCache } from '../src/cache/snapshot-cache';
import { resolveRuntimeConfig } from '../src/config/constants';
import { normalizeTrtcTrackItems } from '../src/providers/trtc-soap.provider';
import { ArrivalService, validateArrivalQuery } from '../src/services/arrival.service';
import type { RawTrtcTrackItem, TrackDataProvider } from '../src/types/arrival';
import { AppError } from '../src/utils/http';

const MOCK_RAW_ITEMS: RawTrtcTrackItem[] = [
  // BR 文湖線（忠孝復興站前後為文湖線車站，且 TrainNumber 為空字串）
  { TrainNumber: '', StationName: '南京復興站', DestinationName: '南港展覽館站', CountDown: '03:00', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '', StationName: '忠孝復興站', DestinationName: '南港展覽館站', CountDown: '01:40', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '', StationName: '大安站', DestinationName: '南港展覽館站', CountDown: '列車進站', NowDateTime: '2026-10-26 20:45:50' },

  // R 淡水信義線（北向：淡水 + 北投區間車；南向：廣慈/奉天宮 + 大安區間車）
  { TrainNumber: '102', StationName: '大安站', DestinationName: '淡水站', CountDown: '04:49', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '', StationName: '大安站', DestinationName: '北投站', CountDown: '01:23', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '105', StationName: '大安站', DestinationName: '廣慈/奉天宮站', CountDown: '07:44', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '133', StationName: '大安站', DestinationName: '大安站', CountDown: '列車進站', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '133', StationName: '東門站', DestinationName: '大安站', CountDown: '00:37', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '105', StationName: '東門站', DestinationName: '廣慈/奉天宮站', CountDown: '05:10', NowDateTime: '2026-10-26 20:45:50' },

  // O 中和新蘆線（共線段：古亭站、民權西路站；分岔站：大橋頭站）
  { TrainNumber: '405', StationName: '古亭站', DestinationName: '迴龍站', CountDown: '04:00', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '436', StationName: '古亭站', DestinationName: '蘆洲站', CountDown: '01:30', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '405', StationName: '民權西路站', DestinationName: '迴龍站', CountDown: '05:00', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '436', StationName: '民權西路站', DestinationName: '蘆洲站', CountDown: '02:00', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '405', StationName: '大橋頭站', DestinationName: '迴龍站', CountDown: '06:00', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '436', StationName: '大橋頭站', DestinationName: '蘆洲站', CountDown: '03:00', NowDateTime: '2026-10-26 20:45:50' },

  // BL 板南線（忠孝復興站往南港展覽館站帶有 TrainNumber 205 + 昆陽區間車）
  { TrainNumber: '205', StationName: '忠孝復興站', DestinationName: '南港展覽館站', CountDown: '02:30', NowDateTime: '2026-10-26 20:45:50' },
  { TrainNumber: '219', StationName: '忠孝復興站', DestinationName: '昆陽站', CountDown: '00:50', NowDateTime: '2026-10-26 20:45:50' },
];

describe('Direction Mapping, Short-Turn Merging & Line Disambiguation', () => {
  let service: ArrivalService;

  beforeEach(() => {
    resetGlobalMemoryCache();
    const mockProvider: TrackDataProvider = {
      providerId: 'mock-trtc',
      system: 'TRTC',
      fetchNormalizedRecords: async () => normalizeTrtcTrackItems(MOCK_RAW_ITEMS, 10),
    };
    const cacheManager = new SnapshotCacheManager(mockProvider, {
      edgeCache: null,
      nowFn: () => 1_700_000_000_000,
    });
    service = new ArrivalService({
      cacheManager,
      config: resolveRuntimeConfig({}),
      nowFn: () => 1_700_000_000_000,
    });
  });

  it('merges 北投 short-turn and 淡水 main-line trains sorted ascending when includeShortTurn=true', async () => {
    const res = await service.queryArrivals({
      line: 'R',
      station: '大安',
      dest: '淡水',
      includeShortTurn: 'true',
    });

    expect(res.trains).toHaveLength(2);
    expect(res.trains[0]).toMatchObject({
      destination: '北投站',
      isShortTurn: true,
      remainingSeconds: 83,
    });
    expect(res.trains[1]).toMatchObject({
      destination: '淡水站',
      isShortTurn: false,
      remainingSeconds: 289,
    });
  });

  it('filters out 北投 short-turn when includeShortTurn=false', async () => {
    const res = await service.queryArrivals({
      line: 'R',
      station: '大安',
      dest: '淡水',
      includeShortTurn: 'false',
    });

    expect(res.trains).toHaveLength(1);
    expect(res.trains[0]?.destination).toBe('淡水站');
  });

  it('excludes offloading short-turn trains terminating at current station (大安站查往廣慈/奉天宮)', async () => {
    // 在東門站查往廣慈/奉天宮（開啟區間車）應看到往大安站 (37s) 與往廣慈/奉天宮站 (310s)
    const atDongmen = await service.queryArrivals({
      line: 'R',
      station: '東門',
      dest: '廣慈/奉天宮',
      includeShortTurn: 'true',
    });
    expect(atDongmen.trains.map((t) => t.destination)).toEqual(['大安站', '廣慈/奉天宮站']);

    // 在大安站查往廣慈/奉天宮（開啟區間車）必須排除終點為「大安站」的清客列車！
    const atDaan = await service.queryArrivals({
      line: 'R',
      station: '大安',
      dest: '廣慈/奉天宮',
      includeShortTurn: 'true',
    });
    expect(atDaan.trains.map((t) => t.destination)).toEqual(['廣慈/奉天宮站']);
  });

  it('rejects deprecated terminal 象山 on R line with clear guidance', () => {
    expect(() =>
      validateArrivalQuery({
        line: 'R',
        station: '台北車站',
        dest: '象山',
      }),
    ).toThrowError(AppError);

    try {
      validateArrivalQuery({ line: 'R', station: '台北車站', dest: '象山' });
    } catch (err) {
      expect((err as AppError).errorCode).toBe('DEPRECATED_TERMINAL');
      expect((err as AppError).message).toContain('廣慈/奉天宮');
    }
  });

  it('enforces O-line shared trunk rule: merges 迴龍/蘆洲 at 古亭 & 民權西路, but NOT at 大橋頭', async () => {
    const atGuting = await service.queryArrivals({
      line: 'O',
      station: '古亭',
      dest: '迴龍',
      includeShortTurn: 'true',
    });
    expect(atGuting.trains.map((t) => t.destination)).toEqual(['蘆洲站', '迴龍站']);

    const atMinquan = await service.queryArrivals({
      line: 'O',
      station: '民權西路',
      dest: '迴龍',
      includeShortTurn: 'true',
    });
    expect(atMinquan.trains.map((t) => t.destination)).toEqual(['蘆洲站', '迴龍站']);

    // 大橋頭站不支援合併 tag，僅回傳指定之「迴龍站」列車
    const atDaqiaotou = await service.queryArrivals({
      line: 'O',
      station: '大橋頭',
      dest: '迴龍',
      includeShortTurn: 'true',
    });
    expect(atDaqiaotou.query.effectiveDestinations).toEqual(['迴龍站']);
    expect(atDaqiaotou.trains.map((t) => t.destination)).toEqual(['迴龍站']);
  });

  it('accurately separates BL and BR trains to 南港展覽館站 at transfer station 忠孝復興站', async () => {
    const blRes = await service.queryArrivals({
      line: 'BL',
      station: '忠孝復興',
      dest: '南港展覽館',
      includeShortTurn: 'true',
    });
    expect(blRes.trains).toHaveLength(2);
    expect(blRes.trains[0]).toMatchObject({ trainNumber: '219', destination: '昆陽站', remainingSeconds: 50 });
    expect(blRes.trains[1]).toMatchObject({ trainNumber: '205', destination: '南港展覽館站', remainingSeconds: 150 });

    const brRes = await service.queryArrivals({
      line: 'BR',
      station: '忠孝復興',
      dest: '南港展覽館',
      includeShortTurn: 'true',
    });
    expect(brRes.trains).toHaveLength(1);
    expect(brRes.trains[0]).toMatchObject({ trainNumber: '', destination: '南港展覽館站', remainingSeconds: 100 });

    // 未帶 line 參數在忠孝復興查南港展覽館時，應要求明確傳入 line
    expect(() =>
      validateArrivalQuery({
        station: '忠孝復興',
        dest: '南港展覽館',
      }),
    ).toThrowError(AppError);
  });

  it('automatically includes full-line trains regardless of includeShortTurn when querying short-turn terminals (e.g. 台北車站/東門 -> 大安)', async () => {
    // 即使不帶 includeShortTurn（預設 false），查 dest=大安 也應同時給「大安站 + 廣慈/奉天宮站」，且正確標記 isShortTurn
    const withoutFlag = await service.queryArrivals({
      line: 'R',
      station: '東門',
      dest: '大安',
    });
    expect(withoutFlag.query.effectiveDestinations).toEqual(['大安站', '廣慈/奉天宮站']);
    expect(withoutFlag.trains).toEqual([
      expect.objectContaining({
        destination: '大安站',
        isShortTurn: true,
        remainingSeconds: 37,
      }),
      expect.objectContaining({
        destination: '廣慈/奉天宮站',
        isShortTurn: false,
        remainingSeconds: 310,
      }),
    ]);

    // 查 BL 忠孝復興 -> 昆陽（無 flag）也自動納入南港展覽館全程車
    const blKunyang = await service.queryArrivals({
      line: 'BL',
      station: '忠孝復興',
      dest: '昆陽',
      includeShortTurn: 'false',
    });
    expect(blKunyang.query.effectiveDestinations).toEqual(['昆陽站', '南港展覽館站']);
    expect(blKunyang.trains.map((t) => ({ dest: t.destination, isShortTurn: t.isShortTurn }))).toEqual([
      { dest: '昆陽站', isShortTurn: true },
      { dest: '南港展覽館站', isShortTurn: false },
    ]);

    // 其他區間終點（北投、台電大樓、亞東醫院）驗證
    expect(
      validateArrivalQuery({ line: 'R', station: '台北車站', dest: '北投' }).effectiveDestinations,
    ).toEqual(['北投站', '淡水站']);
    expect(
      validateArrivalQuery({ line: 'R', station: '新北投', dest: '北投' }).effectiveDestinations,
    ).toEqual(['北投站']);
    expect(
      validateArrivalQuery({ line: 'G', station: '古亭', dest: '台電大樓' }).effectiveDestinations,
    ).toEqual(['台電大樓站', '新店站']);
    expect(
      validateArrivalQuery({ line: 'BL', station: '台北車站', dest: '亞東醫院' }).effectiveDestinations,
    ).toEqual(['亞東醫院站', '頂埔站']);
  });

  it('prevents wrong-way queries when already past a short-turn terminal (e.g. 信義安和查往大安、關渡查往北投)', () => {
    expect(() =>
      validateArrivalQuery({ line: 'R', station: '信義安和', dest: '大安' }),
    ).toThrowError(AppError);

    expect(() =>
      validateArrivalQuery({ line: 'R', station: '關渡', dest: '北投' }),
    ).toThrowError(AppError);

    expect(() =>
      validateArrivalQuery({ line: 'G', station: '公館', dest: '台電大樓' }),
    ).toThrowError(AppError);
  });

  it('rejects Circular Line (Y) queries as unsupported', () => {
    expect(() =>
      validateArrivalQuery({
        line: 'Y',
        station: '幸福',
        dest: '大坪林',
      }),
    ).toThrowError(AppError);
  });
});
