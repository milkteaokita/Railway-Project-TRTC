/**
 * @module routes/router
 * @description 宣告式 HTTP 路由註冊表與處理器。
 *
 * 設計重點：
 * - 每個路由皆附帶清楚的用途說明 (`summary`) 與呼叫範例 (`example`)，根路徑 `GET /` 會自動輸出完整服務身分與端點清單。
 * - 未來欲擴充新功能（如車廂擁擠度、首末班車或其他軌道系統），只需新增 Handler 並註冊於 `ROUTE_DEFINITIONS` 即可。
 */

import { SnapshotCacheManager } from '../cache/snapshot-cache';
import { SERVICE_METADATA, resolveRuntimeConfig } from '../config/constants';
import { O_LINE_SHARED_TRUNK_MERGE_STATIONS, TRTC_LINES } from '../config/trtc-network';
import { TrtcSoapProvider } from '../providers/trtc-soap.provider';
import { ArrivalService } from '../services/arrival.service';
import type { Env, RuntimeConfig } from '../types/env';
import { AppError, buildCommonHeaders, errorResponse, jsonResponse } from '../utils/http';

export interface RouteContext {
  request: Request;
  url: URL;
  env: Env;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
  config: RuntimeConfig;
}

export interface RouteDefinition {
  method: 'GET';
  path: string;
  summary: string;
  example: string;
  handler: (ctx: RouteContext) => Promise<Response> | Response;
}

/**
 * 處理 `GET /`：回傳服務公開身分資訊、支援路線摘要與可用 API 端點導覽
 */
function handleServiceOverview(ctx: RouteContext): Response {
  const supportedLines = Object.values(TRTC_LINES)
    .filter((line) => line.supported)
    .map((line) => ({
      code: line.code,
      name: line.name,
      terminals: line.directions.map((d) => d.terminal),
    }));

  return jsonResponse(
    {
      ok: true,
      service: SERVICE_METADATA,
      supportedLines,
      endpoints: ROUTE_DEFINITIONS.map((r) => ({
        method: r.method,
        path: r.path,
        summary: r.summary,
        example: r.example,
      })),
    },
    200,
    ctx.config.corsAllowOrigin,
  );
}

/**
 * 處理 `GET /health`：健康狀態與必要環境變數就緒檢查（絕不洩漏真實憑證內容）
 */
function handleHealthCheck(ctx: RouteContext): Response {
  const hasUrl = Boolean(ctx.env.TRTC_API_URL?.trim());
  const hasUsername = Boolean(ctx.env.TRTC_API_USERNAME?.trim());
  const hasPassword = Boolean(ctx.env.TRTC_API_PASSWORD?.trim());
  const credentialsReady = hasUrl && hasUsername && hasPassword;

  return jsonResponse(
    {
      ok: credentialsReady,
      service: SERVICE_METADATA.name,
      version: SERVICE_METADATA.version,
      timestamp: new Date().toISOString(),
      upstreamCredentialsConfigured: credentialsReady,
      runtimeConfig: {
        cacheMaxAgeSeconds: ctx.config.cacheMaxAgeSeconds,
        arrivingDefaultSeconds: ctx.config.arrivingDefaultSeconds,
        minRefetchIntervalSeconds: ctx.config.minRefetchIntervalSeconds,
        upstreamTimeoutMs: ctx.config.upstreamTimeoutMs,
      },
    },
    credentialsReady ? 200 : 503,
    ctx.config.corsAllowOrigin,
    { 'Cache-Control': 'no-store' },
  );
}

/**
 * 處理 `GET /api/lines`：輸出目前開放支援之北捷路線、車站清單、終點方向與區間車合併規則
 */
