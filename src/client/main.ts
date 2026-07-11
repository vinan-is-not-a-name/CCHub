import '@xterm/xterm/css/xterm.css';
import { Connection } from './connection.js';
import { Bus } from './bus.js';
import { createStore } from './state.js';
import { Rpc } from './net/rpc.js';
import { applyDomI18n } from './i18n.js';
import { mountTopbar } from './views/topbar.js';
import { mountRail } from './views/rail.js';
import { mountSessionView } from './views/session/index.js';
import { mountLayoutToggle } from './views/layoutToggle.js';
import { mountLaunchDialog } from './views/launchDialog.js';
import { mountConfigDialog } from './views/configDialog.js';
import { mountSettingsDialog } from './views/settingsDialog.js';
import { mountToastHost } from './views/toast.js';
import { mountDirectoryDialog } from './views/directoryDialog.js';
import { mountNotifications } from './views/notify.js';

import { mountResourceMonitor } from './views/resourceMonitor.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

scrubTokenQuery();
applyDomI18n();
const params = new URLSearchParams(location.search);
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const conn = new Connection<ServerMessage, ClientMessage>(wsUrl);
const bus = new Bus();
const store = createStore();
const rpc = new Rpc(conn);
const container = document.getElementById('terminal-container')!;

const deps = { conn, rpc, store, bus, container };

mountTopbar(deps);
mountRail(deps);
mountDirectoryDialog(deps);
mountLaunchDialog(deps, params);
mountConfigDialog(deps);
mountSettingsDialog(deps);
mountToastHost(deps);
const notify = mountNotifications(deps);
mountSessionView(deps, params, notify);
mountLayoutToggle(deps);
mountResourceMonitor(deps);

// Pump every server message through the RPC matcher first; views subscribe to
// their own messages via deps.conn.onMessage.
conn.onMessage((msg) => { rpc.dispatch(msg); });

// Reject every in-flight RPC when the WS closes so launch widgets fall out of
// "Loading..." instead of hanging forever.
conn.onClose((reason) => rpc.cancelAll(reason));

conn.connect();

function scrubTokenQuery() {
  const url = new URL(location.href);
  const token = url.searchParams.get('token');
  if (!token) return;
  sessionStorage.setItem('cchub-token', token);
  url.searchParams.delete('token');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
