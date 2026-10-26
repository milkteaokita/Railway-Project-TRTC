/**
 * @module services/arrival.service
 * @description 台北捷運即時到站查詢核心商業邏輯服務層：
 * 1. 查詢參數驗證、站名正規化與路線推斷。
 * 2. 同向區間車／支線合併規則（含 O 線民權西路～南勢角限制，及清客列車排除防呆）。
 * 3. 快取時間差動態推算 (`remainingSeconds = initialSeconds - elapsedSeconds`)。
 * 4. 智慧快取自動失效重抓判定（Cache Miss / Max Age / 最近班次 <= 0 秒或無車 + 最小重抓冷卻保護）。
 */

import type { SnapshotCacheManager } from '../cache/snapshot-cache';
import {
  TRTC_LINES,
  findLineByInput,
  inferLinesByStationAndDest,
  isShortTurnTrain,
  isStationOnLine,
  resolveEffectiveDestinations,
  type TrtcLineDefinition,
} from '../config/trtc-network';
import type {
  ArrivalApiResponse,
  ArrivalTrainDto,
  CacheLayerSource,
  CacheResolutionStatus,
  SupportedTrtcLineCode,
  SystemTrackSnapshot,
  ValidatedArrivalQuery,
} from '../types/arrival';
import type { RuntimeConfig } from '../types/env';
import { AppError } from '../utils/http';
import { normalizeStationName, parseBooleanParam } from '../utils/station';

export interface RawArrivalQueryParams {
  line?: string | null;
  station?: string | null;
  dest?: string | null;
  includeShortTurn?: string | null;
}

export interface ArrivalServiceOptions {
  cacheManager: SnapshotCacheManager;
  config: RuntimeConfig;
  nowFn?: () => number;
}

interface ProjectedTrain extends ArrivalTrainDto {
  /** 未經 0 秒下限裁切前的原始剩餘秒數（用於判定 `remainingSeconds <= 0` 是否觸發重抓） */
  rawRemainingSeconds: number;
}

/**
 * 驗證並正規化客戶端傳入的 Query Parameters
 */
