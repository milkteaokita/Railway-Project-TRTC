/**
 * @module providers/trtc-soap.provider
 * @description 台北捷運官方 `TrackInfo.asmx` SOAP API 資料提供者與「JSON + XML 混合格式」解析器。
 *
 * 北捷 `getTrackInfo` 實測回傳特徵：
 * 回應本體最前方為完整 JSON 陣列 `[{"TrainNumber":...}, ...]`，其後緊接空的 SOAP Envelope XML：
 * `<?xml version="1.0" encoding="utf-8"?><soap:Envelope ...><getTrackInfoResponse ... /></soap:Envelope>`
 *
 * 本模組採用零相依套件之 O(1) 字串切割擷取 JSON，並將原始紀錄轉換為帶路線歸屬 (`lineCode`) 的標準化結構。
 */

import { TRTC_LINES, inferRecordLineCode } from '../config/trtc-network';
import type {
  NormalizedTrainRecord,
  RawTrtcTrackItem,
  TrackDataProvider,
  TrtcLineCode,
} from '../types/arrival';
import { AppError } from '../utils/http';
import { normalizeStationName, parseCountDownToSeconds } from '../utils/station';
import { escapeXml, unescapeXml } from '../utils/xml';

export interface TrtcSoapProviderOptions {
  apiUrl: string;
  username: string;
  password: string;
  arrivingDefaultSeconds: number;
  timeoutMs: number;
  /** 可注入自訂 fetch（方便單元測試模擬上游回應） */
  fetchFn?: typeof fetch;
}

/**
 * 組裝北捷 `getTrackInfo` SOAP 1.1 Request XML 字串（含帳密 XML 實體跳脫防護）
 */
export function buildGetTrackInfoSoapEnvelope(username: string, password: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<getTrackInfo xmlns="http://tempuri.org/">
<userName>${escapeXml(username)}</userName>
<passWord>${escapeXml(password)}</passWord>
</getTrackInfo>
</soap:Body>
</soap:Envelope>`;
}

/**
 * 從北捷「JSON + XML 混合字串」中擷取並解析內層 JSON 陣列。
 *
 * 支援兩種形態：
 * 1. 標準實測形態：`[{...}]\n<?xml version="1.0" ...>`（JSON 在 XML 宣告之前）
 * 2. 相容備援形態：`<soap:Envelope>...<getTrackInfoResult>[{...}]</getTrackInfoResult>...</soap:Envelope>`
 */
export function parseHybridTrtcResponse(rawBody: string): RawTrtcTrackItem[] {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    throw new AppError(502, 'UPSTREAM_EMPTY_RESPONSE', '北捷上游 API 回傳空白內容');
  }

  const xmlDeclIndex = trimmed.indexOf('<?xml');
  let candidateJson = (xmlDeclIndex >= 0 ? trimmed.slice(0, xmlDeclIndex) : trimmed).trim();

  // 相容備援：若未來上游改將 JSON 字串包在 SOAP XML 標籤內
  if (!candidateJson && xmlDeclIndex === 0) {
    const resultTagMatch = /<getTrackInfoResult[^>]*>([\s\S]*?)<\/getTrackInfoResult>/i.exec(trimmed);
    if (resultTagMatch?.[1]) {
      candidateJson = unescapeXml(resultTagMatch[1].trim());
    }
  }

  // 檢查是否為 SOAP Fault 或認證失敗純文字訊息
  if (!candidateJson.startsWith('[') || !candidateJson.endsWith(']')) {
    const faultMatch = /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i.exec(trimmed);
    const faultReason = faultMatch?.[1]?.trim() || candidateJson.slice(0, 120) || '非預期的回應格式';
    throw new AppError(
      502,
      'UPSTREAM_INVALID_PAYLOAD',
      `北捷上游 API 未回傳有效 JSON 陣列（原因摘要：${faultReason}）`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateJson);
  } catch (err) {
    throw new AppError(
      502,
      'UPSTREAM_JSON_PARSE_ERROR',
      `解析北捷上游 JSON 陣列失敗：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AppError(502, 'UPSTREAM_NOT_ARRAY', '北捷上游 API 回傳之 JSON 並非陣列結構');
  }

  return parsed as RawTrtcTrackItem[];
}

