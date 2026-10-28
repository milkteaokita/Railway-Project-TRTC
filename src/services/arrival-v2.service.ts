/**
 * @module services/arrival-v2.service
 * @description API v2 台北捷運即時到站查詢核心服務層（方向導向、無 Flag、與 v1 共用底層雙層快取快照）。
 */

import type { SnapshotCacheManager } from '../cache/snapshot-cache';
import {
  TRTC_V2_LINES,
  findV2LineByInput,
  formatDirectionLabel,
  getAvailableV2DirectionsForStation,
  inferV2LinesByStationAndDirection,
  isStationOnV2Line,
  isV2ShortTurnTrain,
  normalizeDirectionInput,
  type V2LineConfig,
} from '../config/trtc-network-v2';
import type {
  ArrivalTrainDto,
  CacheLayerSource,
  CacheResolutionStatus,
  SupportedTrtcLineCode,
  SystemTrackSnapshot,
} from '../types/arrival';
import type {
  V2ArrivalApiResponse,
  ValidatedV2ArrivalQuery,
} from '../types/arrival-v2';
import type { RuntimeConfig } from '../types/env';
import { AppError } from '../utils/http';
import { normalizeStationName } from '../utils/station';

export interface RawV2ArrivalQueryParams {
  line?: string | null;
  station?: string | null;
  /** v2 標準參數名稱（例如 `direction=淡水` 或 `direction=淡水方向`） */
  direction?: string | null;
  /** 向下相容別名：若未帶 `direction` 但帶了 `dest`，亦自動接受解析 */
  dest?: string | null;
}

export interface ArrivalV2ServiceOptions {
  cacheManager: SnapshotCacheManager;
  config: RuntimeConfig;
  nowFn?: () => number;
}

interface ProjectedV2Train extends ArrivalTrainDto {
  rawRemainingSeconds: number;
}

/**
 * 驗證並正規化 API v2 查詢參數
 */
export function validateV2ArrivalQuery(params: RawV2ArrivalQueryParams): ValidatedV2ArrivalQuery {
  const rawStation = params.station?.trim() ?? '';
  const rawDirection = (params.direction?.trim() || params.dest?.trim()) ?? '';
  const rawLine = params.line?.trim() ?? '';

  if (!rawStation) {
    throw new AppError(400, 'MISSING_STATION', '請提供查詢車站參數 `station`（例如：station=大安）');
  }
  if (!rawDirection) {
    throw new AppError(
      400,
      'MISSING_DIRECTION',
      '請提供行駛方向參數 `direction`（例如：direction=淡水 或 direction=新店）',
    );
  }

  const station = normalizeStationName(rawStation);
  const direction = normalizeDirectionInput(rawDirection);

  let lineConfig: V2LineConfig;
  if (rawLine) {
    const matched = findV2LineByInput(rawLine);
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
    lineConfig = matched;
  } else {
    const inferred = inferV2LinesByStationAndDirection(station, direction);
    if (inferred.length > 1) {
      throw new AppError(
        400,
        'AMBIGUOUS_LINE',
        `車站「${station}」往「${formatDirectionLabel(direction)}」同時存在於多條路線（${inferred.join(', ')}），請明確傳入 \`line\` 參數區分（例如 line=BL 或 line=BR）`,
      );
    }
    if (inferred.length === 0) {
      if (
        isStationOnV2Line('Y', station) &&
        (direction === '大坪林站' || direction === '新北產業園區站')
      ) {
        throw new AppError(400, 'UNSUPPORTED_LINE', TRTC_V2_LINES.Y.unsupportedReason!);
      }
      throw new AppError(
        400,
        'INVALID_STATION_OR_DIRECTION',
        `找不到同時包含車站「${station}」與方向「${formatDirectionLabel(direction)}」的支援路線，請確認參數或參考 /api/v2/lines`,
      );
    }
    lineConfig = TRTC_V2_LINES[inferred[0]!];
  }

  if (!isStationOnV2Line(lineConfig.code, station)) {
    throw new AppError(
      400,
      'STATION_NOT_ON_LINE',
      `車站「${station}」不屬於${lineConfig.name} (${lineConfig.code})`,
    );
  }

  const deprecatedMsg = lineConfig.deprecatedDirections?.[direction];
  if (deprecatedMsg) {
    throw new AppError(400, 'DEPRECATED_DIRECTION', deprecatedMsg);
  }

  const isLineDirection = lineConfig.directions.some((d) => d.direction === direction);
  if (!isLineDirection) {
    const validDirs = lineConfig.directions
      .map((d) => `${d.direction}（${d.label}）`)
      .join('、');
    throw new AppError(
      400,
      'INVALID_DIRECTION',
      `「${rawDirection}」不是${lineConfig.name} (${lineConfig.code}) 的有效方向。該路線支援方向：${validDirs}`,
    );
  }

  if (station === direction) {
    throw new AppError(
      400,
      'STATION_EQUALS_DIRECTION',
      `查詢車站「${station}」即為該方向終點站，進站列車僅清客不載客`,
    );
  }

  const matchedDestinations = lineConfig.resolveStationDirectionDestinations(station, direction);
  if (!matchedDestinations || matchedDestinations.length === 0) {
    const stationAvailableDirs = getAvailableV2DirectionsForStation(lineConfig, station);
    throw new AppError(
      400,
      'DIRECTION_NOT_AVAILABLE_AT_STATION',
      `車站「${station}」不提供「${formatDirectionLabel(direction)}」列車。該站可用方向：${stationAvailableDirs.join('、')}`,
      { availableDirections: stationAvailableDirs },
    );
  }

  // 安全防呆：再次確保當前查詢車站不會出現在有效目標終點清單中（排除清客列車）
  const filteredDestinations = matchedDestinations.filter((d) => d !== station);

  return {
    line: lineConfig.code as SupportedTrtcLineCode,
    lineName: lineConfig.name,
    station,
    direction,
    directionLabel: formatDirectionLabel(direction),
    matchedDestinations: filteredDestinations,
  };
}

