import React, { useEffect, useRef, useState } from 'react';
import { PANEL_ID, PANEL_KIND } from '../shared/panel.mjs';
import { PanelController } from './controller.mjs';
import { EmbedAdapter, FRAME_SANDBOX } from './embed-adapter.mjs';
import { OnlinePanelController } from './online.mjs';
import { PanelNavigation, navigateWorkbench } from './navigation.mjs';
import embeddedDocument from '../../../../apps/web/dist-embedded/embedded.html';
import logo from '../../../../apps/web/src/assets/cfkanban-mark.png';

const NS = 'cfkanban.panel';
const en = { title: 'cfKanban', description: 'Read and handle tasks alongside your conversation', openTasks: 'Open cfKanban tasks', embedLocale: 'en', frameReloaded: 'The embedded view navigated away. Close and reopen this tab to load the verified view.', openOnline: 'Open full board in system browser', recoverOnline: 'Recover original online launch', retryOnline: 'Retry Host connection', onlineUncertain: 'Online delivery is retained. Recover the original launch before changing tasks.', onlineDelivered: 'Delivered to the system browser. Verify the online page.', onlineFailed: 'The online page was not confirmed open. You can try again.', onlineUnavailable: 'The original online launch cannot be verified. Check the system browser and restart only after verifying the original action.' };
const zh = { title: 'cfKanban', description: '在对话旁查看和处理任务', openTasks: '打开 cfKanban 任务', embedLocale: 'zh-CN', frameReloaded: '嵌入视图已离开原文档。请关闭并重新打开此 Tab，加载已核验的视图。', openOnline: '在系统浏览器打开完整看板', recoverOnline: '核实恢复原在线投递', retryOnline: '重试宿主连接', onlineUncertain: '宿主保留了原在线投递，请先核实恢复，再切换或修改任务。', onlineDelivered: '已交付系统浏览器，请核对在线页面。', onlineFailed: '未确认在线页面已打开，可以再次尝试。', onlineUnavailable: '无法核实原在线投递，请检查系统浏览器，确认原操作后再重新打开视图。' };