/**
 * 將上游原始陣列清理、過濾無效狀態（如「資料擷取中」），並推斷路線代碼轉換為標準化紀錄陣列
 */
export function normalizeTrtcTrackItems(
  rawItems: readonly RawTrtcTrackItem[],
  arrivingDefaultSeconds: number,
): NormalizedTrainRecord[] {
  const normalizedRecords: NormalizedTrainRecord[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (!item || typeof item !== 'object') continue;

    const rawStation = typeof item.StationName === 'string' ? item.StationName : '';
    const rawDest = typeof item.DestinationName === 'string' ? item.DestinationName : '';
    const rawCountDown = typeof item.CountDown === 'string' ? item.CountDown.trim() : '';
    const trainNumber = typeof item.TrainNumber === 'string' ? item.TrainNumber.trim() : '';
    const sourceTime = typeof item.NowDateTime === 'string' ? item.NowDateTime.trim() : '';

    const station = normalizeStationName(rawStation);
    const destination = normalizeStationName(rawDest);
    if (!station || !destination) continue;

    const initialSeconds = parseCountDownToSeconds(rawCountDown, arrivingDefaultSeconds);
    if (initialSeconds === null) {
      // 例如「資料擷取中」或其他非有效時間狀態，略過不納入有效倒數班次
      continue;
    }

    const lineCode = inferRecordLineCode(station, destination, trainNumber, i, rawItems);
    const lineName = resolveLineName(lineCode);

    normalizedRecords.push({
      system: 'TRTC',
      lineCode,
      lineName,
      trainNumber,
      station,
      destination,
      rawCountDown,
      initialSeconds,
      sourceTime,
    });
  }

  return normalizedRecords;
}

function resolveLineName(lineCode: TrtcLineCode | 'UNKNOWN'): string {
  if (lineCode === 'UNKNOWN') return '未知路線';
  return TRTC_LINES[lineCode].name;
}

/**
 * 台北捷運官方 SOAP API 資料提供者實作
 */
export class TrtcSoapProvider implements TrackDataProvider {
  public readonly providerId = 'trtc-official-soap-trackinfo';
  public readonly system = 'TRTC' as const;

  private readonly options: TrtcSoapProviderOptions;

  constructor(options: TrtcSoapProviderOptions) {
    this.options = options;
  }

  public async fetchNormalizedRecords(): Promise<NormalizedTrainRecord[]> {
    const { apiUrl, username, password, arrivingDefaultSeconds, timeoutMs } = this.options;
    const fetchImpl = this.options.fetchFn ?? fetch;

    if (!apiUrl || !username || !password) {
      throw new AppError(
        500,
        'MISSING_UPSTREAM_CREDENTIALS',
        '伺服器尚未設定完整的北捷 API 環境變數（需設定 TRTC_API_URL, TRTC_API_USERNAME, TRTC_API_PASSWORD）',
      );
    }

    const soapEnvelope = buildGetTrackInfoSoapEnvelope(username, password);

    let response: Response;
    try {
      response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
        },
        body: soapEnvelope,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new AppError(
        504,
        isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK_ERROR',
        isTimeout
          ? `呼叫北捷上游 API 逾時（超過 ${timeoutMs}ms）`
          : `無法連線至北捷上游 API：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new AppError(
        502,
        'UPSTREAM_HTTP_ERROR',
        `北捷上游 API 回傳非預期 HTTP 狀態碼：${response.status}`,
      );
    }

    const rawText = await response.text();
    const rawItems = parseHybridTrtcResponse(rawText);
    return normalizeTrtcTrackItems(rawItems, arrivingDefaultSeconds);
  }
}
