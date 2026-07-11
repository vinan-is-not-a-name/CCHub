import type { Connection } from './connection.js';
import type { Rpc } from './net/rpc.js';
import type { Store, ClientSession } from './state.js';
import type { Bus } from './bus.js';
import type { ClientMessage, ServerMessage, SafeConfigSnapshot } from '../shared/protocol.js';

export interface AppDeps {
  conn: Connection<ServerMessage, ClientMessage>;
  rpc: Rpc;
  store: Store;
  bus: Bus;
  container: HTMLElement;
}

export type ConfigSnapshot = SafeConfigSnapshot;
export type { ClientSession };
