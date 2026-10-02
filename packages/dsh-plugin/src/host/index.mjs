import { PanelBridge } from './bridge.mjs';
import { PanelError } from '../shared/panel.mjs';
import { clientRequestSchema, serverResponseSchema, RpcId } from '@deepseek-ai/dsh-client-connection';
import { registerPanelTransport } from './transport.mjs';

export const name = 'cfkanban-panel';
export const inject = ['connection', 'workspaceRegistry', 'sessionController', 'webServer'];

export async function apply(ctx, config = {}) {
  let createFacade;
  try {
    const foundation = await import('../../mcp/facade.mjs');
    if (typeof foundation.createMcpFacade !== 'function') throw new Error('incompatible foundation');
    createFacade = foundation.createMcpFacade;
  } catch {
    createFacade = () => { throw new PanelError('PANEL_FOUNDATION_UNAVAILABLE', 'Install or rebuild the complete matching cfKanban plugin in this Host environment.'); };
  }
  const bridge = new PanelBridge({
    createFacade,
    host: { singleUserLocal: config.singleUserLocal, hasWebServer: true, webHost: ctx.webServer.host, operator: ctx.connection.operator },
    sessionContext: {
      workspaces: () => ctx.workspaceRegistry.list(),
      workspace: id => ctx.workspaceRegistry.get(id),
      inspect: (id, signal) => ctx.sessionController.inspect(id, signal),
    },
  });
  ctx.effect(() => () => bridge.dispose());
  registerPanelTransport(ctx, bridge, { clientRequestSchema, serverResponseSchema, RpcId });
}
