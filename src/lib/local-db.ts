import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { D1Binding, D1Statement, D1Result } from './db';

export function openLocalDatabase(directory: string) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'crm.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  class Statement implements D1Statement {
    constructor(readonly sql: string, readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values); }
    async all(): Promise<D1Result> { return execute(this); }
  }
  function execute(statement: Statement): D1Result {
    const results = db.prepare(statement.sql).all(...statement.values as any[]);
    const changes = Number((db.prepare('SELECT changes() AS n').get() as {n:number}).n);
    return { success: true, results: results as Record<string, unknown>[], meta: { changes } };
  }
  const binding: D1Binding = {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: D1Statement[]) {
      db.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s => execute(s as Statement)); db.exec('COMMIT'); return results; }
      catch(error) { db.exec('ROLLBACK'); throw error; }
    },
    withSession() { return binding; },
  };
  async function migrate() {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    for (const name of readdirSync(path.join(process.cwd(), 'migrations/d1')).filter(n => n.endsWith('.sql')).sort()) {
      const version = Number(name.split('_')[0]);
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) continue;
      db.exec('BEGIN IMMEDIATE');
      try { db.exec(readFileSync(path.join(process.cwd(), 'migrations/d1', name), 'utf8')); db.exec('COMMIT'); }
      catch(error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  return { binding, migrate, close() { db.close(); } };
}
