import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

let _db: DB | null = null;

export function getDb(): DB {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.');
  return _db;
}

export function initDb(dbPath: string): DB {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  _db = db;
  return db;
}

function runMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version)
  );

  const migrationsDir = join(__dirname, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const insertMigration = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, Date.now());
    })();
    console.log(`[db] applied migration ${file}`);
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
