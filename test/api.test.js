import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.DB_PATH = ":memory:";
process.env.SEED_DEMO_USERS = "1";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-12345";

const { createApp } = await import("../src/app.js");
const { seedIfEmpty } = await import("../src/seed.js");

let server, base;
before(async () => {
  await seedIfEmpty();
  server = createApp();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const register = async (o) => (await api("POST", "/api/auth/register", { body: o })).body;
const login = async (email) => (await api("POST", "/api/auth/login", { body: { email, password: "safar-demo-123" } })).body.token;

test("public endpoints: health, meta, job list and filters", async () => {
  assert.equal((await api("GET", "/api/health")).body.ok, true);
  assert.ok((await api("GET", "/api/meta")).body.skills.includes("Photography"));
  const all = await api("GET", "/api/jobs");
  assert.equal(all.body.total, 18);
  assert.equal(all.body.jobs[0].match, undefined, "anonymous users get no match score");
  const gigs = await api("GET", "/api/jobs?type=Gig");
  assert.ok(gigs.body.jobs.length > 0 && gigs.body.jobs.every((j) => j.type === "Gig"));
  const q = await api("GET", "/api/jobs?q=photography");
  assert.ok(q.body.jobs.some((j) => j.title.includes("Photographer")));
  assert.equal((await api("GET", "/api/jobs/99999")).status, 404);
  assert.equal((await api("GET", "/api/nope")).status, 404);
});

test("registration and login validation", async () => {
  let r = await api("POST", "/api/auth/register", { body: { email: "bad", password: "short", role: "student", name: "" } });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.details.email && r.body.error.details.password && r.body.error.details.name);

  r = await api("POST", "/api/auth/register", { body: { email: "emp@x.com", password: "longenough1", role: "employer", name: "Boss" } });
  assert.equal(r.status, 422, "employers need companyName and town");

  const ok = await api("POST", "/api/auth/register", { body: { email: "Ayesha@Example.com", password: "longenough1", role: "student", name: "Ayesha" } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.email, "ayesha@example.com");
  assert.equal(ok.body.user.password_hash, undefined);

  const dup = await api("POST", "/api/auth/register", { body: { email: "ayesha@example.com", password: "longenough1", role: "student", name: "A" } });
  assert.equal(dup.status, 409);

  assert.equal((await api("POST", "/api/auth/login", { body: { email: "ayesha@example.com", password: "wrong-password" } })).status, 401);
  assert.equal((await api("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "whatever12" } })).status, 401);
  assert.equal((await api("POST", "/api/auth/login", { body: { email: "ayesha@example.com", password: "longenough1" } })).status, 200);
  // seeded placeholder applicants have no password and can never log in
  assert.equal((await api("POST", "/api/auth/login", { body: { email: "sana.mir@seed.local", password: "anything123" } })).status, 401);
});

test("auth guards: missing, tampered and wrong-role tokens", async () => {
  assert.equal((await api("GET", "/api/me")).status, 401);
  const { token } = await register({ email: "g@x.com", password: "longenough1", role: "student", name: "G" });
  assert.equal((await api("GET", "/api/me", { token })).status, 200);
  const [h, p, s] = token.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 1, role: "employer", exp: 9999999999 })).toString("base64url")}.${s}`;
  assert.equal((await api("GET", "/api/me", { token: forged })).status, 401);
  assert.equal((await api("POST", "/api/jobs", { token, body: {} })).status, 403, "students cannot post jobs");
});

test("student: profile, matching, saved jobs", async () => {
  const token = await login("student@safar.demo");
  const me = await api("GET", "/api/me", { token });
  assert.equal(me.body.user.profile.location, "Srinagar");

  const jobs = (await api("GET", "/api/jobs", { token })).body.jobs;
  assert.ok(jobs[0].match.total >= jobs[jobs.length - 1].match.total, "sorted by match by default");
  const photog = jobs.find((j) => j.title === "Tourist Portrait Photographer");
  assert.equal(photog.match.total, 100, "demo student is a perfect fit for the photographer gig");

  // saved: seed has one
  assert.equal((await api("GET", "/api/saved", { token })).body.jobs.length, 1);
  assert.equal((await api("PUT", `/api/saved/${photog.id}`, { token })).status, 200);
  assert.equal((await api("PUT", `/api/saved/${photog.id}`, { token })).status, 200, "idempotent");
  assert.equal((await api("GET", "/api/saved", { token })).body.jobs.length, 2);
  await api("DELETE", `/api/saved/${photog.id}`, { token });
  assert.equal((await api("GET", "/api/saved", { token })).body.jobs.length, 1);

  const bad = await api("PUT", "/api/profile", { token, body: { skills: ["Underwater Basket Weaving"] } });
  assert.equal(bad.status, 422);
  const upd = await api("PUT", "/api/profile", { token, body: { study: "BCA, 1st year" } });
  assert.equal(upd.body.profile.study, "BCA, 1st year");
  assert.deepEqual(upd.body.profile.skills, ["Photography", "Event Support", "Spoken English"], "partial update keeps other fields");

  const fit = (await api("GET", "/api/jobs?fit=1", { token })).body.jobs;
  assert.ok(fit.every((j) => j.match.fitsSchedule));
});

test("employer: post, validate, ownership", async () => {
  const a = await register({ email: "owner@x.com", password: "longenough1", role: "employer", name: "Owner", companyName: "Chinar Cafe", town: "Srinagar" });
  const b = await register({ email: "other@x.com", password: "longenough1", role: "employer", name: "Other", companyName: "Other Co", town: "Jammu" });
  const good = { title: "Cafe Helper", location: "Srinagar", type: "Part-time", sector: "Food & Beverage", pay: [8000, 10000], unit: "month", skills: ["Customer Service"], schedule: ["Sat-Morning"], desc: "Help out." };

  let r = await api("POST", "/api/jobs", { token: a.token, body: { ...good, pay: [10000, 8000] } });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.details.pay);
  r = await api("POST", "/api/jobs", { token: a.token, body: { ...good, img: "javascript:alert(1)" } });
  assert.equal(r.status, 422);
  r = await api("POST", "/api/jobs", { token: a.token, body: { ...good, skills: [] } });
  assert.equal(r.status, 422);

  r = await api("POST", "/api/jobs", { token: a.token, body: good });
  assert.equal(r.status, 201);
  assert.equal(r.body.job.employer, "Chinar Cafe");
  const id = r.body.job.id;

  assert.equal((await api("PATCH", `/api/jobs/${id}`, { token: b.token, body: { title: "Hacked" } })).status, 403);
  assert.equal((await api("DELETE", `/api/jobs/${id}`, { token: b.token })).status, 403);
  r = await api("PATCH", `/api/jobs/${id}`, { token: a.token, body: { pay: [9000, 12000], img: "data:image/png;base64,iVBORw0KGgo=" } });
  assert.deepEqual(r.body.job.pay, [9000, 12000]);

  // closing hides it from the public list and blocks applications
  await api("PATCH", `/api/jobs/${id}`, { token: a.token, body: { status: "closed" } });
  assert.ok(!(await api("GET", "/api/jobs")).body.jobs.some((j) => j.id === id));
  const s = await register({ email: "late@x.com", password: "longenough1", role: "student", name: "Late" });
  assert.equal((await api("POST", `/api/jobs/${id}/applications`, { token: s.token, body: {} })).status, 409);
});

test("full hiring flow: apply, shortlist, interview, offer, accept", async () => {
  const stud = await login("student@safar.demo");
  const emp = await login("employer@safar.demo");

  const evt = (await api("GET", "/api/jobs?q=Event Assistant", { token: stud })).body.jobs.find((j) => j.title === "Event Assistant");
  assert.ok(evt, "demo employer's seeded job exists");

  // employers cannot apply
  assert.equal((await api("POST", `/api/jobs/${evt.id}/applications`, { token: emp, body: {} })).status, 403);

  let r = await api("POST", `/api/jobs/${evt.id}/applications`, { token: stud, body: { note: "I can work every weekend." } });
  assert.equal(r.status, 201);
  assert.equal(r.body.application.status, "Applied");
  const appId = r.body.application.id;
  assert.equal((await api("POST", `/api/jobs/${evt.id}/applications`, { token: stud, body: {} })).status, 409, "no double applying");

  // employer sees the applicant with a match score
  const list = (await api("GET", `/api/applications?jobId=${evt.id}`, { token: emp })).body.applications;
  const mine = list.find((a) => a.id === appId);
  assert.equal(mine.applicant.name, "Demo Student");
  assert.ok(mine.match.total > 0);
  assert.ok(list.some((a) => a.applicant.name === "Sana Mir"), "seeded sample applicants are visible");

  // cannot propose interview before shortlisting
  const thread = (await api("GET", "/api/threads", { token: emp })).body.threads.find((t) => t.application?.id === appId);
  assert.equal((await api("POST", `/api/threads/${thread.id}/interview`, { token: emp, body: {} })).status, 409);

  // status change posts to chat and notifies the student
  r = await api("PATCH", `/api/applications/${appId}`, { token: emp, body: { status: "Shortlisted" } });
  assert.equal(r.body.application.status, "Shortlisted");
  assert.equal((await api("PATCH", `/api/applications/${appId}`, { token: emp, body: { status: "Flying" } })).status, 422);

  r = await api("POST", `/api/threads/${thread.id}/interview`, { token: emp, body: {} });
  assert.equal(r.status, 201);
  const card = r.body.message;
  assert.equal(card.kind, "interview");
  assert.ok(card.slots.length > 0 && card.slots.length <= 3);
  assert.equal((await api("POST", `/api/threads/${thread.id}/interview`, { token: emp, body: {} })).status, 409, "one pending card at a time");

  // the employer cannot answer on the student's behalf
  assert.equal((await api("POST", `/api/threads/${thread.id}/messages/${card.id}/respond`, { token: emp, body: { action: "pick", slot: card.slots[0] } })).status, 403);
  // wrong slot rejected
  assert.equal((await api("POST", `/api/threads/${thread.id}/messages/${card.id}/respond`, { token: stud, body: { action: "pick", slot: "Mon-Evening" } })).status, 400);
  r = await api("POST", `/api/threads/${thread.id}/messages/${card.id}/respond`, { token: stud, body: { action: "pick", slot: card.slots[0] } });
  assert.equal(r.body.message.state, "accepted");
  assert.equal(r.body.applicationStatus, "Interview");
  assert.equal((await api("POST", `/api/threads/${thread.id}/messages/${card.id}/respond`, { token: stud, body: { action: "pick", slot: card.slots[0] } })).status, 409, "cannot answer twice");

  // offer -> accept -> hired
  r = await api("POST", `/api/threads/${thread.id}/offer`, { token: emp, body: {} });
  assert.equal(r.status, 201);
  assert.match(r.body.message.t, /Event Assistant at Valley Events & Tours\. Pay ₹800–1,000 \/day\./);
  r = await api("POST", `/api/threads/${thread.id}/messages/${r.body.message.id}/respond`, { token: stud, body: { action: "accept" } });
  assert.equal(r.body.applicationStatus, "Hired");
  const mineNow = (await api("GET", "/api/applications/mine", { token: stud })).body.applications.find((a) => a.id === appId);
  assert.equal(mineNow.status, "Hired");
  assert.equal(mineNow.job.title, "Event Assistant");
  assert.equal((await api("POST", `/api/threads/${thread.id}/offer`, { token: emp, body: {} })).status, 409, "already hired");
});

test("messaging: access control, unread counters, read receipts", async () => {
  const stud = await login("student@safar.demo");
  const emp = await login("employer@safar.demo");
  const stranger = (await register({ email: "str@x.com", password: "longenough1", role: "student", name: "Stranger" })).token;
  const otherEmp = (await register({ email: "oe@x.com", password: "longenough1", role: "employer", name: "O", companyName: "O Co", town: "Jammu" })).token;

  const photog = (await api("GET", "/api/jobs?q=Portrait", { token: stud })).body.jobs[0];
  const t = await api("POST", "/api/threads", { token: stud, body: { jobId: photog.id } });
  const tid = t.body.thread.id;
  assert.equal((await api("POST", "/api/threads", { token: stud, body: { jobId: photog.id } })).body.thread.id, tid, "reuses the same thread");

  const before = (await api("GET", "/api/threads", { token: emp })).body.unreadTotal;
  assert.equal((await api("POST", `/api/threads/${tid}/messages`, { token: stud, body: { text: "Is the shoot on Saturday?" } })).status, 201);
  assert.equal((await api("GET", "/api/threads", { token: emp })).body.unreadTotal, before + 1);

  // outsiders cannot read or write (404 so ids cannot be probed)
  assert.equal((await api("GET", `/api/threads/${tid}`, { token: stranger })).status, 404);
  assert.equal((await api("GET", `/api/threads/${tid}`, { token: otherEmp })).status, 404);
  assert.equal((await api("POST", `/api/threads/${tid}/messages`, { token: stranger, body: { text: "hi" } })).status, 404);

  // opening marks read
  const open = await api("GET", `/api/threads/${tid}`, { token: emp });
  assert.ok(open.body.thread.messages.some((m) => m.t === "Is the shoot on Saturday?"));
  assert.equal((await api("GET", "/api/threads", { token: emp })).body.unreadTotal, before);

  assert.equal((await api("POST", `/api/threads/${tid}/messages`, { token: stud, body: { text: "   " } })).status, 422);
  assert.equal((await api("POST", `/api/threads/${tid}/messages`, { token: stud, body: { text: "x".repeat(2001) } })).status, 422);
});

test("request hardening: bad JSON, wrong content type, oversize body", async () => {
  let res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
  assert.equal(res.status, 400);
  res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" });
  assert.equal(res.status, 415);
  res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co", password: "x".repeat(3 * 1024 * 1024) }) });
  assert.equal(res.status, 413);
  // path traversal: fetch() would normalise "../" away, so send the raw encoded path
  const raw = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: "/..%2f..%2fpackage.json" }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ status: r.statusCode, body: b }));
    });
  });
  assert.equal(raw.status, 403);
  assert.ok(!raw.body.includes("safar-backend"), "must not leak files outside public/");
  res = await fetch(base + "/api/jobs", { method: "DELETE" });
  assert.equal(res.status, 405);
});

test("serves the frontend", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /SAFAR/);
});
