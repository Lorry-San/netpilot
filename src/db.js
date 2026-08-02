import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.env.DB_PATH || '.data/netpilot.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy')),
    os TEXT NOT NULL DEFAULT 'linux',
    arch TEXT NOT NULL DEFAULT 'unknown',
    version TEXT NOT NULL DEFAULT '',
    public_ip TEXT NOT NULL DEFAULT '',
    ip_location TEXT NOT NULL DEFAULT '',
    cpu_percent REAL NOT NULL DEFAULT 0,
    memory_percent REAL NOT NULL DEFAULT 0,
    upload_percent REAL NOT NULL DEFAULT 0,
    download_percent REAL NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_agent_permissions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS tests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    target TEXT NOT NULL,
    port INTEGER NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('tcp', 'udp')),
    reverse INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL,
    parallel INTEGER NOT NULL DEFAULT 1,
    bandwidth TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timeout')),
    started_at TEXT,
    finished_at TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tests_user_idx ON tests(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS test_output (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    stream TEXT NOT NULL,
    line TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS test_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    second REAL NOT NULL,
    send_mbps REAL,
    recv_mbps REAL,
    cpu_percent REAL,
    memory_percent REAL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    target TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL
  );
`);

export function now() {
  return new Date().toISOString();
}

export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
