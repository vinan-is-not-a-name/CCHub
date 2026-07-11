// Read-only debug hook used by the e2e test suite. Activated only when
// `?e2e=1` is in the URL, so production users never see this global.
const E2E_HOOKS = new URLSearchParams(location.search).get('e2e') === '1';

interface TerminalLike {
  term: unknown;
}

export function exposeTerminal(id: string, terminal: TerminalLike): void {
  if (!E2E_HOOKS) return;
  const w = window as unknown as { __cc_terminals?: Record<string, unknown> };
  w.__cc_terminals = w.__cc_terminals ?? {};
  w.__cc_terminals[id] = terminal.term;
}

export function unexposeTerminal(id: string): void {
  if (!E2E_HOOKS) return;
  const w = window as unknown as { __cc_terminals?: Record<string, unknown> };
  if (w.__cc_terminals) delete w.__cc_terminals[id];
}
