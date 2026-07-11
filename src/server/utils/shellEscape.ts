/**
 * POSIX single-quote escaping for shell command construction. Lives in utils so
 * both the core shell layer and the infrastructure layer can depend on it
 * without crossing into each other.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
