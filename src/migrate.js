import { copyFileSync, existsSync } from "node:fs";
import { config } from "./config.js";

/**
 * Versioned, additive schema migrations driven by PRAGMA user_version.
 *  v0/v1  baseline tables (created by db.js with CREATE TABLE IF NOT EXISTS; this is what the original
 *         project shipped with)
 *  v2     accounts: admin role + account status, server-side sessions, business contact fields,
 *         audit log and extra indexes
 * Existing rows are copied, never dropped. Before the first upgrade of a non-empty file database a
 * copy is written next to it (safar.db.pre-v2.bak) so the change can be rolled back by hand.
 */
export const LATEST_VERSION = 2;

const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

function migrateToV2(db) {
  // users: the role CHECK constraint has to change (adds 'admin'), which SQLite can only do by rebuilding
  // the table. This follows the official procedure: foreign keys off, copy, drop, rename, verify.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE users_v2 (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT,                       -- NULL = placeholder account that cannot log in
          role TEXT NOT NULL CHECK (role IN ('student','employer','admin')),
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT 0,
          last_login_at INTEGER
        );
        INSERT INTO users_v2 (id, email, password_hash, role, name, status, created_at, updated_at)
          SELECT id, email, password_hash, role, name, 'active', created_at, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_v2 RENAME TO users;
      `);
      if (!hasColumn(db, "employer_profiles", "contact_email"))
        db.exec("ALTER TABLE employer_profiles ADD COLUMN contact_email TEXT NOT NULL DEFAULT ''");
      if (!hasColumn(db, "employer_profiles", "phone"))
        db.exec("ALTER TABLE employer_profiles ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
      if (!hasColumn(db, "employer_profiles", "description"))
        db.exec("ALTER TABLE employer_profiles ADD COLUMN description TEXT NOT NULL DEFAULT ''");
      if (!hasColumn(db, "employer_profiles", "updated_at"))
        db.exec("ALTER TABLE employer_profiles ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "student_profiles", "updated_at"))
        db.exec("ALTER TABLE student_profiles ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,                       -- random id carried in the signed token (jti)
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY,
          admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          admin_email TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id INTEGER,
          detail TEXT NOT NULL DEFAULT '',           -- short human text; never passwords or tokens
          ip TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
        CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
        CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
        CREATE INDEX IF NOT EXISTS idx_threads_job ON threads(job_id);
      `);
      const bad = db.prepare("PRAGMA foreign_key_check").all();
      if (bad.length) throw new Error("Migration v2 left dangling foreign keys: " + JSON.stringify(bad.slice(0, 3)));
      db.exec("PRAGMA user_version = 2");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function migrate(db) {
  let version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= LATEST_VERSION) return version;
  if (config.dbPath !== ":memory:" && existsSync(config.dbPath) && db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) {
    const backup = `${config.dbPath}.pre-v2.bak`;
    if (!existsSync(backup)) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(config.dbPath, backup);
      console.log(`[migrate] Backed up existing database to ${backup}`);
    }
  }
  if (version < 2) migrateToV2(db);
  version = db.prepare("PRAGMA user_version").get().user_version;
  console.log(`[migrate] Database schema is at version ${version}`);
  return version;
}
