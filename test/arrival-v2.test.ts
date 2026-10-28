import { beforeEach, describe, expect, it } from 'vitest';
import { SnapshotCacheManager, resetGlobalMemoryCache } from '../src/cache/snapshot-cache';
import { resolveRuntimeConfig } from '../src/config/constants';
import { normalizeDirectionInput } from '../src/config/trtc-network-v2';
import { normalizeTrtcTrackItems } from '../src/providers/trtc-soap.provider';
import { dispatchRequest } from '../src/routes/router';
import { ArrivalService } from '../src/services/arrival.service';
import { ArrivalV2Service, validateV2ArrivalQuery } from '../src/services/arrival-v2.service';
import type { RawTrtcTrackItem, TrackDataProvider } from '../src/types/arrival';
import type { V2LinesApiResponse } from '../src/types/arrival-v2';
import { AppError } from '../src/utils/http';

const MOCK_V2_RAW_ITEMS: RawTrtcTrackItem[] = [
  // G 松山新店線（含小碧潭支線）
  { TrainNumber: '301', StationName: '古亭站', DestinationName: '新店站', CountDown: '03:00', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '311', StationName: '古亭站', DestinationName: '台電大樓站', CountDown: '01:10', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '302', StationName: '古亭站', DestinationName: '松山站', CountDown: '02:00', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '305', StationName: '七張站', DestinationName: '新店站', CountDown: '01:45', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '', StationName: '七張站', DestinationName: '小碧潭站', CountDown: '04:20', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '306', StationName: '七張站', DestinationName: '松山站', CountDown: '02:30', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '', StationName: '小碧潭站', DestinationName: '七張站', CountDown: '03:15', NowDateTime: '2026-10-28 21:45:00' },

  // R 淡水信義線（含新北投支線）
  { TrainNumber: '101', StationName: '台北車站', DestinationName: '淡水站', CountDown: '04:00', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '131', StationName: '台北車站', DestinationName: '北投站', CountDown: '01:30', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '105', StationName: '台北車站', DestinationName: '廣慈/奉天宮站', CountDown: '05:00', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '133', StationName: '台北車站', DestinationName: '大安站', CountDown: '02:10', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '114', StationName: '北投站', DestinationName: '淡水站', CountDown: '03:58', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '139', StationName: '北投站', DestinationName: '北投站', CountDown: '列車進站', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '', StationName: '北投站', DestinationName: '新北投站', CountDown: '06:10', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '', StationName: '新北投站', DestinationName: '北投站', CountDown: '04:10', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '108', StationName: '竹圍站', DestinationName: '廣慈/奉天宮站', CountDown: '05:30', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '142', StationName: '竹圍站', DestinationName: '北投站', CountDown: '02:00', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '133', StationName: '大安站', DestinationName: '大安站', CountDown: '列車進站', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '105', StationName: '大安站', DestinationName: '廣慈/奉天宮站', CountDown: '03:20', NowDateTime: '2026-10-28 21:45:00' },

  // O 中和新蘆線（共線段含大橋頭站、新莊分線段、蘆洲分線段）
  { TrainNumber: '405', StationName: '大橋頭站', DestinationName: '迴龍站', CountDown: '04:30', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '436', StationName: '大橋頭站', DestinationName: '蘆洲站', CountDown: '01:50', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '405', StationName: '台北橋站', DestinationName: '迴龍站', CountDown: '06:00', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '436', StationName: '三重國小站', DestinationName: '蘆洲站', CountDown: '03:20', NowDateTime: '2026-10-28 21:45:00' },

  // BR & BL（忠孝復興站撞名測試）
  { TrainNumber: '', StationName: '南京復興站', DestinationName: '南港展覽館站', CountDown: '03:00', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '', StationName: '忠孝復興站', DestinationName: '南港展覽館站', CountDown: '01:40', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '', StationName: '大安站', DestinationName: '南港展覽館站', CountDown: '列車進站', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '205', StationName: '忠孝復興站', DestinationName: '南港展覽館站', CountDown: '02:30', NowDateTime: '2026-10-28 21:45:00' },
  { TrainNumber: '219', StationName: '忠孝復興站', DestinationName: '昆陽站', CountDown: '00:50', NowDateTime: '2026-10-28 21:45:00' },
];