export function PanelBody({ rpc, navigation, useTabInfo, sessionId, t }) {
  const { tab } = useTabInfo();
  const frame = useRef(null);
  const [frameFailed, setFrameFailed] = useState(false);
  const [sourceSessionId] = useState(sessionId);
  const [controller] = useState(() => new PanelController(rpc, tab.signal));
  const [adapter] = useState(() => new EmbedAdapter(controller, sourceSessionId));
  const [online] = useState(() => new OnlinePanelController(controller));
  const [onlineState, setOnlineState] = useState(online.getSnapshot);
  const [canOpenOnline, setCanOpenOnline] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const initialization = useRef(null);
  const currentTab = useRef(tab);
  currentTab.current = tab;
  const locale = t('embedLocale') === 'en' ? 'en' : 'zh-CN';
  useEffect(() => {
    const update = () => {
      setOnlineState(online.getSnapshot());
      setCanOpenOnline(Boolean(controller.state.binding && !controller.state.pending && !controller.state.busy));
    };
    const stopOnline = online.subscribe(update);
    const stopController = controller.subscribe(update);
    initialization.current = online.initialize().then(ready => {
      const id = currentTab.current.navigation?.params?.navigation_request_id;
      if (ready && !online.blocked && !navigation.has(id, sourceSessionId)) return controller.bootstrap(sourceSessionId);
    });
    return () => { stopOnline(); stopController(); online.dispose(); adapter.dispose(); controller.dispose(); };
  }, [controller, adapter, online, navigation, sourceSessionId]);
  useEffect(() => { controller.sessionContext(sessionId); }, [controller, sessionId]);
  useEffect(() => {
    const id = tab.navigation?.params?.navigation_request_id;
    if (!id || !tab.visible) return;
    const held = navigation.claim(id, sourceSessionId);
    if (!held) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([held.signal, tab.signal, lifetime.signal]);
    setNavigating(true);
    void (async () => {
      try {
        await initialization.current;
        const result = await navigateWorkbench({ controller, online, adapter, request: held.request, signal,
          isCurrent: () => currentTab.current.visible && currentTab.current.navigation?.params?.navigation_request_id === id && navigation.current(sourceSessionId) });
        held.finish(result);
      } catch { held.finish({ ok: false, error: { code: 'PANEL_NAVIGATION_UNAVAILABLE' } }); }
      finally { setNavigating(false); }
    })();
    return () => lifetime.abort();
  }, [navigation, controller, adapter, online, sourceSessionId, tab.navigation?.revision, tab.visible, tab.signal]);
  useEffect(() => tab.actions.bindCommands({ refresh: () => navigating ? undefined : controller.state.issue ? controller.openIssue(controller.state.issue.identifier) : controller.refresh() }), [controller, tab.actions, navigating]);
  useEffect(() => { adapter.setLocale(locale); }, [adapter, locale]);
  if (frameFailed) return <p role="alert" style={{ padding: 12 }}>{t('frameReloaded')}</p>;
  const blocked = navigating || !onlineState.ready || onlineState.active || onlineState.running || Boolean(onlineState.pending_target);
  const message = onlineState.error === 'PANEL_ONLINE_RECOVERY_UNAVAILABLE' ? 'onlineUnavailable' : onlineState.pending_target ? 'onlineUncertain' : onlineState.phase === 'delivered' ? 'onlineDelivered' : onlineState.phase === 'failed' ? 'onlineFailed' : null;
  const onlineLabel = t(!onlineState.ready ? 'retryOnline' : onlineState.pending_target ? 'recoverOnline' : 'openOnline');
  const openOnline = async () => {
    await online.open();
    if (!online.blocked && !controller.state.binding) await controller.bootstrap(sourceSessionId);
  };
  return <section style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
    <div style={{ padding: '6px 8px', flex: 'none', borderBottom: '1px solid #DCE3EC', color: '#243247', fontFamily: 'system-ui', fontSize: 12, textAlign: 'right' }}>
      <button type="button" onClick={openOnline} title={onlineLabel} aria-label={onlineLabel} disabled={navigating || onlineState.active || onlineState.running || (onlineState.ready && !onlineState.pending_target && !canOpenOnline)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, border: '1px solid #DCE3EC', borderRadius: 8, background: '#fff', color: '#C2410C', padding: 6, cursor: 'pointer' }}>
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          {!onlineState.ready || onlineState.pending_target ? <path d="M16 5v4h-4M16 9a6 6 0 1 0 .1 3M16 9l-3-3" /> : <path d="M11 3h6v6M17 3l-8 8M8 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4" />}
        </svg>
      </button>
      {message ? <p role="status" style={{ margin: '6px 0 0', lineHeight: 1.4, textAlign: 'left' }}>{t(message)}</p> : null}
    </div>
    <iframe
    ref={frame}
    title={t('title')}
    srcDoc={embeddedDocument}
    sandbox={FRAME_SANDBOX}
    inert={blocked ? '' : undefined}
    aria-busy={onlineState.active || onlineState.running}
    referrerPolicy="no-referrer"
    style={{ display: 'block', border: 0, width: '100%', flex: 1, minHeight: 0 }}
    onLoad={() => { if (!adapter.frameLoaded(frame.current, locale)) setFrameFailed(true); }}
  /></section>;
}

export function PanelButton({ open, navigation, sessionId, t }) {
  useEffect(() => navigation.connect(sessionId), [navigation, sessionId]);
  return <button type="button" onClick={open} aria-label={t('openTasks')} title={t('openTasks')} style={{ padding: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, background: 'transparent', cursor: 'pointer' }}><img src={logo} width={22} height={22} alt="" /></button>;
}

export const inject = ['connection', 'slots', 'sidebarRightTabs', 'sidebarRight', 'locale'];
export function apply(ctx) {
  const t = ctx.locale.bind(NS);
  const navigation = new PanelNavigation(ctx.connection.rpc, ctx.sidebarRight);
  ctx.effect(() => ctx.locale.register(NS, { en, zh }));
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: PANEL_ID, kind: PANEL_KIND, title: () => t('title'), keepMounted: true, guide: [{ id: 'tasks', order: 40, title: () => t('title'), description: () => t('description') }] }));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: NS, inject: () => ({ rpc: ctx.connection.rpc, navigation }) }, PanelBody)));
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: PANEL_ID, order: 40, locale: NS, inject: () => ({ open: () => ctx.sidebarRight.openTab(PANEL_KIND), navigation }) }, PanelButton)));
}