function handleListLines(ctx: RouteContext): Response {
  const lines = Object.values(TRTC_LINES).map((line) => ({
    code: line.code,
    name: line.name,
    aliases: line.aliases,
    supported: line.supported,
    ...(line.unsupportedReason ? { unsupportedReason: line.unsupportedReason } : {}),
    stationCount: line.stations.length,
    stations: line.stations,
    directions: line.directions.map((dir) => ({
      terminal: dir.terminal,
      description: dir.description,
      shortTurnDestinations: dir.shortTurnDestinations,
      ...(dir.shortTurnApplicableStations
        ? {
            shortTurnApplicableStations: [...O_LINE_SHARED_TRUNK_MERGE_STATIONS],
          }
        : {}),
    })),
  }));

  return jsonResponse(
    {
      ok: true,
      system: 'TRTC',
      lines,
    },
    200,
    ctx.config.corsAllowOrigin,
    { 'Cache-Control': 'public, max-age=3600' },
  );
}

/**
 * 處理 `GET /api/arrivals`：核心北捷即時到站查詢（含區間車合併與動態快取秒數推算）
 */
async function handleQueryArrivals(ctx: RouteContext): Promise<Response> {
  const provider = new TrtcSoapProvider({
    apiUrl: ctx.env.TRTC_API_URL,
    username: ctx.env.TRTC_API_USERNAME,
    password: ctx.env.TRTC_API_PASSWORD,
    arrivingDefaultSeconds: ctx.config.arrivingDefaultSeconds,
    timeoutMs: ctx.config.upstreamTimeoutMs,
  });

  const cacheManager = new SnapshotCacheManager(provider, {
    executionCtx: ctx.executionCtx,
  });

  const arrivalService = new ArrivalService({
    cacheManager,
    config: ctx.config,
  });

  const searchParams = ctx.url.searchParams;
  const result = await arrivalService.queryArrivals({
    line: searchParams.get('line'),
    station: searchParams.get('station'),
    dest: searchParams.get('dest'),
    includeShortTurn: searchParams.get('includeShortTurn'),
  });

  // 對外 HTTP Response 設為 no-store，確保每次呼叫皆由 Worker 即時計算最新 remainingSeconds
  return jsonResponse(result, 200, ctx.config.corsAllowOrigin, {
    'Cache-Control': 'no-store',
  });
}

/**
 * 全域路由註冊表
 */
export const ROUTE_DEFINITIONS: readonly RouteDefinition[] = [
  {
    method: 'GET',
    path: '/',
    summary: '服務身分說明、支援路線概覽與 API 端點導覽',
    example: '/',
    handler: handleServiceOverview,
  },
  {
    method: 'GET',
    path: '/health',
    summary: '服務健康檢查與環境變數設定狀態確認',
    example: '/health',
    handler: handleHealthCheck,
  },
  {
    method: 'GET',
    path: '/api/lines',
    summary: '取得台北捷運支援路線、車站清單與區間車合併規則設定',
    example: '/api/lines',
    handler: handleListLines,
  },
  {
    method: 'GET',
    path: '/api/arrivals',
    summary: '查詢指定路線、車站與終點方向之即時列車到站倒數（支援同向區間車合併）',
    example: '/api/arrivals?line=R&station=大安&dest=淡水&includeShortTurn=true',
    handler: handleQueryArrivals,
  },
];

/**
 * 主路由派發函式
 */
export async function dispatchRequest(
  request: Request,
  env: Env,
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const config = resolveRuntimeConfig(env);

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCommonHeaders(config.corsAllowOrigin),
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new AppError(405, 'METHOD_NOT_ALLOWED', `不支援 HTTP 方法 ${request.method}，請使用 GET`);
    }

    const url = new URL(request.url);
    const normalizedPath =
      url.pathname.length > 1 && url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname;

    const matchedRoute = ROUTE_DEFINITIONS.find((r) => r.path === normalizedPath);
    if (!matchedRoute) {
      throw new AppError(404, 'ROUTE_NOT_FOUND', `找不到路由路徑「${url.pathname}」`, {
        availableEndpoints: ROUTE_DEFINITIONS.map((r) => r.path),
      });
    }

    const response = await matchedRoute.handler({
      request,
      url,
      env,
      executionCtx,
      config,
    });

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  } catch (err) {
    return errorResponse(err, config.corsAllowOrigin);
  }
}
