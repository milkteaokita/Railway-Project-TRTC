import { describe, expect, it } from 'vitest';
import {
  buildGetTrackInfoSoapEnvelope,
  normalizeTrtcTrackItems,
  parseHybridTrtcResponse,
} from '../src/providers/trtc-soap.provider';
import { AppError } from '../src/utils/http';
import {
  normalizeStationName,
  parseBooleanParam,
  parseCountDownToSeconds,
} from '../src/utils/station';

const SAMPLE_HYBRID_RESPONSE = `[{"TrainNumber":"","StationName":"松山機場站","DestinationName":"南港展覽館站","CountDown":"01:12","NowDateTime":"2026-10-26 20:45:50"},{"TrainNumber":"102","StationName":"大安站","DestinationName":"淡水站","CountDown":"04:49","NowDateTime":"2026-10-26 20:45:50"},{"TrainNumber":"121","StationName":"中山站","DestinationName":"淡水站","CountDown":"列車進站","NowDateTime":"2026-10-26 20:45:50"},{"TrainNumber":"","StationName":"新埔民生站","DestinationName":"新北產業園區站","CountDown":"資料擷取中","NowDateTime":"2026-10-26 20:45:51"}]
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <soap:Body>
        <getTrackInfoResponse xmlns="http://tempuri.org/" />
    </soap:Body>
</soap:Envelope>`;

describe('SOAP Request & Hybrid JSON+XML Parser', () => {
  it('escapes XML special characters in SOAP credentials', () => {
    const xml = buildGetTrackInfoSoapEnvelope('user<1>&"a"', "p'ass<word>&2");
    expect(xml).toContain('<userName>user&lt;1&gt;&amp;&quot;a&quot;</userName>');
    expect(xml).toContain('<passWord>p&apos;ass&lt;word&gt;&amp;2</passWord>');
  });

  it('extracts JSON array placed before trailing SOAP XML envelope', () => {
    const rawItems = parseHybridTrtcResponse(SAMPLE_HYBRID_RESPONSE);
    expect(rawItems).toHaveLength(4);
    expect(rawItems[0]?.StationName).toBe('松山機場站');
    expect(rawItems[2]?.CountDown).toBe('列車進站');
  });

  it('supports fallback when JSON is wrapped inside <getTrackInfoResult> tag', () => {
    const wrappedXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getTrackInfoResponse xmlns="http://tempuri.org/">
      <getTrackInfoResult>[{&quot;TrainNumber&quot;:&quot;101&quot;,&quot;StationName&quot;:&quot;大安站&quot;,&quot;DestinationName&quot;:&quot;淡水站&quot;,&quot;CountDown&quot;:&quot;01:30&quot;,&quot;NowDateTime&quot;:&quot;2026-10-26 21:00:00&quot;}]</getTrackInfoResult>
    </getTrackInfoResponse>
  </soap:Body>
</soap:Envelope>`;
    const rawItems = parseHybridTrtcResponse(wrappedXml);
    expect(rawItems).toHaveLength(1);
    expect(rawItems[0]?.TrainNumber).toBe('101');
  });

  it('throws 502 AppError on SOAP fault or auth error text', () => {
    const faultXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultstring>帳號或密碼錯誤</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;
    expect(() => parseHybridTrtcResponse(faultXml)).toThrowError(AppError);
  });

  it('normalizes records and filters out non-numeric status like 資料擷取中', () => {
    const rawItems = parseHybridTrtcResponse(SAMPLE_HYBRID_RESPONSE);
    const normalized = normalizeTrtcTrackItems(rawItems, 10);

    // 「資料擷取中」已被過濾，剩餘 3 筆有效班次
    expect(normalized).toHaveLength(3);
    expect(normalized[0]).toMatchObject({
      lineCode: 'BR',
      station: '松山機場站',
      destination: '南港展覽館站',
      initialSeconds: 72,
    });
    expect(normalized[1]).toMatchObject({
      lineCode: 'R',
      trainNumber: '102',
      station: '大安站',
      destination: '淡水站',
      initialSeconds: 289,
    });
    expect(normalized[2]).toMatchObject({
      lineCode: 'R',
      trainNumber: '121',
      station: '中山站',
      destination: '淡水站',
      initialSeconds: 10,
    });
  });
});

describe('Station Normalization & Countdown Utilities', () => {
  it('normalizes station names safely without mangling 台北車站', () => {
    expect(normalizeStationName('大安')).toBe('大安站');
    expect(normalizeStationName('大安站')).toBe('大安站');
    expect(normalizeStationName('台北車站')).toBe('台北車站');
    expect(normalizeStationName('臺北車站')).toBe('台北車站');
    expect(normalizeStationName('北車')).toBe('台北車站');
    expect(normalizeStationName('台北')).toBe('台北車站');
    expect(normalizeStationName('臺電大樓')).toBe('台電大樓站');
    expect(normalizeStationName('廣慈/奉天宮')).toBe('廣慈/奉天宮站');
  });

  it('converts CountDown strings accurately', () => {
    expect(parseCountDownToSeconds('02:15', 10)).toBe(135);
    expect(parseCountDownToSeconds('00:05', 10)).toBe(5);
    expect(parseCountDownToSeconds('00:00', 10)).toBe(10);
    expect(parseCountDownToSeconds('列車進站', 10)).toBe(10);
    expect(parseCountDownToSeconds('即將進站', 10)).toBe(10);
    expect(parseCountDownToSeconds('資料擷取中', 10)).toBeNull();
    expect(parseCountDownToSeconds('', 10)).toBeNull();
  });

  it('parses boolean query parameters cleanly', () => {
    expect(parseBooleanParam(null, false)).toBe(false);
    expect(parseBooleanParam('true')).toBe(true);
    expect(parseBooleanParam('1')).toBe(true);
    expect(parseBooleanParam('false')).toBe(false);
    expect(parseBooleanParam('0')).toBe(false);
    expect(parseBooleanParam('invalid')).toBeNull();
  });
});