describe('API v2 — Direction-Based Arrivals & Lines Metadata', () => {
  let v2Service: ArrivalV2Service;
  let v1Service: ArrivalService;
  let upstreamCalls = 0;

  beforeEach(() => {
    resetGlobalMemoryCache();
    upstreamCalls = 0;
    const provider: TrackDataProvider = {
      providerId: 'mock-trtc-v2',
      system: 'TRTC',
      fetchNormalizedRecords: async () => {
        upstreamCalls++;
        return normalizeTrtcTrackItems(MOCK_V2_RAW_ITEMS, 10);
      },
    };
    const cacheManager = new SnapshotCacheManager(provider, {
      edgeCache: null,
      nowFn: () => 1_700_000_000_000,
    });
    const config = resolveRuntimeConfig({});
    v2Service = new ArrivalV2Service({
      cacheManager,
      config,
      nowFn: () => 1_700_000_000_000,
    });
    v1Service = new ArrivalService({
      cacheManager,
      config,
      nowFn: () => 1_700_000_000_000,
    });
  });

  it('normalizes direction input formats (淡水 / 淡水站 / 淡水方向 / 往淡水方向)', () => {
    expect(normalizeDirectionInput('淡水')).toBe('淡水站');
    expect(normalizeDirectionInput('淡水站')).toBe('淡水站');
    expect(normalizeDirectionInput('淡水方向')).toBe('淡水站');
    expect(normalizeDirectionInput('往淡水')).toBe('淡水站');
    expect(normalizeDirectionInput('往廣慈/奉天宮方向')).toBe('廣慈/奉天宮站');
  });

  it('serves GET /api/v2/lines with accurate per-station available directions', async () => {
    const res = await dispatchRequest(
      new Request('https://trtc.example.com/api/v2/lines'),
      {
        TRTC_API_URL: 'https://example.com/TrackInfo.asmx',
        TRTC_API_USERNAME: 'u',
        TRTC_API_PASSWORD: 'p',
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as V2LinesApiResponse;
    expect(body.apiVersion).toBe('v2');

    const gLine = body.lines.find((l) => l.code === 'G')!;
    expect(gLine.directions.map((d) => d.direction)).toEqual([
      '松山站',
      '新店站',
      '小碧潭站',
      '七張站',
    ]);
    expect(gLine.stations.find((s) => s.station === '七張站')?.directions).toEqual([
      '松山站',
      '新店站',
      '小碧潭站',
    ]);
    expect(gLine.stations.find((s) => s.station === '小碧潭站')?.directions).toEqual([
      '七張站',
    ]);

    const rLine = body.lines.find((l) => l.code === 'R')!;
    expect(rLine.directions.map((d) => d.direction)).toEqual(['淡水站', '廣慈/奉天宮站']);
    expect(rLine.stations.find((s) => s.station === '新北投站')?.directions).toEqual([
      '廣慈/奉天宮站',
    ]);

    const oLine = body.lines.find((l) => l.code === 'O')!;
    expect(oLine.stations.find((s) => s.station === '大橋頭站')?.directions).toEqual([
      '迴龍站',
      '蘆洲站',
      '南勢角站',
    ]);
    expect(oLine.stations.find((s) => s.station === '輔大站')?.directions).toEqual([
      '迴龍站',
      '南勢角站',
    ]);
  });

  it('handles G line (松山新店線 + 小碧潭支線) directions without any flag', async () => {
    // 古亭往新店方向：自動回傳往台電大樓 (70s) + 往新店 (180s)
    const gutingSouth = await v2Service.queryArrivals({
      line: 'G',
      station: '古亭',
      direction: '新店方向',
    });
    expect(gutingSouth.trains.map((t) => t.destination)).toEqual(['台電大樓站', '新店站']);

    // 古亭往松山方向：僅往松山站
    const gutingNorth = await v2Service.queryArrivals({
      line: 'G',
      station: '古亭',
      direction: '松山',
    });
    expect(gutingNorth.trains.map((t) => t.destination)).toEqual(['松山站']);

    // 七張站提供往新店與往小碧潭
    const qizhangToXindian = await v2Service.queryArrivals({
      line: 'G',
      station: '七張',
      direction: '新店',
    });
    expect(qizhangToXindian.trains.map((t) => t.destination)).toEqual(['新店站']);

    const qizhangToXiaobitan = await v2Service.queryArrivals({
      line: 'G',
      station: '七張',
      direction: '小碧潭',
    });
    expect(qizhangToXiaobitan.trains.map((t) => t.destination)).toEqual(['小碧潭站']);

    // 小碧潭站僅提供往七張方向；若查往松山應回傳 400
    const xiaobitanToQizhang = await v2Service.queryArrivals({
      line: 'G',
      station: '小碧潭',
      direction: '七張',
    });
    expect(xiaobitanToQizhang.trains.map((t) => t.destination)).toEqual(['七張站']);

    expect(() =>
      validateV2ArrivalQuery({ line: 'G', station: '小碧潭', direction: '松山' }),
    ).toThrowError(AppError);
  });

  it('handles R line (淡水信義線 + 新北投支線) directions accurately across segments', async () => {
    // 台北車站往淡水方向：含往北投、往淡水（絕不混入南下班次）
    const taipeiNorth = await v2Service.queryArrivals({
      line: 'R',
      station: '台北車站',
      direction: '淡水',
    });
    expect(taipeiNorth.trains.map((t) => t.destination)).toEqual(['北投站', '淡水站']);

    // 台北車站往廣慈/奉天宮方向：含往大安、往廣慈/奉天宮（絕不混入北上往北投班次！）
    const taipeiSouth = await v2Service.queryArrivals({
      line: 'R',
      station: '台北車站',
      direction: '廣慈/奉天宮',
    });
    expect(taipeiSouth.trains.map((t) => t.destination)).toEqual(['大安站', '廣慈/奉天宮站']);

    // 北投站往淡水方向：含往淡水與往新北投支線，並排除終點為北投站的清客車
    const beitouNorth = await v2Service.queryArrivals({
      line: 'R',
      station: '北投',
      direction: '淡水',
    });
    expect(beitouNorth.trains.map((t) => t.destination)).toEqual(['淡水站', '新北投站']);

    // 新北投站往廣慈/奉天宮方向：回傳折返往北投站列車
    const xinbeitouInbound = await v2Service.queryArrivals({
      line: 'R',
      station: '新北投',
      direction: '廣慈/奉天宮',
    });
    expect(xinbeitouInbound.trains.map((t) => t.destination)).toEqual(['北投站']);
    expect(xinbeitouInbound.trains[0]?.isShortTurn).toBe(false);

    // 竹圍站（北投以北）往廣慈/奉天宮方向：回傳往北投（回機廠）與往廣慈/奉天宮列車
    const zhuweiSouth = await v2Service.queryArrivals({
      line: 'R',
      station: '竹圍',
      direction: '廣慈/奉天宮',
    });
    expect(zhuweiSouth.trains.map((t) => t.destination)).toEqual(['北投站', '廣慈/奉天宮站']);

    // 大安站往廣慈/奉天宮方向：自動排除往大安清客車
    const daanSouth = await v2Service.queryArrivals({
      line: 'R',
      station: '大安',
      direction: '廣慈/奉天宮',
    });
    expect(daanSouth.trains.map((t) => t.destination)).toEqual(['廣慈/奉天宮站']);
  });

  it('handles O line (中和新蘆線) returning all northbound trains at 大橋頭 and trunk, while isolating branches', async () => {
    // 大橋頭站查往迴龍或往蘆洲，皆回傳全部北上列車（蘆洲 + 迴龍）
    const daqiaotouHuilong = await v2Service.queryArrivals({
      line: 'O',
      station: '大橋頭',
      direction: '迴龍',
    });
    expect(daqiaotouHuilong.trains.map((t) => t.destination)).toEqual(['蘆洲站', '迴龍站']);

    const daqiaotouLuzhou = await v2Service.queryArrivals({
      line: 'O',
      station: '大橋頭',
      direction: '蘆洲',
    });
    expect(daqiaotouLuzhou.trains.map((t) => t.destination)).toEqual(['蘆洲站', '迴龍站']);

    // 分線段（台北橋站）只支援迴龍與南勢角，不支援蘆洲方向
    const taipeiqiao = await v2Service.queryArrivals({
      line: 'O',
      station: '台北橋',
      direction: '迴龍',
    });
    expect(taipeiqiao.trains.map((t) => t.destination)).toEqual(['迴龍站']);

    expect(() =>
      validateV2ArrivalQuery({ line: 'O', station: '台北橋', direction: '蘆洲' }),
    ).toThrowError(AppError);
  });

  it('shares the exact same upstream cache snapshot seamlessly between v1 and v2', async () => {
    const v1Res = await v1Service.queryArrivals({
      line: 'BL',
      station: '忠孝復興',
      dest: '南港展覽館',
      includeShortTurn: 'true',
    });
    expect(v1Res.cache.hit).toBe(false);
    expect(upstreamCalls).toBe(1);

    const v2Res = await v2Service.queryArrivals({
      line: 'BL',
      station: '忠孝復興',
      direction: '南港展覽館',
    });
    expect(v2Res.cache.hit).toBe(true);
    expect(upstreamCalls).toBe(1);
    expect(v2Res.trains.map((t) => t.destination)).toEqual(['昆陽站', '南港展覽館站']);
  });
});
