/**
 * @module config/trtc-network-v2
 * @description API v2 台北捷運「依行駛方向分組」路網設定檔（移除 Flag，依各站實際月台方向直接提供全數同向列車）。
 *
 * v2 核心設計原則：
 * 1. 以「行駛方向」取代「指定終點站 + Flag」：
 *    - 淡水信義線 (R)：分為 `淡水方向`（含往淡水、往北投、於北投站含往新北投）與 `廣慈/奉天宮方向`（含往廣慈/奉天宮、往大安、於新北投及北投以北含往北投）。
 *    - 松山新店線 (G)：分為 `松山方向`、`新店方向`（含往新店、往台電大樓）、`小碧潭方向`（七張站提供）、`七張方向`（小碧潭站提供）。
 *    - 中和新蘆線 (O)：分為 `迴龍方向`、`蘆洲方向`、`南勢角方向`；於共線段（南勢角站～大橋頭站）查詢迴龍或蘆洲方向皆直接回傳「往迴龍＋往蘆洲」全數北上列車。
 *    - 板南線 (BL)：分為 `南港展覽館方向`（含往南港展覽館、往昆陽等）與 `頂埔方向`（含往頂埔、往亞東醫院等）。
 *    - 文湖線 (BR)：分為 `南港展覽館方向` 與 `動物園方向`。
 * 2. 精準維護每一站實際可搭乘的 `directions` 與對應的 `matchedDestinations`，徹底避免反方向月台列車混入或終點清客車誤入。
 */

import type { SupportedTrtcLineCode, TrtcLineCode } from '../types/arrival';
import type {
  V2DirectionSummaryDto,
  V2LineMetadataDto,
  V2StationDirectionsDto,
} from '../types/arrival-v2';
import { normalizeStationName } from '../utils/station';

export interface V2LineConfig {
  code: TrtcLineCode;
  name: string;
  aliases: readonly string[];
  supported: boolean;
  unsupportedReason?: string;
  stations: readonly string[];
  shortTurnTerminals: ReadonlySet<string>;
  directions: readonly V2DirectionSummaryDto[];
  deprecatedDirections?: Readonly<Record<string, string>>;
  /**
   * 傳回指定車站在特定方向下應納入的所有列車 `DestinationName`；
   * 若回傳 `null` 代表該車站不提供此方向（例如終點站往自身方向、或非支線交會站查支線方向）。
   */
  resolveStationDirectionDestinations: (
    station: string,
    direction: string,
  ) => readonly string[] | null;
}

/**
 * 將使用者輸入的 `direction`（或 `dest`）正規化為標準站名格式。
 * 支援輸入如：`"淡水"`、`"淡水站"`、`"淡水方向"`、`"往淡水"`、`"往淡水方向"` -> `"淡水站"`。
 */
export function normalizeDirectionInput(rawDirection: string): string {
  let cleaned = rawDirection.trim().replace(/臺/g, '台');
  if (!cleaned) return '';

  if (cleaned.startsWith('往') && cleaned.length > 1) {
    cleaned = cleaned.slice(1).trim();
  }
  if (cleaned.endsWith('方向') && cleaned.length > 2) {
    cleaned = cleaned.slice(0, -2).trim();
  }

  return normalizeStationName(cleaned);
}

/**
 * 將標準方向識別值轉為易讀的顯示名稱（例如 `"淡水站"` -> `"淡水方向"`、`"廣慈/奉天宮站"` -> `"廣慈/奉天宮方向"`）
 */
export function formatDirectionLabel(normalizedDirection: string): string {
  if (normalizedDirection === '台北車站') {
    return '台北車站方向';
  }
  const base = normalizedDirection.endsWith('站')
    ? normalizedDirection.slice(0, -1)
    : normalizedDirection;
  return `${base}方向`;
}

// ============================================================================
// 各線有序車站常數與區段索引（確保 O(1) 判定各站所處區段）
// ============================================================================

