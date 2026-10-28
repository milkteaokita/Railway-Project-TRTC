/**
 * @module types/arrival-v2
 * @description API v2 專屬型別定義（以「路線行駛方向」為核心，移除 `includeShortTurn` Flag，直接回傳該方向所有列車）。
 *
 * 註：v1 型別（`src/types/arrival.ts`）維持獨立不動，以確保向下相容並利於未來舊版下線清理。
 */

import type {
  ArrivalTrainDto,
  CacheLayerSource,
  CacheResolutionStatus,
  SupportedTrtcLineCode,
  TransitSystemCode,
  TrtcLineCode,
} from './arrival';

/**
 * `/api/v2/lines` 中單一方向的公開說明結構
 */
export interface V2DirectionSummaryDto {
  /** 方向標準識別值（帶「站」字尾，如 `"淡水站"`、`"新店站"`、`"小碧潭站"`、`"七張站"`） */
  direction: string;
  /** 方向顯示名稱（如 `"淡水方向"`、`"廣慈/奉天宮方向"`、`"小碧潭方向"`） */
  label: string;
  /** 說明文字 */
  description: string;
  /** 此方向可能出現的列車終點站集合（如淡水方向包含 `["淡水站", "北投站", "新北投站"]`） */
  possibleDestinations: readonly string[];
}

/**
 * `/api/v2/lines` 中單一車站及其可選行駛方向清單
 */
export interface V2StationDirectionsDto {
  /** 車站標準名稱（如 `"七張站"`、`"小碧潭站"`） */
  station: string;
  /** 該車站實際提供查詢的方向清單（如七張站為 `["松山站", "新店站", "小碧潭站"]`，小碧潭站為 `["七張站"]`） */
  directions: readonly string[];
}

/**
 * `/api/v2/lines` 單一路線完整元資料結構
 */
export interface V2LineMetadataDto {
  code: TrtcLineCode;
  name: string;
  aliases: readonly string[];
  supported: boolean;
  unsupportedReason?: string;
  stationCount: number;
  directions: readonly V2DirectionSummaryDto[];
  stations: readonly V2StationDirectionsDto[];
}

/**
 * `GET /api/v2/lines` 回應結構
 */
export interface V2LinesApiResponse {
  ok: true;
  apiVersion: 'v2';
  system: TransitSystemCode;
  lines: readonly V2LineMetadataDto[];
}

/**
 * 經驗證與正規化後的 v2 到站查詢參數（無 `includeShortTurn` Flag）
 */
export interface ValidatedV2ArrivalQuery {
  line: SupportedTrtcLineCode;
  lineName: string;
  station: string;
  /** 正規化方向代碼（如 `"淡水站"`） */
  direction: string;
  /** 方向顯示文字（如 `"淡水方向"`） */
  directionLabel: string;
  /** 依該站所在區段實際納入匹配的列車終點站清單 */
  matchedDestinations: readonly string[];
}

/**
 * `GET /api/v2/arrivals` 標準成功回應結構
 */
export interface V2ArrivalApiResponse {
  ok: true;
  apiVersion: 'v2';
  system: TransitSystemCode;
  query: ValidatedV2ArrivalQuery;
  cache: {
    hit: boolean;
    status: CacheResolutionStatus;
    layer: CacheLayerSource;
    fetchedAt: string;
    elapsedSeconds: number;
  };
  trains: ArrivalTrainDto[];
}
