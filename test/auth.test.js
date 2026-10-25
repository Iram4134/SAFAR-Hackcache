import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { SECRET, businessBody, startApp, studentBody, uniqueEmail } from "./helpers.js";

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const forge = (payload, secret = SECRET, alg = "HS256") => {
  const head = b64u({ alg, typ: "JWT" }), body = b64u(payload);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
};

test("1. a new student can register and log in", async () => {
  const body = studentBody();
  const reg = await t.api("POST", "/api/auth/register", { body });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.role, "student");
  assert.ok(reg.body.token);
  assert.equal("password_hash" in reg.body.user, false);
  const login = await t.api("POST", "/api/auth/login", { body: { email: body.email, password: body.password, expectedRole: "student" } });
  assert.equal(login.status, 200);
  const me = await t.api("GET", "/api/me", { token: login.body.token });
  assert.equal(me.body.user.email, body.email);
  assert.equal(me.body.user.profile.location, "Srinagar");
});

test("2. a new business can register and log in, and has a business profile", async () => {
  const body = businessBody();
  const reg = await t.api("POST", "/api/auth/register", { body });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.role, "employer");
  assert.equal(reg.body.user.company.name, "Chinar Cafe");
  const login = await t.api("POST", "/api/auth/login", { body: { email: body.email, password: body.password, expectedRole: "employer" } });
  assert.equal(login.status, 200);
  const prof = await t.api("GET", "/api/business/profile", { token: login.body.token });
  assert.equal(prof.body.profile.contactEmail, body.email, "business email defaults to the account email");
  assert.equal(prof.body.profile.phone, "+91 99060 12345");
});

test("registration validation, no plaintext passwords, and admin sign-up is impossible", async () => {
  const bad = await t.api("POST", "/api/auth/register", { body: { email: "nope", password: "short", role: "student", name: "" } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details.email && bad.body.error.details.password && bad.body.error.details.name);
  const noCompany = await t.api("POST", "/api/auth/register", { body: { ...businessBody(), companyName: "" } });
  assert.equal(noCompany.status, 422);
  const admin = await t.api("POST", "/api/auth/register", { body: studentBody({ role: "admin" }) });
  assert.equal(admin.status, 422);
  const email = uniqueEmail("hash");
  await t.api("POST", "/api/auth/register", { body: studentBody({ email, password: "plain-text-check-9" }) });
  const { db } = await import("../src/db.js");
  const row = db.prepare("SELECT password_hash FROM users WHERE email=?").get(email);
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes("plain-text-check-9"));
});

test("3. duplicate registration is rejected (case-insensitive)", async () => {
  const body = studentBody();
  assert.equal((await t.api("POST", "/api/auth/register", { body })).status, 201);
  const again = await t.api("POST", "/api/auth/register", { body: { ...body, email: body.email.toUpperCase() } });
  assert.equal(again.status, 409);
  const asBusiness = await t.api("POST", "/api/auth/register", { body: businessBody({ email: body.email }) });
  assert.equal(asBusiness.status, 409);
});

test("login: wrong password is 401, and the form role must match the account role", async () => {
  const s = studentBody(), e = businessBody();
  await t.api("POST", "/api/auth/register", { body: s });
  await t.api("POST", "/api/auth/register", { body: e });
  assert.equal((await t.api("POST", "/api/auth/login", { body: { email: s.email, password: "wrong-password" } })).status, 401);
  assert.equal((await t.api("POST", "/api/auth/login", { body: { email: "nobody@example.test", password: "whatever-123" } })).status, 401);
  const wrong = await t.api("POST", "/api/auth/login", { body: { email: e.email, password: e.password, expectedRole: "student" } });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error.message, /business/);
  assert.equal(wrong.body.token, undefined);
  assert.equal((await t.api("POST", "/api/auth/login", { body: { email: s.email, password: s.password, expectedRole: "employer" } })).status, 403);
});

