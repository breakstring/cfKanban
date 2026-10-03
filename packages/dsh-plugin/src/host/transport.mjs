import { PANEL_CHANNEL, PANEL_NAMESPACE, WORKBENCH_ENDPOINTS, ONLINE_PANEL_ENDPOINTS } from '../shared/panel.mjs';
import { NAVIGATION_ENDPOINTS } from './navigation.mjs';

export const PANEL_ENDPOINTS = Object.freeze([...WORKBENCH_ENDPOINTS, ...ONLINE_PANEL_ENDPOINTS, ...NAVIGATION_ENDPOINTS]);
const MAX_REQUEST_BYTES = 1024 * 1024;

export function registerPanelTransport(ctx, bridge, { clientRequestSchema, serverResponseSchema, RpcId }, navigation) {
  const respond = (rpcId, result) => Response.json(serverResponseSchema.parse({ type: 'server-response', rpcId, result }), { headers: { 'cache-control': 'no-store' } });
  const invalid = rpcId => respond(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid cfKanban panel RPC request.', details: {} } });
  for (const endpoint of PANEL_ENDPOINTS) ctx.effect(() => ctx.connection.fetch.register({
    path: `${PANEL_CHANNEL}/${PANEL_NAMESPACE}/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== `${PANEL_CHANNEL}/${PANEL_NAMESPACE}/${endpoint}`) return new Response(null, { status: 404 });
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response(null, { status: 415 });
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) return new Response(null, { status: 413 });
      let body;
      try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
      const envelope = clientRequestSchema.safeParse(body);
      if (!envelope.success) return invalid(RpcId('invalid-request'));
      const message = envelope.data;
      if (message.method !== `${PANEL_NAMESPACE}/${endpoint}`) return invalid(message.rpcId);
      // Exact Fetch routes run behind Connection's existing /api admission and
      // request-lifetime bridge. The panel never creates an authentication carrier.
      const handler = NAVIGATION_ENDPOINTS.includes(endpoint) ? navigation : bridge;
      const value = handler ? await handler.call(endpoint, message.payload, request.signal, ctx.connection.operator) : { ok: false, error: { code: 'PANEL_NAVIGATION_UNAVAILABLE', message: 'The cfKanban navigation service is unavailable.' } };
      return respond(message.rpcId, { ok: true, value });
    },
  }));
}
