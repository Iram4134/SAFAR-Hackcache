import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { migrate } from "./migrate.js";

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                       -- NULL = placeholder account that cannot log in
  role TEXT NOT NULL CHECK (role IN ('student','employer')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS student_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  study TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'Srinagar',
  skills TEXT NOT NULL DEFAULT '[]',        -- JSON array
  availability TEXT NOT NULL DEFAULT '[]'   -- JSON array of "Sat-Morning" keys
);
CREATE TABLE IF NOT EXISTS employer_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  town TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL = listing without an employer account
  employer_name TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  type TEXT NOT NULL,
  sector TEXT NOT NULL,
  pay_min INTEGER NOT NULL,
  pay_max INTEGER NOT NULL,
  unit TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  posted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_filter ON jobs(status, type, location, sector);

CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, job_id)
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Applied' CHECK (status IN ('Applied','Shortlisted','Interview','Hired','Rejected')),
  -- snapshot of what the employer saw at the time of applying
  snap_name TEXT NOT NULL,
  snap_location TEXT NOT NULL,
  snap_skills TEXT NOT NULL DEFAULT '[]',
  snap_availability TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (job_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_apps_student ON applications(student_id);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  unread_student INTEGER NOT NULL DEFAULT 0,
  unread_employer INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  UNIQUE (job_id, student_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('s','e','sys')),  -- student / employer / system
  kind TEXT CHECK (kind IN ('interview','offer')),          -- NULL = plain text
  body TEXT NOT NULL,
  slots TEXT,                                               -- JSON, interview cards only
  state TEXT CHECK (state IN ('pending','accepted','declined')),
  pick TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_thread ON messages(thread_id, id);
`);

migrate(db); // upgrades older database files in place (adds admin role, sessions, audit log, ...)

/** Run fn inside a transaction; rolls back on throw. */
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Wipes every table (development helpers only: `npm run seed` and POST /api/dev/reset). */
export const RESET_SQL =
  "PRAGMA foreign_keys = OFF; DELETE FROM audit_log; DELETE FROM sessions; DELETE FROM messages; DELETE FROM threads; DELETE FROM applications; DELETE FROM saved_jobs; DELETE FROM jobs; DELETE FROM employer_profiles; DELETE FROM student_profiles; DELETE FROM users; PRAGMA foreign_keys = ON;";
