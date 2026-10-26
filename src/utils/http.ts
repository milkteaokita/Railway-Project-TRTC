/**
 * @module utils/http
 * @description 標準化 HTTP JSON 回應、CORS 標頭與應用程式結構化錯誤封裝。
 */

import { SERVICE_METADATA } from '../config/constants';

/**
 * 可攜帶 HTTP 狀態碼與語意化錯誤代碼的應用程式例外類別
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: unknown;

  constructor(statusCode: number, errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

/**
 * 產生標準 CORS 與服務識別標頭
 */
export function buildCommonHeaders(corsAllowOrigin = '*'): HeadersInit {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': corsAllowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'X-Service-Name': SERVICE_METADATA.name,
    'X-Service-Version': SERVICE_METADATA.version,
  };
}

/**
 * 建立統一格式的 JSON Response
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  corsAllowOrigin = '*',
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...buildCommonHeaders(corsAllowOrigin),
      ...extraHeaders,
    },
  });
}

/**
 * 建立統一格式的錯誤 JSON Response
 */
export function errorResponse(
  error: unknown,
  corsAllowOrigin = '*',
): Response {
  if (error instanceof AppError) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: error.errorCode,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
      error.statusCode,
      corsAllowOrigin,
      { 'Cache-Control': 'no-store' },
    );
  }

  const message = error instanceof Error ? error.message : '未預期的伺服器內部錯誤';
  return jsonResponse(
    {
      ok: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message,
      },
    },
    500,
    corsAllowOrigin,
    { 'Cache-Control': 'no-store' },
  );
}
