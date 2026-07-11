/* Minimal logger facade. Stays tiny on purpose — swap the implementation here
 * if a structured logger is ever needed. */
export const logger = {
  info(...args: unknown[]) { console.log(...args); },
  warn(...args: unknown[]) { console.warn(...args); },
  error(...args: unknown[]) { console.error(...args); },
};
