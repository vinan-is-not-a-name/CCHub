type StatusHandler = (status: 'connecting' | 'online' | 'offline') => void;
type CloseHandler = (reason: string) => void;

export class Connection<TIn extends { type: string }, TOut extends { type: string }> {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: TIn) => void> = [];
  private statusHandler: StatusHandler = () => {};
  private closeHandlers: Array<CloseHandler> = [];
  private reconnectAttempt = 0;
  private maxReconnect = 5;

  constructor(private url: string) {}

  onMessage(handler: (msg: TIn) => void) { this.handlers.push(handler); }
  onStatus(handler: StatusHandler) { this.statusHandler = handler; }
  /** Fires every time the underlying WebSocket closes (before reconnect logic). */
  onClose(handler: CloseHandler) { this.closeHandlers.push(handler); }

  connect() {
    this.statusHandler('connecting');
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      const token = sessionStorage.getItem('cchub-token') ?? undefined;
      this.send({ type: 'auth', token } as unknown as TOut);
    };
    this.ws.onerror = () => this.statusHandler('offline');
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as TIn;
        for (const fn of this.handlers) fn(msg);
      } catch {}
    };
    this.ws.onclose = (ev) => {
      this.statusHandler('offline');
      const reason = ev.reason || `connection closed (code ${ev.code})`;
      for (const fn of this.closeHandlers) fn(reason);
      if (this.reconnectAttempt < this.maxReconnect) {
        const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 8000);
        this.reconnectAttempt++;
        setTimeout(() => this.connect(), delay);
      }
    };
  }

  send(msg: TOut) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
}
