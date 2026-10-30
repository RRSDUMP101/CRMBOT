/** Static guard for Cloudflare D1 limits that local SQLite does not enforce. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(full)); else if (/\.(ts|tsx|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no SQL text exceeds the D1 limit of five compound SELECT terms', async () => {
  const offenders: string[] = [];
  for (const file of [...await files('src'), ...await files('cloudflare'), ...await files('migrations/d1')]) {
    const source = await readFile(file, 'utf8');
    const chunks = file.endsWith('.sql') ? source.split(';') : source.match(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g) ?? [];
    for (const chunk of chunks) if ((chunk.match(/\bUNION\b/gi) ?? []).length > 4) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
