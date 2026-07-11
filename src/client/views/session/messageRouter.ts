import type { ServerMessage } from '../../../shared/protocol.js';
import type { AppDeps } from '../../deps.js';
import type { AttachController } from './attach.js';
import { notifyImageFed } from '../imageLinks.js';
import { showAppToast } from '../toast.js';
import type { NotifyKind } from '../notify.js';

export interface NotifyHandle {
  fire(id: string, kind: NotifyKind): void;
}

/** Dispatch a server message to store updates and the attach controller. */
export function makeMessageRouter(deps: AppDeps, attach: AttachController, openLaunchDialog: () => void, notify?: NotifyHandle) {
  return (msg: ServerMessage): void => {
    switch (msg.type) {
      case 'auth.ok':
        deps.conn.send({ type: 'config.get' });
        deps.conn.send({ type: 'session.list' });
        return;
      case 'config.profile.saved':
      case 'config.server.saved':
      case 'config.preset.saved':
      case 'config.proxy.saved':
      case 'config.snapshot':
        deps.store.set('config', msg.config);
        return;
      case 'session.list':
        if (msg.sessions.length === 0) {
          openLaunchDialog();
        } else {
          for (const info of msg.sessions) attach.addSession(info);
          const firstId = msg.sessions[0].id;
          attach.activate(firstId, false);
          for (const info of msg.sessions) {
            deps.conn.send({ type: 'session.attach', id: info.id, focus: info.id === firstId, history: true });
          }
        }
        return;
      case 'session.created':
        deps.store.set('creatingSession', false);
        attach.addSession(msg.session);
        attach.activate(msg.session.id);
        return;
      case 'session.attached': {
        const s = deps.store.get().sessions.get(msg.session.id);
        if (s) {
          if (!s.attached) {
            if (msg.snapshot) s.terminal.loadSnapshot(msg.snapshot);
            deps.store.updateSession(msg.session.id, { attached: true });
          }
          // Align state-tracking consumers (notify pipeline) to the server's
          // attested state before patchSessionInfo triggers store subscribers.
          deps.bus.emit('session:resync', { id: msg.session.id, state: msg.session.state });
          deps.store.patchSessionInfo(msg.session.id, msg.session);
        }
        return;
      }
      case 'output': {
        const s = deps.store.get().sessions.get(msg.id);
        if (s) s.terminal.write(msg.data);
        return;
      }
      case 'image.fed':
        notifyImageFed(msg.id, msg.imageIndex);
        return;
      case 'notify.hook':
        notify?.fire(msg.id, hookKindToNotifyKind(msg.kind));
        return;
      case 'state':
        deps.store.setSessionState(msg.id, msg.state);
        return;
      case 'session.exit':
        deps.store.setSessionState(msg.id, 'exited');
        deps.store.set('creatingSession', false);
        return;
      case 'session.destroyed':
        attach.removeSession(msg.id);
        return;
      case 'error':
        deps.store.set('creatingSession', false);
        deps.store.patchUi({ preserveLaunchValues: true });
        console.error('server error:', msg.message);
        showAppToast(msg.message, 'error');
        if (msg.code !== 'UNAUTHORIZED' && msg.code !== 'CONFIG_ERROR' && deps.store.get().sessions.size === 0) openLaunchDialog();
        return;
    }
  };
}

function hookKindToNotifyKind(kind: string): NotifyKind {
  return kind === 'notification' ? 'approval' : 'ready';
}
