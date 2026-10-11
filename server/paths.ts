import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Resolves links, so a project linked into workplace/projects matches the real paths Claude Code reports.
// A file that doesn't exist yet is resolved through its nearest existing parent folder.
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realPath(parent), basename(p));
  }
}