const BR_SOUTH_TO_NORTH = [
  '動物園站',
  '木柵站',
  '萬芳社區站',
  '萬芳醫院站',
  '辛亥站',
  '麟光站',
  '六張犁站',
  '科技大樓站',
  '大安站',
  '忠孝復興站',
  '南京復興站',
  '中山國中站',
  '松山機場站',
  '大直站',
  '劍南路站',
  '西湖站',
  '港墘站',
  '文德站',
  '內湖站',
  '大湖公園站',
  '葫洲站',
  '東湖站',
  '南港軟體園區站',
  '南港展覽館站',
] as const;

const R_MAIN_SOUTH_TO_NORTH = [
  '廣慈/奉天宮站',
  '象山站',
  '台北101/世貿站',
  '信義安和站',
  '大安站',
  '大安森林公園站',
  '東門站',
  '中正紀念堂站',
  '台大醫院站',
  '台北車站',
  '中山站',
  '雙連站',
  '民權西路站',
  '圓山站',
  '劍潭站',
  '士林站',
  '芝山站',
  '明德站',
  '石牌站',
  '唭哩岸站',
  '奇岩站',
  '北投站',
  '復興崗站',
  '忠義站',
  '關渡站',
  '竹圍站',
  '紅樹林站',
  '淡水站',
] as const;

const G_MAIN_SOUTH_TO_NORTH = [
  '新店站',
  '新店區公所站',
  '七張站',
  '大坪林站',
  '景美站',
  '萬隆站',
  '公館站',
  '台電大樓站',
  '古亭站',
  '中正紀念堂站',
  '小南門站',
  '西門站',
  '北門站',
  '中山站',
  '松江南京站',
  '南京復興站',
  '台北小巨蛋站',
  '南京三民站',
  '松山站',
] as const;

const O_SHARED_TRUNK_SOUTH_TO_NORTH = [
  '南勢角站',
  '景安站',
  '永安市場站',
  '頂溪站',
  '古亭站',
  '東門站',
  '忠孝新生站',
  '松江南京站',
  '行天宮站',
  '中山國小站',
  '民權西路站',
  '大橋頭站',
] as const;

const O_XINZHUANG_BRANCH = [
  '台北橋站',
  '菜寮站',
  '三重站',
  '先嗇宮站',
  '頭前庄站',
  '新莊站',
  '輔大站',
  '丹鳳站',
  '迴龍站',
] as const;

const O_LUZHOU_BRANCH = [
  '三重國小站',
  '三和國中站',
  '徐匯中學站',
  '三民高中站',
  '蘆洲站',
] as const;

const BL_WEST_TO_EAST = [
  '頂埔站',
  '永寧站',
  '土城站',
  '海山站',
  '亞東醫院站',
  '府中站',
  '板橋站',
  '新埔站',
  '江子翠站',
  '龍山寺站',
  '西門站',
  '台北車站',
  '善導寺站',
  '忠孝新生站',
  '忠孝復興站',
  '忠孝敦化站',
  '國父紀念館站',
  '市政府站',
  '永春站',
  '後山埤站',
  '昆陽站',
  '南港站',
  '南港展覽館站',
] as const;