export function validateArrivalQuery(params: RawArrivalQueryParams): ValidatedArrivalQuery {
  const rawStation = params.station?.trim() ?? '';
  const rawDest = params.dest?.trim() ?? '';
  const rawLine = params.line?.trim() ?? '';

  if (!rawStation) {
    throw new AppError(400, 'MISSING_STATION', '請提供查詢車站參數 `station`（例如：station=大安）');
  }
  if (!rawDest) {
    throw new AppError(400, 'MISSING_DEST', '請提供目標終點站參數 `dest`（例如：dest=淡水）');
  }

  const includeShortTurn = parseBooleanParam(params.includeShortTurn ?? null, false);
  if (includeShortTurn === null) {
    throw new AppError(
      400,
      'INVALID_INCLUDE_SHORT_TURN',
      '參數 `includeShortTurn` 格式無效，請傳入 `true` 或 `false`',
    );
  }

  const station = normalizeStationName(rawStation);
  const dest = normalizeStationName(rawDest);

  // 解析或自動推斷路線
  let lineDef: TrtcLineDefinition;
  if (rawLine) {
    const matched = findLineByInput(rawLine);
    if (!matched) {
      throw new AppError(
        400,
        'UNKNOWN_LINE',
        `無法識別路線「${rawLine}」，支援路線代碼：BR (文湖線)、R (淡水信義線)、G (松山新店線)、O (中和新蘆線)、BL (板南線)`,
      );
    }
    if (!matched.supported) {
      throw new AppError(
        400,
        'UNSUPPORTED_LINE',
        matched.unsupportedReason ?? `路線「${matched.name} (${matched.code})」目前暫不支援查詢`,
      );
    }
    lineDef = matched;
  } else {
    const inferred = inferLinesByStationAndDest(station, dest);
    if (inferred.length > 1) {
      throw new AppError(
        400,
        'AMBIGUOUS_LINE',
        `車站「${station}」往「${dest}」同時存在於多條路線（${inferred.join(', ')}），請明確傳入 \`line\` 參數區分（例如 line=BL 或 line=BR）`,
      );
    }
    if (inferred.length === 0) {
      // 檢查是否誤查環狀線
      if (isStationOnLine('Y', station) && (dest === '大坪林站' || dest === '新北產業園區站')) {
        throw new AppError(
          400,
          'UNSUPPORTED_LINE',
          TRTC_LINES.Y.unsupportedReason!,
        );
      }
      throw new AppError(
        400,
        'INVALID_STATION_OR_DEST',
        `找不到同時包含車站「${station}」與終點方向「${dest}」的支援路線，請確認站名或指定 \`line\` 參數`,
      );
    }
    lineDef = TRTC_LINES[inferred[0]!];
  }

  // 驗證車站確實位於該路線上
  if (!isStationOnLine(lineDef.code, station)) {
    throw new AppError(
      400,
      'STATION_NOT_ON_LINE',
      `車站「${station}」不屬於${lineDef.name} (${lineDef.code})`,
    );
  }

  // 檢查已停用之舊終點站（如淡水信義線「象山站」已延伸至「廣慈/奉天宮站」）
  const deprecatedMessage = lineDef.deprecatedTerminals?.[dest];
  if (deprecatedMessage) {
    throw new AppError(400, 'DEPRECATED_TERMINAL', deprecatedMessage);
  }

  // 尋找目標方向規則
  const directionRule = lineDef.directions.find((d) => d.terminal === dest);
  if (!directionRule) {
    const validTerminals = lineDef.directions.map((d) => d.terminal).join('、');
    throw new AppError(
      400,
      'INVALID_DESTINATION',
      `「${dest}」不是${lineDef.name} (${lineDef.code}) 支援的目標終點站。可用終點站：${validTerminals}`,
    );
  }

  // 防呆：若查詢車站本身即為請求的主終點站，進站列車僅清客不載客
  if (station === dest) {
    throw new AppError(
      400,
      'STATION_EQUALS_DESTINATION',
      `查詢車站與目標終點站相同（「${station}」），終點進站列車僅清客不載客`,
    );
  }

  // 防呆：若查詢區間終點站，但所在車站已超過該區間終點站（下游車站），避免誤導搭乘反方向
  if (directionRule.validOriginStations && !directionRule.validOriginStations.has(station)) {
    throw new AppError(
      400,
      'INVALID_ORIGIN_FOR_SHORT_TURN',
      directionRule.invalidOriginMessage ??
        `車站「${station}」已超過區間終點站「${dest}」，無此方向列車停靠`,
    );
  }

  const effectiveDestinations = resolveEffectiveDestinations(
    lineDef,
    station,
    directionRule,
    includeShortTurn,
  );

  return {
    line: lineDef.code as SupportedTrtcLineCode,
    lineName: lineDef.name,
    station,
    dest,
    includeShortTurn,
    effectiveDestinations,
  };
}

/**
 * 即時到站查詢與動態快取協調服務
 */
export class ArrivalService {
  private readonly cacheManager: SnapshotCacheManager;
  private readonly config: RuntimeConfig;
  private readonly nowFn: () => number;