/**
 * API v2 即時到站查詢服務（與 v1 共享同一份 `SnapshotCacheManager` 全系統快取快照）
 */
export class ArrivalV2Service {
  private readonly cacheManager: SnapshotCacheManager;
  private readonly config: RuntimeConfig;
  private readonly nowFn: () => number;

  constructor(options: ArrivalV2ServiceOptions) {
    this.cacheManager = options.cacheManager;
    this.config = options.config;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public async queryArrivals(rawParams: RawV2ArrivalQueryParams): Promise<V2ArrivalApiResponse> {
    const query = validateV2ArrivalQuery(rawParams);
    const { snapshot: cachedSnapshot, layer: cachedLayer } = await this.cacheManager.getSnapshot();

    let activeSnapshot: SystemTrackSnapshot;
    let cacheHit = false;
    let status: CacheResolutionStatus;
    let layer: CacheLayerSource;

    if (!cachedSnapshot || !cachedLayer) {
      activeSnapshot = await this.cacheManager.refreshFromUpstream();
      status = 'CACHE_MISS';
      layer = 'UPSTREAM';
    } else {
      const nowMs = this.nowFn();
      const elapsedSeconds = computeElapsedSeconds(nowMs, cachedSnapshot.fetchedAtMs);

      if (elapsedSeconds >= this.config.cacheMaxAgeSeconds) {
        activeSnapshot = await this.cacheManager.refreshFromUpstream();
        status = 'MAX_AGE_EXPIRED';
        layer = 'UPSTREAM';
      } else {
        const projected = projectV2TrainsFromSnapshot(cachedSnapshot, query, elapsedSeconds);
        const hasNoTrains = projected.length === 0;
        const nearestArrivedOrDeparted =
          projected.length > 0 && projected[0]!.rawRemainingSeconds <= 0;
        const cooldownPassed = elapsedSeconds >= this.config.minRefetchIntervalSeconds;

        if ((hasNoTrains || nearestArrivedOrDeparted) && cooldownPassed) {
          activeSnapshot = await this.cacheManager.refreshFromUpstream();
          status = hasNoTrains ? 'NO_TRAINS_REFRESH' : 'TRAIN_ARRIVED_REFRESH';
          layer = 'UPSTREAM';
        } else {
          activeSnapshot = cachedSnapshot;
          cacheHit = true;
          status = 'HIT';
          layer = cachedLayer;
        }
      }
    }

    const finalElapsedSeconds = computeElapsedSeconds(this.nowFn(), activeSnapshot.fetchedAtMs);
    const finalProjected = projectV2TrainsFromSnapshot(activeSnapshot, query, finalElapsedSeconds);
    const trains: ArrivalTrainDto[] = finalProjected.map(
      ({ rawRemainingSeconds: _raw, ...dto }) => dto,
    );

    return {
      ok: true,
      apiVersion: 'v2',
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

function projectV2TrainsFromSnapshot(
  snapshot: SystemTrackSnapshot,
  query: ValidatedV2ArrivalQuery,
  elapsedSeconds: number,
): ProjectedV2Train[] {
  const allowedDestSet = new Set(query.matchedDestinations);
  const matched: ProjectedV2Train[] = [];

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
      isShortTurn: isV2ShortTurnTrain(query.line, query.station, record.destination),
      rawCountDown: record.rawCountDown,
      initialSeconds: record.initialSeconds,
      remainingSeconds,
      sourceTime: record.sourceTime,
      rawRemainingSeconds,
    });
  }

  matched.sort((a, b) => {
    if (a.rawRemainingSeconds !== b.rawRemainingSeconds) {
      return a.rawRemainingSeconds - b.rawRemainingSeconds;
    }
    // 同秒數時，終點與查詢方向完全一致的列車優先
    const aExact = a.destination === query.direction;
    const bExact = b.destination === query.direction;
    if (aExact !== bExact) {
      return aExact ? -1 : 1;
    }
    if (a.isShortTurn !== b.isShortTurn) {
      return a.isShortTurn ? 1 : -1;
    }
    return a.trainNumber.localeCompare(b.trainNumber);
  });

  return matched;
}
