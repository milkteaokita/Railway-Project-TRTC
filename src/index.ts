/**
 * @module index
 * @description Railway-Project-TRTC — Cloudflare Worker 入口模組。
 * 提供台北捷運 (TRTC) 即時到站 SOAP API 中繼快取、區間車同向合併與動態倒數推算服務。
 */

import { dispatchRequest } from './routes/router';
import type { Env } from './types/env';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return dispatchRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
