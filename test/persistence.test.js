import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { businessBody, studentBody } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "persistence-test-secret-persistence-test-secret";

const freePort = () => new Promise((res) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Start the real server (src/server.js) as a child process, so a "restart" really is a new process. */
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", JWT_SECRET: SECRET, AUTH_RATE_MAX: "1000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start:\n" + log)), 15000);
    const check = setInterval(() => { if (log.includes("SAFAR running")) { clearInterval(check); clearTimeout(timer); resolve(); } }, 50);
    child.on("exit", (c) => { clearInterval(check); clearTimeout(timer); reject(new Error(`server exited early (${c}):\n${log}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const stop = () => new Promise((r) => { child.on("exit", r); child.kill("SIGTERM"); });
  return { api, stop, log: () => log };
}

test("12. accounts, profiles, listings and applications survive a server restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "safar-persist-"));
  const DB_PATH = join(dir, "safar.db");
  const env = { DB_PATH, SEED_DEMO_USERS: "0" };
  try {
    let s = await startServer(env);
    const stu = studentBody(), biz = businessBody();
    const sReg = (await s.api("POST", "/api/auth/register", { body: stu })).body;
    const bReg = (await s.api("POST", "/api/auth/register", { body: biz })).body;
    await s.api("PUT", "/api/profile", { token: sReg.token, body: { study: "B.Com, 1st year", skills: ["Cooking"], availability: ["Mon-Evening"], location: "Anantnag" } });
    await s.api("PUT", "/api/business/profile", { token: bReg.token, body: { description: "Persisted description", phone: "01932 555 0199" } });
    const job = (await s.api("POST", "/api/jobs", {
      token: bReg.token,
      body: { title: "Cook", location: "Anantnag", type: "Part-time", sector: "Food & Beverage", unit: "day", pay: [500, 700], skills: ["Cooking"], schedule: [] },
    })).body.job;
    const app = (await s.api("POST", `/api/jobs/${job.id}/applications`, { token: sReg.token, body: { note: "Please consider me" } })).body.application;
    await s.stop();

    s = await startServer(env);
    const login = await s.api("POST", "/api/auth/login", { body: { email: stu.email, password: stu.password, expectedRole: "student" } });
    assert.equal(login.status, 200, "same password still works after restart");
    const profile = (await s.api("GET", "/api/profile", { token: login.body.token })).body.profile;
    assert.equal(profile.study, "B.Com, 1st year");
    assert.equal(profile.location, "Anantnag");
    assert.deepEqual(profile.skills, ["Cooking"]);
    const mine = (await s.api("GET", "/api/applications/mine", { token: login.body.token })).body.applications;
    assert.equal(mine[0].id, app.id);
    assert.equal(mine[0].note, "Please consider me");

    const blogin = await s.api("POST", "/api/auth/login", { body: { email: biz.email, password: biz.password, expectedRole: "employer" } });
    const bp = (await s.api("GET", "/api/business/profile", { token: blogin.body.token })).body.profile;
    assert.equal(bp.description, "Persisted description");
    assert.equal(bp.phone, "01932 555 0199");
    assert.equal(bp.name, "Chinar Cafe");
    const listings = (await s.api("GET", "/api/employer/jobs", { token: blogin.body.token })).body.jobs;
    assert.equal(listings[0].title, "Cook");
    assert.equal(listings[0].applicants, 1);
    // sessions are stored in the database too, so a token from before the restart still works
    assert.equal((await s.api("GET", "/api/me", { token: sReg.token })).status, 200);
    await s.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADMIN_EMAIL / ADMIN_PASSWORD bootstrap creates one admin; no admin exists otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "safar-admin-"));
  const DB_PATH = join(dir, "safar.db");
  try {
    let s = await startServer({ DB_PATH, SEED_DEMO_USERS: "0" });
    const none = await s.api("POST", "/api/auth/login", { body: { email: "admin@example.test", password: "admin-password-123" } });
    assert.equal(none.status, 401, "no default admin account");
    await s.stop();
    s = await startServer({ DB_PATH, SEED_DEMO_USERS: "0", ADMIN_EMAIL: "Boss@Example.test", ADMIN_PASSWORD: "boss-passphrase-1234" });
    const ok = await s.api("POST", "/api/auth/login", { body: { email: "boss@example.test", password: "boss-passphrase-1234", expectedRole: "admin" } });
    assert.equal(ok.status, 200);
    assert.equal((await s.api("GET", "/api/admin/stats", { token: ok.body.token })).status, 200);
    assert.ok(!s.log().includes("boss-passphrase-1234"), "the password is never logged");
    await s.stop();
    s = await startServer({ DB_PATH, SEED_DEMO_USERS: "0", ADMIN_EMAIL: "boss@example.test", ADMIN_PASSWORD: "different-passphrase-99" });
    assert.equal((await s.api("POST", "/api/auth/login", { body: { email: "boss@example.test", password: "boss-passphrase-1234" } })).status, 200, "restart does not overwrite the password");
    await s.stop();
    // too-short bootstrap password is refused but the server still starts
    s = await startServer({ DB_PATH: join(dir, "other.db"), SEED_DEMO_USERS: "0", ADMIN_EMAIL: "weak@example.test", ADMIN_PASSWORD: "short" });
    assert.equal((await s.api("POST", "/api/auth/login", { body: { email: "weak@example.test", password: "short" } })).status, 401);
    await s.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing database from the original project is upgraded in place without losing data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "safar-legacy-"));
  const DB_PATH = join(dir, "safar.db");
  try {
    // Exactly the original (pre-accounts-upgrade) schema, plus some rows.
    const old = new DatabaseSync(DB_PATH);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT,
        role TEXT NOT NULL CHECK (role IN ('student','employer')), name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE student_profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, study TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT 'Srinagar', skills TEXT NOT NULL DEFAULT '[]', availability TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE employer_profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, company_name TEXT NOT NULL, town TEXT NOT NULL);
      CREATE TABLE jobs (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, employer_name TEXT NOT NULL, title TEXT NOT NULL,
        location TEXT NOT NULL, type TEXT NOT NULL, sector TEXT NOT NULL, pay_min INTEGER NOT NULL, pay_max INTEGER NOT NULL, unit TEXT NOT NULL,
        skills TEXT NOT NULL DEFAULT '[]', schedule TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), posted_at INTEGER NOT NULL);
      CREATE TABLE saved_jobs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, PRIMARY KEY (user_id, job_id));
      CREATE TABLE applications (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Applied' CHECK (status IN ('Applied','Shortlisted','Interview','Hired','Rejected')),
        snap_name TEXT NOT NULL, snap_location TEXT NOT NULL, snap_skills TEXT NOT NULL DEFAULT '[]', snap_availability TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (job_id, student_id));
      CREATE TABLE threads (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, unread_student INTEGER NOT NULL DEFAULT 0,
        unread_employer INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL, UNIQUE (job_id, student_id));
      CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sender TEXT NOT NULL CHECK (sender IN ('s','e','sys')), kind TEXT CHECK (kind IN ('interview','offer')), body TEXT NOT NULL, slots TEXT,
        state TEXT CHECK (state IN ('pending','accepted','declined')), pick TEXT, created_at INTEGER NOT NULL);
    `);
    // The password hash is created with the app's own function so the old user can really log in.
    process.env.DB_PATH = ":memory:";
    process.env.JWT_SECRET = SECRET;
    const { hashPassword } = await import("../src/auth.js");
    const hash = await hashPassword("legacy-password-1");
    const now = Date.now();
    old.prepare("INSERT INTO users VALUES (1,'legacy.student@example.test',?,'student','Legacy Student',?)").run(hash, now);
    old.prepare("INSERT INTO users VALUES (2,'legacy.biz@example.test',?,'employer','Legacy Biz',?)").run(hash, now);
    old.prepare("INSERT INTO student_profiles VALUES (1,'MBA','Jammu','[\"Driving\"]','[\"Sat-Morning\"]')").run();
    old.prepare("INSERT INTO employer_profiles VALUES (2,'Legacy Tours','Katra')").run();
    old.prepare("INSERT INTO jobs VALUES (1,2,'Legacy Tours','Driver','Katra','Gig','Tourism',900,1200,'day','[\"Driving\"]','[\"Sat-Morning\"]','desc','','open',?)").run(now);
    old.prepare("INSERT INTO applications VALUES (1,1,1,'old note','Shortlisted','Legacy Student','Jammu','[\"Driving\"]','[\"Sat-Morning\"]',?,?)").run(now, now);
    old.prepare("INSERT INTO threads VALUES (1,1,1,0,1,?)").run(now);
    old.prepare("INSERT INTO messages VALUES (1,1,'s',NULL,'hello from before',NULL,NULL,NULL,?)").run(now);
    old.prepare("INSERT INTO saved_jobs VALUES (1,1,?)").run(now);
    old.close();

    const s = await startServer({ DB_PATH, SEED_DEMO_USERS: "0" });
    assert.ok(s.log().includes("Backed up existing database"));
    assert.ok(existsSync(DB_PATH + ".pre-v2.bak"), "a backup copy of the old file was written first");
    const login = await s.api("POST", "/api/auth/login", { body: { email: "legacy.student@example.test", password: "legacy-password-1", expectedRole: "student" } });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.profile.study, "MBA");
    const mine = (await s.api("GET", "/api/applications/mine", { token: login.body.token })).body.applications;
    assert.equal(mine[0].status, "Shortlisted");
    assert.equal(mine[0].note, "old note");
    const thread = (await s.api("GET", "/api/threads/1", { token: login.body.token })).body.thread;
    assert.equal(thread.messages[0].t, "hello from before");
    assert.equal((await s.api("GET", "/api/saved", { token: login.body.token })).body.jobs.length, 1);
    const blogin = await s.api("POST", "/api/auth/login", { body: { email: "legacy.biz@example.test", password: "legacy-password-1", expectedRole: "employer" } });
    const bp = (await s.api("GET", "/api/business/profile", { token: blogin.body.token })).body.profile;
    assert.equal(bp.name, "Legacy Tours");
    assert.equal(bp.contactEmail, "", "new business fields start empty for old accounts");
    await s.stop();

    const check = new DatabaseSync(DB_PATH);
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(check.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.deepEqual(check.prepare("SELECT status FROM users").all().map((r) => r.status), ["active", "active"]);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
