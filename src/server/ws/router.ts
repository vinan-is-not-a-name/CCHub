import { ClientMessage } from '../../shared/protocol.js';
import { WsCtx } from './connection.js';
import { handleSessionMessage } from './handlers/session.js';
import { handleConfigMessage } from './handlers/config.js';
import { handleLaunchMessage } from './handlers/launch.js';
import { handleShellMessage } from './handlers/shell.js';

/** Route an authenticated client message to the right handler. */
export function dispatch(ctx: WsCtx, msg: ClientMessage): void {
  switch (msg.type) {
    case 'input':
    case 'resize':
    case 'session.create':
    case 'session.attach':
    case 'session.destroy':
    case 'session.reorder':
    case 'session.list':
      handleSessionMessage(ctx, msg);
      return;
    case 'shell.reveal':
      handleShellMessage(ctx, msg);
      return;
    case 'config.get':
    case 'config.profile.save':
    case 'config.profile.delete':
    case 'config.profile.copy':
    case 'config.server.save':
    case 'config.server.delete':
    case 'config.server.copy':
    case 'config.preset.save':
    case 'config.preset.delete':
    case 'config.preset.copy':
    case 'config.proxy.save':
    case 'config.proxy.delete':
    case 'config.proxy.copy':
    case 'config.settings.save':
    case 'config.settings.detect':
    case 'launch.recent.forget':
    case 'launch.recent.clear':
      handleConfigMessage(ctx, msg);
      return;
    case 'config.profile.test':
    case 'launch.cwd.list':
    case 'launch.conda.list':
      handleLaunchMessage(ctx, msg);
      return;
  }
}
