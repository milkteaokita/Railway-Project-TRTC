/**
 * @module types/arrival
 * @description 台北捷運即時到站代理服務的核心資料結構、上游原始型別、快取快照與回應 DTO 定義。
 * 預留多軌道系統（`TransitSystemCode`）與抽象資料提供者（`TrackDataProvider`）介面以利未來擴充。
 */

/** 軌道運輸系統代碼（目前實作北捷 TRTC，未來可擴充如 TYMC、KRTC、TRA 等） */
export type TransitSystemCode = 'TRTC';

/** 北捷全系統路線代碼（含暫不開放查詢但上游會回傳的環狀線 Y） */
export type TrtcLineCode = 'BR' | 'R' | 'G' | 'O' | 'BL' | 'Y';

/** 目前對外開放支援查詢的北捷路線代碼（環狀線尚未成環營運，暫不開放） */
export type SupportedTrtcLineCode = 'BR' | 'R' | 'G' | 'O' | 'BL';

/**
 * 北捷上游 `getTrackInfo` SOAP API 內層 JSON 陣列的單筆原始結構
 */
export interface RawTrtcTrackItem {
  /** 車次編號（文湖線、支線或端點待發車班次可能為空字串 `""`） */
  TrainNumber: string;
  /** 車站名稱（北捷標準格式皆以「站」結尾，如 `"大安站"`、`"台北車站"`） */
  StationName: string;
  /** 列車終點站名稱（如 `"淡水站"`、`"北投站"`、`"廣慈/奉天宮站"`） */
  DestinationName: string;
  /** 倒數時間字串（如 `"02:15"`、`"列車進站"`、`"資料擷取中"`） */
  CountDown: string;
  /** 北捷伺服器資料時間（格式 `"YYYY-MM-DD HH:mm:ss"`，UTC+8） */
  NowDateTime: string;
}

/**
 * 清理與正規化後的單筆列車紀錄（儲存於全系統快取快照中）
 */
export interface NormalizedTrainRecord {
  /** 所屬運輸系統代碼 */
  system: TransitSystemCode;
  /** 推斷歸屬之路線代碼（已解決忠孝復興站 BL/BR 往南港展覽館撞名問題） */
  lineCode: TrtcLineCode | 'UNKNOWN';
  /** 路線中文名稱 */
  lineName: string;
  /** 車次編號（無車次時為 `""`） */
  trainNumber: string;
  /** 正規化後之車站名稱（帶「站」字尾） */
  station: string;
  /** 正規化後之終點站名稱（帶「站」字尾） */
  destination: string;
  /** 上游原始倒數字串 */
  rawCountDown: string;
  /** 轉換後之初始倒數秒數 */
  initialSeconds: number;
  /** 上游原始資料時間字串 */
  sourceTime: string;
}

/**
 * 儲存於 L1 (Isolate 記憶體) 與 L2 (`caches.default`) 的全系統快取快照結構
 */
export interface SystemTrackSnapshot {
  /** 快照結構版本號（升版時可自動隔離舊版快取） */
  schemaVersion: 1;
  /** 運輸系統代碼 */
  system: TransitSystemCode;
  /** 資料來源提供者識別碼 */
  providerId: string;
  /** Worker 取得並寫入快取當下的毫秒時間戳 (`Date.now()`) */
  fetchedAtMs: number;
  /** 全系統有效列車陣列 */
  records: NormalizedTrainRecord[];
}

/** 快取命中或觸發重抓的原因代碼 */
export type CacheResolutionStatus =
  | 'HIT'
  | 'CACHE_MISS'
  | 'MAX_AGE_EXPIRED'
  | 'TRAIN_ARRIVED_REFRESH'
  | 'NO_TRAINS_REFRESH';

/** 資料實際取得的儲存層來源 */
export type CacheLayerSource = 'L1_MEMORY' | 'L2_EDGE' | 'UPSTREAM';

/**
 * 對外 API 查詢參數（經驗證與正規化後）
 */
export interface ValidatedArrivalQuery {
  line: SupportedTrtcLineCode;
  lineName: string;
  station: string;
  dest: string;
  includeShortTurn: boolean;
  /** 套用區間車映射、O 線共線段規則及清客防呆後，實際納入篩選的終點站集合 */
  effectiveDestinations: string[];
}

/**
 * 對外 API 回傳之單班列車到站資訊 DTO
 */
export interface ArrivalTrainDto {
  /** 車次編號（若上游未提供則為 `""`） */
  trainNumber: string;
  /** 路線代碼（例如 `"R"`） */
  lineCode: SupportedTrtcLineCode;
  /** 路線中文名稱（例如 `"淡水信義線"`） */
  lineName: string;
  /** 列車終點站名稱（例如 `"北投站"`） */
  destination: string;
  /** 是否為區間車／同向非指定主終點列車（當 `destination !== query.dest` 時為 `true`） */
  isShortTurn: boolean;
  /** 上游原始倒數字串 */
  rawCountDown: string;
  /** 快取寫入當下的初始秒數 */
  initialSeconds: number;
  /** 依據快取經過時間動態推算後的當下剩餘秒數 */
  remainingSeconds: number;
  /** 北捷上游資料時間戳字串 */
  sourceTime: string;
}

/**
 * `GET /api/arrivals` 標準成功回應結構
 */
export interface ArrivalApiResponse {
  ok: true;
  system: TransitSystemCode;
  query: ValidatedArrivalQuery;
  cache: {
    hit: boolean;
    status: CacheResolutionStatus;
    layer: CacheLayerSource;
    fetchedAt: string;
    elapsedSeconds: number;
  };
  trains: ArrivalTrainDto[];
}

/**
 * 上游軌道動態資料提供者抽象介面（方便未來替換或擴充其他資料源／測試 Mock）
 */
export interface TrackDataProvider {
  readonly providerId: string;
  readonly system: TransitSystemCode;
  fetchNormalizedRecords(): Promise<NormalizedTrainRecord[]>;
}