  constructor(options: ArrivalServiceOptions) {
    this.cacheManager = options.cacheManager;
    this.config = options.config;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /**
   * 執行即時到站查詢（含快取命中評估、過期自動重抓與動態秒數推算）
   */
  public async queryArrivals(rawParams: RawArrivalQueryParams): Promise<ArrivalApiResponse> {
    const query = validateArrivalQuery(rawParams);
    const { snapshot: cachedSnapshot, layer: cachedLayer } = await this.cacheManager.getSnapshot();

    let activeSnapshot: SystemTrackSnapshot;
    let cacheHit = false;
    let status: CacheResolutionStatus;
    let layer: CacheLayerSource;

    if (!cachedSnapshot || !cachedLayer) {
      // 條件 1：Cache Miss
      activeSnapshot = await this.cacheManager.refreshFromUpstream();
      status = 'CACHE_MISS';
      layer = 'UPSTREAM';
    } else {
      const nowMs = this.nowFn();
      const elapsedSeconds = computeElapsedSeconds(nowMs, cachedSnapshot.fetchedAtMs);

      if (elapsedSeconds >= this.config.cacheMaxAgeSeconds) {
        // 條件 3：超過最大信賴時間（預設 45 秒），主動重抓避免途中延誤失真
        activeSnapshot = await this.cacheManager.refreshFromUpstream();
        status = 'MAX_AGE_EXPIRED';
        layer = 'UPSTREAM';
      } else {
        const projected = projectTrainsFromSnapshot(cachedSnapshot, query, elapsedSeconds);
        const hasNoTrains = projected.length === 0;
        const nearestArrivedOrDeparted =
          projected.length > 0 && projected[0]!.rawRemainingSeconds <= 0;

        const cooldownPassed = elapsedSeconds >= this.config.minRefetchIntervalSeconds;

        if ((hasNoTrains || nearestArrivedOrDeparted) && cooldownPassed) {
          // 條件 2：最近一班車推算剩餘秒數 <= 0 或該方向目前無車（且已過最小重抓冷卻期）
          activeSnapshot = await this.cacheManager.refreshFromUpstream();
          status = hasNoTrains ? 'NO_TRAINS_REFRESH' : 'TRAIN_ARRIVED_REFRESH';
          layer = 'UPSTREAM';
        } else {
          // 快取有效命中
          activeSnapshot = cachedSnapshot;
          cacheHit = true;
          status = 'HIT';
          layer = cachedLayer;
        }
      }
    }

    const finalElapsedSeconds = computeElapsedSeconds(this.nowFn(), activeSnapshot.fetchedAtMs);
    const finalProjected = projectTrainsFromSnapshot(activeSnapshot, query, finalElapsedSeconds);
    const trains: ArrivalTrainDto[] = finalProjected.map(
      ({ rawRemainingSeconds: _raw, ...dto }) => dto,
    );

    return {
      ok: true,
      system: 'TRTC',
      query,
      cache: {
        hit: cacheHit,
        status,
        layer,
        fetchedAt: new Date(activeSnapshot.fetchedAtMs).toISOString(),
        elapsedSeconds: finalElapsedSeconds,
      },
      trains,
    };
  }
}

function computeElapsedSeconds(nowMs: number, fetchedAtMs: number): number {
  return Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000));
}

/**
 * 從全系統快照篩選目標路線、車站與有效終點站集合，推算剩餘秒數並由小到大排序
 */
function projectTrainsFromSnapshot(
  snapshot: SystemTrackSnapshot,
  query: ValidatedArrivalQuery,
  elapsedSeconds: number,
): ProjectedTrain[] {
  const allowedDestSet = new Set(query.effectiveDestinations);
  const matched: ProjectedTrain[] = [];

  for (const record of snapshot.records) {
    if (record.lineCode !== query.line) continue;
    if (record.station !== query.station) continue;
    if (record.destination === query.station) continue;
    if (!allowedDestSet.has(record.destination)) continue;

    const rawRemainingSeconds = record.initialSeconds - elapsedSeconds;
    const remainingSeconds = Math.max(0, rawRemainingSeconds);

    matched.push({
      trainNumber: record.trainNumber,
      lineCode: query.line,
      lineName: query.lineName,
      destination: record.destination,
      isShortTurn: isShortTurnTrain(query.line, query.station, query.dest, record.destination),
      rawCountDown: record.rawCountDown,
      initialSeconds: record.initialSeconds,
      remainingSeconds,
      sourceTime: record.sourceTime,
      rawRemainingSeconds,
    });
  }

  // 依剩餘秒數由小到大排序；若秒數相同，主線全程車（isShortTurn = false）優先排列在前
  matched.sort((a, b) => {
    if (a.rawRemainingSeconds !== b.rawRemainingSeconds) {
      return a.rawRemainingSeconds - b.rawRemainingSeconds;
    }
    if (a.isShortTurn !== b.isShortTurn) {
      return a.isShortTurn ? 1 : -1;
    }
    return a.trainNumber.localeCompare(b.trainNumber);
  });

  return matched;
}
