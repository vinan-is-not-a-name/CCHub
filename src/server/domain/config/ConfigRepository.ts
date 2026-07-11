import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { StoredConfig } from './schema.js';

export interface ConfigRepository {
  /** True when the repository found nothing on disk and a fresh default was just persisted. */
  loadOrCreate(initial: () => StoredConfig): { data: StoredConfig; created: boolean };
  save(data: StoredConfig): void;
}

export class FileConfigRepository implements ConfigRepository {
  constructor(private readonly filePath: string) {}

  loadOrCreate(initial: () => StoredConfig) {
    if (!existsSync(this.filePath)) {
      const data = initial();
      this.save(data);
      return { data, created: true };
    }
    const data = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredConfig;
    return { data, created: false };
  }

  save(data: StoredConfig): void {
    this.ensureDir();
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.filePath);
    try { chmodSync(this.filePath, 0o600); } catch {}
  }

  private ensureDir() {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.filePath), 0o700); } catch {}
  }
}