function buildIndexMap(stations: readonly string[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  stations.forEach((s, idx) => map.set(s, idx));
  return map;
}

const BR_INDEX = buildIndexMap(BR_SOUTH_TO_NORTH);
const R_MAIN_INDEX = buildIndexMap(R_MAIN_SOUTH_TO_NORTH);
const G_MAIN_INDEX = buildIndexMap(G_MAIN_SOUTH_TO_NORTH);
const BL_INDEX = buildIndexMap(BL_WEST_TO_EAST);

const O_TRUNK_SET: ReadonlySet<string> = new Set(O_SHARED_TRUNK_SOUTH_TO_NORTH);
const O_XINZHUANG_SET: ReadonlySet<string> = new Set(O_XINZHUANG_BRANCH);
const O_LUZHOU_SET: ReadonlySet<string> = new Set(O_LUZHOU_BRANCH);

const R_DAAN_IDX = R_MAIN_INDEX.get('大安站')!;
const R_BEITOU_IDX = R_MAIN_INDEX.get('北投站')!;
const G_TAIPOWER_IDX = G_MAIN_INDEX.get('台電大樓站')!;
const BL_FAR_EASTERN_IDX = BL_INDEX.get('亞東醫院站')!;
const BL_KUNYANG_IDX = BL_INDEX.get('昆陽站')!;

// ============================================================================
// API v2 路網註冊表
// ============================================================================

export const TRTC_V2_LINES: Readonly<Record<TrtcLineCode, V2LineConfig>> = {
  BR: {
    code: 'BR',
    name: '文湖線',
    aliases: ['BR', '文湖線', '文湖', '棕線'],
    supported: true,
    stations: BR_SOUTH_TO_NORTH,
    shortTurnTerminals: new Set(),
    directions: [
      {
        direction: '南港展覽館站',
        label: '南港展覽館方向',
        description: '往南港展覽館方向（北／東向）',
        possibleDestinations: ['南港展覽館站'],
      },
      {
        direction: '動物園站',
        label: '動物園方向',
        description: '往動物園方向（南／西向）',
        possibleDestinations: ['動物園站'],
      },
    ],
    resolveStationDirectionDestinations(station, direction) {
      if (!BR_INDEX.has(station)) return null;
      if (direction === '南港展覽館站') {
        return station === '南港展覽館站' ? null : ['南港展覽館站'];
      }
      if (direction === '動物園站') {
        return station === '動物園站' ? null : ['動物園站'];
      }
      return null;
    },
  },

  R: {
    code: 'R',
    name: '淡水信義線',
    aliases: ['R', '淡水信義線', '淡水信義', '紅線', '新北投支線'],
    supported: true,
    stations: [...R_MAIN_SOUTH_TO_NORTH, '新北投站'],
    shortTurnTerminals: new Set(['北投站', '大安站']),
    directions: [
      {
        direction: '淡水站',
        label: '淡水方向',
        description: '往淡水方向（含往淡水、往北投區間車、於北投站含往新北投支線）',
        possibleDestinations: ['淡水站', '北投站', '新北投站'],
      },
      {
        direction: '廣慈/奉天宮站',
        label: '廣慈/奉天宮方向',
        description: '往廣慈/奉天宮方向（含往廣慈/奉天宮、往大安區間車、於新北投及北投以北含往北投列車）',
        possibleDestinations: ['廣慈/奉天宮站', '大安站', '北投站'],
      },
    ],
    deprecatedDirections: {
      象山站:
        '淡水信義線南向終點已延伸為「廣慈/奉天宮站」，請改用 direction=廣慈/奉天宮。',
    },
    resolveStationDirectionDestinations(station, direction) {
      // 新北投支線端點站：唯一列車為折返開往「北投站」，歸入往主線／市區之「廣慈/奉天宮方向」
      if (station === '新北投站') {
        if (direction === '廣慈/奉天宮站') {
          return ['北投站', '大安站', '廣慈/奉天宮站'];
        }
        return null;
      }

      const idx = R_MAIN_INDEX.get(station);
      if (idx === undefined) return null;

      if (direction === '淡水站') {
        if (station === '淡水站') return null;
        if (idx < R_BEITOU_IDX) {
          // 廣慈/奉天宮站 ～ 奇岩站：北上包含往淡水與往北投區間車
          return ['淡水站', '北投站'];
        }
        if (idx === R_BEITOU_IDX) {
          // 北投站：包含往淡水主線與往新北投支線（排除以北投站為終點的清客車）
          return ['淡水站', '新北投站'];
        }
        // 復興崗站 ～ 紅樹林站：已過北投站，北上僅往淡水站
        return ['淡水站'];
      }

      if (direction === '廣慈/奉天宮站') {
        if (station === '廣慈/奉天宮站') return null;
        if (idx > R_BEITOU_IDX) {
          // 復興崗站 ～ 淡水站：南下包含往廣慈/奉天宮、往大安，以及收班回北投機廠之往北投列車
          return ['廣慈/奉天宮站', '大安站', '北投站'];
        }
        if (idx > R_DAAN_IDX) {
          // 大安森林公園站 ～ 北投站：南下包含往廣慈/奉天宮與往大安區間車
          return ['廣慈/奉天宮站', '大安站'];
        }
        // 象山站 ～ 大安站（於大安站自動排除往大安清客車，僅剩往廣慈/奉天宮站）
        return ['廣慈/奉天宮站'];
      }

      return null;
    },
  },

  G: {
    code: 'G',
    name: '松山新店線',
    aliases: ['G', '松山新店線', '松山新店', '綠線', '小碧潭支線'],
    supported: true,
    stations: [...G_MAIN_SOUTH_TO_NORTH, '小碧潭站'],
    shortTurnTerminals: new Set(['台電大樓站']),
    directions: [
      {
        direction: '松山站',
        label: '松山方向',
        description: '往松山方向（北／東向，僅往松山列車）',
        possibleDestinations: ['松山站'],
      },
      {
        direction: '新店站',
        label: '新店方向',
        description: '往新店方向（南向，含往新店與往台電大樓區間車）',
        possibleDestinations: ['新店站', '台電大樓站'],
      },
      {
        direction: '小碧潭站',
        label: '小碧潭方向',
        description: '往小碧潭方向（小碧潭支線，於七張站提供）',
        possibleDestinations: ['小碧潭站'],
      },
      {
        direction: '七張站',
        label: '七張方向',
        description: '往七張方向（小碧潭支線折返，於小碧潭站提供）',
        possibleDestinations: ['七張站'],
      },
    ],
    resolveStationDirectionDestinations(station, direction) {
      // 小碧潭支線端點站：僅提供往七張方向
      if (station === '小碧潭站') {
        return direction === '七張站' ? ['七張站'] : null;
      }

      const idx = G_MAIN_INDEX.get(station);
      if (idx === undefined) return null;

      if (direction === '松山站') {
        return station === '松山站' ? null : ['松山站'];
      }

      if (direction === '新店站') {
        if (station === '新店站') return null;
        if (idx > G_TAIPOWER_IDX) {
          // 古亭站 ～ 松山站：南下包含往新店與往台電大樓區間車
          return ['新店站', '台電大樓站'];
        }
        // 新店區公所站 ～ 台電大樓站（於台電大樓站自動排除清客車）：僅往新店站
        return ['新店站'];
      }

      if (direction === '小碧潭站') {
        // 七張站額外提供往小碧潭方向
        return station === '七張站' ? ['小碧潭站'] : null;
      }

      return null;
    },
  },

  O: {
    code: 'O',
    name: '中和新蘆線',
    aliases: ['O', '中和新蘆線', '中和新蘆', '橘線'],
    supported: true,
    stations: [
      ...O_SHARED_TRUNK_SOUTH_TO_NORTH,
      ...O_XINZHUANG_BRANCH,
      ...O_LUZHOU_BRANCH,
    ],
    shortTurnTerminals: new Set(),
    directions: [
      {
        direction: '迴龍站',
        label: '迴龍方向',
        description: '往迴龍方向（北向；於南勢角站～大橋頭站共線段一併提供往迴龍與往蘆洲全數北上列車）',
        possibleDestinations: ['迴龍站', '蘆洲站'],
      },
      {
        direction: '蘆洲站',
        label: '蘆洲方向',
        description: '往蘆洲方向（北向；於南勢角站～大橋頭站共線段一併提供往蘆洲與往迴龍全數北上列車）',
        possibleDestinations: ['蘆洲站', '迴龍站'],
      },
      {
        direction: '南勢角站',
        label: '南勢角方向',
        description: '往南勢角方向（南向）',
        possibleDestinations: ['南勢角站'],
      },
    ],
    resolveStationDirectionDestinations(station, direction) {
      // 共線段（南勢角站 ～ 大橋頭站，含大橋頭）：北上查迴龍或蘆洲皆回傳全部北上列車
      if (O_TRUNK_SET.has(station)) {
        if (direction === '迴龍站') {
          return ['迴龍站', '蘆洲站'];
        }
        if (direction === '蘆洲站') {
          return ['蘆洲站', '迴龍站'];
        }
        if (direction === '南勢角站') {
          return station === '南勢角站' ? null : ['南勢角站'];
        }
        return null;
      }

      // 新莊分線段（台北橋站 ～ 迴龍站）
      if (O_XINZHUANG_SET.has(station)) {
        if (direction === '迴龍站') {
          return station === '迴龍站' ? null : ['迴龍站'];
        }
        if (direction === '南勢角站') {
          return ['南勢角站'];
        }
        return null;
      }

      // 蘆洲分線段（三重國小站 ～ 蘆洲站）
      if (O_LUZHOU_SET.has(station)) {
        if (direction === '蘆洲站') {
          return station === '蘆洲站' ? null : ['蘆洲站'];
        }
        if (direction === '南勢角站') {
          return ['南勢角站'];
        }
        return null;
      }

      return null;
    },
  },

  BL: {
    code: 'BL',
    name: '板南線',
    aliases: ['BL', '板南線', '板南', '藍線'],
    supported: true,
    stations: BL_WEST_TO_EAST,
    shortTurnTerminals: new Set(['昆陽站', '亞東醫院站']),
    directions: [
      {
        direction: '南港展覽館站',
        label: '南港展覽館方向',
        description: '往南港展覽館方向（東向，含往南港展覽館與往昆陽區間車）',
        possibleDestinations: ['南港展覽館站', '昆陽站', '亞東醫院站'],
      },
      {
        direction: '頂埔站',
        label: '頂埔方向',
        description: '往頂埔方向（西向，含往頂埔與往亞東醫院區間車）',
        possibleDestinations: ['頂埔站', '亞東醫院站', '昆陽站'],
      },
    ],
    resolveStationDirectionDestinations(station, direction) {
      const idx = BL_INDEX.get(station);
      if (idx === undefined) return null;

      if (direction === '南港展覽館站') {
        if (station === '南港展覽館站') return null;
        if (idx < BL_FAR_EASTERN_IDX) {
          // 頂埔站 ～ 海山站：東向包含往南港展覽館、昆陽及亞東醫院
          return ['南港展覽館站', '昆陽站', '亞東醫院站'];
        }
        if (idx < BL_KUNYANG_IDX) {
          // 亞東醫院站 ～ 後山埤站：東向包含往南港展覽館與往昆陽區間車
          return ['南港展覽館站', '昆陽站'];
        }
        // 昆陽站 ～ 南港站：僅往南港展覽館站
        return ['南港展覽館站'];
      }

      if (direction === '頂埔站') {
        if (station === '頂埔站') return null;
        if (idx > BL_KUNYANG_IDX) {
          // 南港站 ～ 南港展覽館站：西向包含往頂埔、亞東醫院及回昆陽班次
          return ['頂埔站', '亞東醫院站', '昆陽站'];
        }
        if (idx > BL_FAR_EASTERN_IDX) {
          // 府中站 ～ 昆陽站：西向包含往頂埔與往亞東醫院區間車
          return ['頂埔站', '亞東醫院站'];
        }
        // 永寧站 ～ 亞東醫院站：西向僅往頂埔站
        return ['頂埔站'];
      }

      return null;
    },
  },

  Y: {
    code: 'Y',
    name: '環狀線',
    aliases: ['Y', '環狀線', '環狀', '黃線'],
    supported: false,
    unsupportedReason: '環狀線 (Y) 目前尚未成環營運，本服務暫不開放查詢（僅支援 BR, R, G, O, BL）。',
    stations: [
      '大坪林站',
      '十四張站',
      '秀朗橋站',
      '景平站',
      '景安站',
      '中和站',
      '橋和站',
      '中原站',
      '板新站',
      '板橋站',
      '新埔民生站',
      '頭前庄站',
      '幸福站',
      '新北產業園區站',
    ],
    shortTurnTerminals: new Set(),
    directions: [],
    resolveStationDirectionDestinations() {
      return null;
    },
  },
};

// ============================================================================
// 快速查詢索引與預先建構之 `/api/v2/lines` 元資料快取
// ============================================================================

const V2_LINE_STATION_SETS: Readonly<Record<TrtcLineCode, ReadonlySet<string>>> = {
  BR: new Set(TRTC_V2_LINES.BR.stations),
  R: new Set(TRTC_V2_LINES.R.stations),
  G: new Set(TRTC_V2_LINES.G.stations),
  O: new Set(TRTC_V2_LINES.O.stations),
  BL: new Set(TRTC_V2_LINES.BL.stations),
  Y: new Set(TRTC_V2_LINES.Y.stations),
};

const V2_ALIAS_TO_LINE_CODE = new Map<string, TrtcLineCode>();
for (const line of Object.values(TRTC_V2_LINES)) {
  for (const alias of line.aliases) {
    V2_ALIAS_TO_LINE_CODE.set(alias.toUpperCase(), line.code);
  }
}

export function findV2LineByInput(rawLine: string): V2LineConfig | null {
  const key = rawLine.trim().replace(/臺/g, '台').toUpperCase();
  const code = V2_ALIAS_TO_LINE_CODE.get(key);
  return code ? TRTC_V2_LINES[code] : null;
}

export function isStationOnV2Line(lineCode: TrtcLineCode, normalizedStation: string): boolean {
  return V2_LINE_STATION_SETS[lineCode].has(normalizedStation);
}

/**
 * 取得某車站在指定路線上所有可選的方向清單
 */
export function getAvailableV2DirectionsForStation(
  lineConfig: V2LineConfig,
  normalizedStation: string,
): string[] {
  const available: string[] = [];
  for (const dir of lineConfig.directions) {
    const matched = lineConfig.resolveStationDirectionDestinations(
      normalizedStation,
      dir.direction,
    );
    if (matched && matched.length > 0) {
      available.push(dir.direction);
    }
  }
  return available;
}

/**
 * 當呼叫端未傳入 `line` 時，依 `(station, direction)` 自動推斷支援的 v2 路線
 */
export function inferV2LinesByStationAndDirection(
  normalizedStation: string,
  normalizedDirection: string,
): SupportedTrtcLineCode[] {
  const candidates: SupportedTrtcLineCode[] = [];
  const supportedCodes: SupportedTrtcLineCode[] = ['BR', 'R', 'G', 'O', 'BL'];

  for (const code of supportedCodes) {
    const line = TRTC_V2_LINES[code];
    if (!V2_LINE_STATION_SETS[code].has(normalizedStation)) continue;

    const isKnownDirection =
      line.directions.some((d) => d.direction === normalizedDirection) ||
      Boolean(line.deprecatedDirections?.[normalizedDirection]);

    if (isKnownDirection) {
      candidates.push(code);
    }
  }

  return candidates;
}

/**
 * 判定 v2 回傳列車是否為區間車（`isShortTurn`）
 * - 新北投支線於「新北投站」往「北投站」為支線折返車，非主線區間車（`false`）。
 * - 其餘依該路線定義之 `shortTurnTerminals`（北投站、大安站、台電大樓站、昆陽站、亞東醫院站）判定。
 */
export function isV2ShortTurnTrain(
  lineCode: SupportedTrtcLineCode,
  queryStation: string,
  trainDestination: string,
): boolean {
  if (lineCode === 'R' && queryStation === '新北投站' && trainDestination === '北投站') {
    return false;
  }
  return TRTC_V2_LINES[lineCode].shortTurnTerminals.has(trainDestination);
}

/**
 * 產生 `GET /api/v2/lines` 所需的完整結構化路線與各站可用方向清單
 */
export function buildV2LinesMetadata(): readonly V2LineMetadataDto[] {
  return Object.values(TRTC_V2_LINES).map((line) => {
    const stations: V2StationDirectionsDto[] = line.stations.map((stationName) => ({
      station: stationName,
      directions: line.supported
        ? getAvailableV2DirectionsForStation(line, stationName)
        : [],
    }));

    return {
      code: line.code,
      name: line.name,
      aliases: line.aliases,
      supported: line.supported,
      ...(line.unsupportedReason ? { unsupportedReason: line.unsupportedReason } : {}),
      stationCount: line.stations.length,
      directions: line.directions,
      stations,
    };
  });
}