test("4. private endpoints reject anonymous callers", async () => {
  for (const [m, p] of [
    ["GET", "/api/me"], ["GET", "/api/profile"], ["PUT", "/api/profile"], ["GET", "/api/business/profile"], ["PUT", "/api/business/profile"],
    ["GET", "/api/saved"], ["GET", "/api/applications/mine"], ["GET", "/api/applications"], ["GET", "/api/threads"],
    ["GET", "/api/employer/jobs"], ["POST", "/api/auth/logout"], ["GET", "/api/admin/stats"], ["GET", "/api/admin/students"],
  ]) {
    const r = await t.api(m, p, m === "PUT" ? { body: {} } : {});
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  // public data stays public
  assert.equal((await t.api("GET", "/api/jobs")).status, 200);
});

test("5. a student cannot use business-only endpoints", async () => {
  const { body } = await t.api("POST", "/api/auth/register", { body: studentBody() });
  const token = body.token;
  assert.equal((await t.api("GET", "/api/business/profile", { token })).status, 403);
  assert.equal((await t.api("PUT", "/api/business/profile", { token, body: { companyName: "Hacked Co" } })).status, 403);
  assert.equal((await t.api("GET", "/api/employer/jobs", { token })).status, 403);
  assert.equal((await t.api("GET", "/api/applications", { token })).status, 403);
  const job = { title: "Sneaky job", location: "Srinagar", type: "Gig", sector: "Events", unit: "day", pay: [100, 200], skills: ["Driving"], schedule: [] };
  assert.equal((await t.api("POST", "/api/jobs", { token, body: job })).status, 403);
  assert.equal((await t.api("PATCH", "/api/applications/1", { token, body: { status: "Hired" } })).status, 403);
});

test("6. a business cannot use student-only endpoints", async () => {
  const { body } = await t.api("POST", "/api/auth/register", { body: businessBody() });
  const token = body.token;
  assert.equal((await t.api("GET", "/api/profile", { token })).status, 403);
  assert.equal((await t.api("PUT", "/api/profile", { token, body: { name: "x" } })).status, 403);
  assert.equal((await t.api("GET", "/api/saved", { token })).status, 403);
  assert.equal((await t.api("PUT", "/api/saved/1", { token })).status, 403);
  assert.equal((await t.api("GET", "/api/applications/mine", { token })).status, 403);
  assert.equal((await t.api("POST", "/api/jobs/1/applications", { token, body: { note: "hi" } })).status, 403);
});

test("10. logout invalidates the session on the server", async () => {
  const s = studentBody();
  const { body } = await t.api("POST", "/api/auth/register", { body: s });
  const old = body.token;
  assert.equal((await t.api("GET", "/api/me", { token: old })).status, 200);
  assert.equal((await t.api("POST", "/api/auth/logout", { token: old })).status, 200);
  assert.equal((await t.api("GET", "/api/me", { token: old })).status, 401, "the old token is dead even though its signature is valid");
  assert.equal((await t.api("POST", "/api/auth/logout", { token: old })).status, 401);
  // a fresh login works and is a different session
  const again = await t.api("POST", "/api/auth/login", { body: { email: s.email, password: s.password } });
  assert.equal((await t.api("GET", "/api/me", { token: again.body.token })).status, 200);
  // logging out one session does not end another
  const second = await t.api("POST", "/api/auth/login", { body: { email: s.email, password: s.password } });
  await t.api("POST", "/api/auth/logout", { token: again.body.token });
  assert.equal((await t.api("GET", "/api/me", { token: second.body.token })).status, 200);
});

test("11. profile changes persist after logout and login (student and business)", async () => {
  const s = studentBody();
  const reg = await t.api("POST", "/api/auth/register", { body: s });
  const put = await t.api("PUT", "/api/profile", {
    token: reg.body.token,
    body: { name: "Updated Name", study: "BSc Physics", location: "Jammu", skills: ["Tutoring", "Data Entry"], availability: ["Sat-Morning", "Sun-Evening"] },
  });
  assert.equal(put.status, 200);
  await t.api("POST", "/api/auth/logout", { token: reg.body.token });
  const login = await t.api("POST", "/api/auth/login", { body: { email: s.email, password: s.password, expectedRole: "student" } });
  const prof = (await t.api("GET", "/api/profile", { token: login.body.token })).body.profile;
  assert.deepEqual(prof, { name: "Updated Name", study: "BSc Physics", location: "Jammu", skills: ["Tutoring", "Data Entry"], availability: ["Sat-Morning", "Sun-Evening"] });

  const e = businessBody();
  const breg = await t.api("POST", "/api/auth/register", { body: e });
  const job = await t.api("POST", "/api/jobs", {
    token: breg.body.token,
    body: { title: "Barista", location: "Srinagar", type: "Part-time", sector: "Food & Beverage", unit: "hour", pay: [100, 150], skills: ["Customer Service"], schedule: [] },
  });
  assert.equal(job.body.job.employer, "Chinar Cafe");
  const upd = await t.api("PUT", "/api/business/profile", {
    token: breg.body.token,
    body: { companyName: "Chinar Cafe & Bakery", town: "Budgam", contactEmail: "orders@chinar.test", phone: "01942 555 0101", description: "Now with a bakery." },
  });
  assert.equal(upd.status, 200);
  await t.api("POST", "/api/auth/logout", { token: breg.body.token });
  const blogin = await t.api("POST", "/api/auth/login", { body: { email: e.email, password: e.password, expectedRole: "employer" } });
  const bp = (await t.api("GET", "/api/business/profile", { token: blogin.body.token })).body.profile;
  assert.equal(bp.name, "Chinar Cafe & Bakery");
  assert.equal(bp.town, "Budgam");
  assert.equal(bp.contactEmail, "orders@chinar.test");
  assert.equal(bp.description, "Now with a bakery.");
  const listing = await t.api("GET", `/api/jobs/${job.body.job.id}`);
  assert.equal(listing.body.job.employer, "Chinar Cafe & Bakery", "listings follow the company rename");
  const bad = await t.api("PUT", "/api/business/profile", { token: blogin.body.token, body: { phone: "abc" } });
  assert.equal(bad.status, 422);
});

test("13. invalid, expired and forged tokens are rejected", async () => {
  const s = studentBody();
  const reg = await t.api("POST", "/api/auth/register", { body: s });
  const good = reg.body.token;
  const payload = JSON.parse(Buffer.from(good.split(".")[1], "base64url"));
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    "garbage": "not-a-token",
    "empty parts": "..",
    "tampered signature": good.slice(0, -3) + (good.endsWith("AAA") ? "BBB" : "AAA"),
    "payload swapped to another user": `${good.split(".")[0]}.${b64u({ ...payload, sub: 1, role: "employer" })}.${good.split(".")[2]}`,
    "signed with the wrong secret": forge(payload, "some-other-secret-some-other-secret-1"),
    "alg none": `${b64u({ alg: "none", typ: "JWT" })}.${b64u(payload)}.`,
    "expired but correctly signed": forge({ ...payload, iat: now - 1000, exp: now - 10 }),
    "correctly signed but session id unknown": forge({ ...payload, jti: "does-not-exist" }),
    "correctly signed legacy token without session": forge({ sub: payload.sub, role: "student", iat: now, exp: now + 3600 }),
  };
  for (const [name, token] of Object.entries(cases)) {
    assert.equal((await t.api("GET", "/api/me", { token })).status, 401, name);
  }
  assert.equal((await t.api("GET", "/api/me", { token: good })).status, 200, "the genuine token still works");
  const noBearer = await fetch(t.base + "/api/me", { headers: { Authorization: good } });
  assert.equal(noBearer.status, 401);
});

test("login and register are rate limited", async () => {
  const limited = await startApp({ authMax: 3 });
  try {
    const attempt = () => limited.api("POST", "/api/auth/login", { body: { email: "x@example.test", password: "wrong-password" } });
    for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 429);
    assert.equal((await limited.api("POST", "/api/auth/register", { body: studentBody() })).status, 429);
  } finally {
    await limited.close();
  }
});
