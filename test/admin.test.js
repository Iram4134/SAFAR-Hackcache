import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PASSWORD, businessBody, startApp, studentBody, uniqueEmail } from "./helpers.js";

let t, db, adminToken, studentTok, businessTok, student, business;
const ADMIN_PW = "a-long-admin-passphrase-42";
const adminEmail = uniqueEmail("admin");

before(async () => {
  t = await startApp();
  db = (await import("../src/db.js")).db;
  const { provisionAdmin } = await import("../src/admin-provision.js");
  await provisionAdmin({ email: adminEmail, name: "Test Admin", password: ADMIN_PW });
  adminToken = (await t.api("POST", "/api/auth/login", { body: { email: adminEmail, password: ADMIN_PW, expectedRole: "admin" } })).body.token;
  student = studentBody({ name: "Zainab Admin-Visible" });
  business = businessBody({ companyName: "Lidder Rafting Co" });
  studentTok = (await t.api("POST", "/api/auth/register", { body: student })).body;
  businessTok = (await t.api("POST", "/api/auth/register", { body: business })).body;
});
after(() => t.close());

const ADMIN_ENDPOINTS = [
  ["GET", "/api/admin/stats"], ["GET", "/api/admin/students"], ["GET", "/api/admin/students/2"], ["GET", "/api/admin/businesses"],
  ["GET", "/api/admin/businesses/1"], ["PATCH", "/api/admin/users/2/status"], ["GET", "/api/admin/jobs"], ["PATCH", "/api/admin/jobs/1"],
  ["DELETE", "/api/admin/jobs/1"], ["GET", "/api/admin/applications"], ["GET", "/api/admin/audit"],
];

test("7. students, businesses and visitors cannot reach any admin endpoint", async () => {
  for (const [m, p] of ADMIN_ENDPOINTS) {
    const body = m === "PATCH" ? { status: "disabled" } : undefined;
    assert.equal((await t.api(m, p, { body })).status, 401, `anonymous ${m} ${p}`);
    assert.equal((await t.api(m, p, { token: studentTok.token, body })).status, 403, `student ${m} ${p}`);
    assert.equal((await t.api(m, p, { token: businessTok.token, body })).status, 403, `business ${m} ${p}`);
  }
  // Admin access cannot be claimed through the request itself
  const sneaky = await t.api("GET", "/api/admin/stats?role=admin&admin=1", { token: studentTok.token, headers: { "x-role": "admin", "x-admin": "1" } });
  assert.equal(sneaky.status, 403);
  const profile = await t.api("PUT", "/api/profile", { token: studentTok.token, body: { role: "admin", name: "Still A Student" } });
  assert.equal(profile.status, 200);
  assert.equal((await t.api("GET", "/api/me", { token: studentTok.token })).body.user.role, "student");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n, 1);
});

test("admins sign in through the admin role only, and are not students or businesses", async () => {
  const viaStudentForm = await t.api("POST", "/api/auth/login", { body: { email: adminEmail, password: ADMIN_PW, expectedRole: "student" } });
  assert.equal(viaStudentForm.status, 403);
  const viaBusinessForm = await t.api("POST", "/api/auth/login", { body: { email: adminEmail, password: ADMIN_PW, expectedRole: "employer" } });
  assert.equal(viaBusinessForm.status, 403);
  assert.equal((await t.api("GET", "/api/profile", { token: adminToken })).status, 403);
  assert.equal((await t.api("GET", "/api/business/profile", { token: adminToken })).status, 403);
  assert.equal((await t.api("GET", "/api/me", { token: adminToken })).body.user.role, "admin");
});

test("8. an admin can read student and business records (and never secrets)", async () => {
  const stats = (await t.api("GET", "/api/admin/stats", { token: adminToken })).body;
  assert.equal(stats.students, db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='student'").get().n);
  assert.equal(stats.businesses, db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='employer'").get().n);
  assert.equal(stats.jobs, 18);
  assert.equal(stats.applications, 5);

  const students = await t.api("GET", `/api/admin/students?q=${encodeURIComponent(student.email)}`, { token: adminToken });
  assert.equal(students.status, 200);
  assert.equal(students.body.total, 1);
  assert.equal(students.body.students[0].email, student.email);
  assert.equal(students.body.students[0].status, "active");
  assert.ok(students.body.students[0].createdAt > 0);

  const all = await t.api("GET", "/api/admin/students?limit=2&offset=0", { token: adminToken });
  assert.equal(all.body.students.length, 2);
  assert.ok(all.body.total > 2);

  const biz = await t.api("GET", "/api/admin/businesses?q=lidder", { token: adminToken });
  assert.equal(biz.body.total, 1);
  assert.equal(biz.body.businesses[0].companyName, "Lidder Rafting Co");
  assert.equal((await t.api("GET", "/api/admin/businesses?status=disabled", { token: adminToken })).body.total, 0);

  const sDetail = await t.api("GET", `/api/admin/students/${studentTok.user.id}`, { token: adminToken });
  assert.equal(sDetail.body.student.profile.location, "Srinagar");
  assert.deepEqual(sDetail.body.student.applications, []);
  const bDetail = await t.api("GET", `/api/admin/businesses/${businessTok.user.id}`, { token: adminToken });
  assert.equal(bDetail.body.business.profile.name, "Lidder Rafting Co");
  assert.equal(bDetail.body.business.profile.phone, "+91 99060 12345");
  // the endpoints are role-specific: a student id is not a business record
  assert.equal((await t.api("GET", `/api/admin/businesses/${studentTok.user.id}`, { token: adminToken })).status, 404);

  // nothing sensitive anywhere in any admin response
  const dumps = JSON.stringify([stats, students.body, all.body, biz.body, sDetail.body, bDetail.body,
    (await t.api("GET", "/api/admin/jobs", { token: adminToken })).body,
    (await t.api("GET", "/api/admin/applications", { token: adminToken })).body,
    (await t.api("GET", "/api/admin/audit", { token: adminToken })).body]);
  assert.ok(!/scrypt\$/.test(dumps), "no password hashes");
  assert.ok(!/password/i.test(dumps), "no password fields");
  assert.ok(!dumps.includes(studentTok.token) && !dumps.includes(adminToken), "no tokens");
  assert.ok(!/"jti"|revoked_at/.test(dumps), "no session data");
  const seeded = (await t.api("GET", "/api/admin/students?q=sana", { token: adminToken })).body.students[0];
  assert.equal(seeded.canLogin, false, "placeholder accounts are flagged as unable to log in");
});

test("admin can deactivate and reactivate accounts; sessions end and the action is audited", async () => {
  const victim = studentBody();
  const reg = (await t.api("POST", "/api/auth/register", { body: victim })).body;
  const off = await t.api("PATCH", `/api/admin/users/${reg.user.id}/status`, { token: adminToken, body: { status: "disabled" } });
  assert.equal(off.status, 200);
  assert.equal((await t.api("GET", "/api/me", { token: reg.token })).status, 401, "live session was ended");
  const blocked = await t.api("POST", "/api/auth/login", { body: { email: victim.email, password: victim.password } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error.message, /deactivated/);
  assert.equal((await t.api("GET", `/api/admin/students?status=disabled&q=${encodeURIComponent(victim.email)}`, { token: adminToken })).body.total, 1);
  const on = await t.api("PATCH", `/api/admin/users/${reg.user.id}/status`, { token: adminToken, body: { status: "active" } });
  assert.equal(on.status, 200);
  assert.equal((await t.api("POST", "/api/auth/login", { body: { email: victim.email, password: victim.password } })).status, 200);

  assert.equal((await t.api("PATCH", `/api/admin/users/${reg.user.id}/status`, { token: adminToken, body: { status: "banned" } })).status, 422);
  assert.equal((await t.api("PATCH", "/api/admin/users/999999/status", { token: adminToken, body: { status: "disabled" } })).status, 404);
  const adminId = (await t.api("GET", "/api/me", { token: adminToken })).body.user.id;
  assert.equal((await t.api("PATCH", `/api/admin/users/${adminId}/status`, { token: adminToken, body: { status: "disabled" } })).status, 403, "no self-lockout");

  const log = (await t.api("GET", "/api/admin/audit", { token: adminToken })).body.entries;
  const actions = log.map((e) => e.action);
  assert.ok(actions.includes("deactivate_account") && actions.includes("activate_account"));
  assert.equal(log[0].admin, adminEmail);
  assert.ok(!JSON.stringify(log).match(/scrypt|Bearer|eyJ/));
});

test("admin can moderate listings; deleting cascades to applications", async () => {
  const jobs = (await t.api("GET", "/api/admin/jobs?q=Event%20Assistant", { token: adminToken })).body;
  assert.ok(jobs.total >= 1);
  const id = jobs.jobs[0].id;
  assert.equal((await t.api("PATCH", `/api/admin/jobs/${id}`, { token: adminToken, body: { status: "closed" } })).status, 200);
  assert.equal((await t.api("GET", "/api/jobs")).body.jobs.some((j) => j.id === id), false, "closed jobs leave the public list");
  assert.equal((await t.api("PATCH", `/api/admin/jobs/${id}`, { token: adminToken, body: { status: "open" } })).status, 200);
  const apps = (await t.api("GET", `/api/admin/applications?jobId=${id}`, { token: adminToken })).body;
  assert.ok(apps.total >= 1);
  assert.equal((await t.api("DELETE", `/api/admin/jobs/${id}`, { token: adminToken })).status, 200);
  assert.equal((await t.api("GET", `/api/jobs/${id}`)).status, 404);
  assert.equal((await t.api("GET", `/api/admin/applications?jobId=${id}`, { token: adminToken })).body.total, 0);
  const log = (await t.api("GET", "/api/admin/audit", { token: adminToken })).body.entries.map((e) => e.action);
  assert.ok(log.includes("close_job") && log.includes("reopen_job") && log.includes("delete_job"));
});

test("9. users cannot read or change each other's profiles, applications or conversations", async () => {
  // two students apply to an open job owned by the demo employer; a second business exists too
  const jobs = (await t.api("GET", "/api/jobs")).body.jobs;
  const target = jobs.find((j) => j.ownerId);
  const a = (await t.api("POST", "/api/auth/register", { body: studentBody({ name: "Student A" }) })).body;
  const b = (await t.api("POST", "/api/auth/register", { body: studentBody({ name: "Student B" }) })).body;
  const appA = await t.api("POST", `/api/jobs/${target.id}/applications`, { token: a.token, body: { note: "A here" } });
  assert.equal(appA.status, 201);

  // B cannot touch A's application or thread, and cannot change A's profile via a user id
  assert.equal((await t.api("PATCH", `/api/applications/${appA.body.application.id}`, { token: b.token, body: { status: "Hired" } })).status, 403);
  const threadA = (await t.api("GET", "/api/threads", { token: a.token })).body.threads[0];
  assert.equal((await t.api("GET", `/api/threads/${threadA.id}`, { token: b.token })).status, 404);
  assert.equal((await t.api("POST", `/api/threads/${threadA.id}/messages`, { token: b.token, body: { text: "hi" } })).status, 404);
  assert.deepEqual((await t.api("GET", "/api/applications/mine", { token: b.token })).body.applications, []);
  const put = await t.api("PUT", "/api/profile", { token: b.token, body: { userId: a.user.id, user_id: a.user.id, id: a.user.id, name: "B renamed" } });
  assert.equal(put.status, 200);
  assert.equal((await t.api("GET", "/api/profile", { token: a.token })).body.profile.name, "Student A");
  assert.equal((await t.api("GET", "/api/profile", { token: b.token })).body.profile.name, "B renamed");

  // an unrelated business can neither see applicants nor edit/delete another business's listing
  const other = (await t.api("POST", "/api/auth/register", { body: businessBody() })).body;
  assert.deepEqual((await t.api("GET", "/api/applications", { token: other.token })).body.applications, []);
  assert.equal((await t.api("PATCH", `/api/applications/${appA.body.application.id}`, { token: other.token, body: { status: "Rejected" } })).status, 403);
  assert.equal((await t.api("PATCH", `/api/jobs/${target.id}`, { token: other.token, body: { title: "Defaced" } })).status, 403);
  assert.equal((await t.api("DELETE", `/api/jobs/${target.id}`, { token: other.token })).status, 403);
  assert.equal((await t.api("GET", `/api/threads/${threadA.id}`, { token: other.token })).status, 404);
  assert.equal((await t.api("POST", "/api/threads", { token: other.token, body: { jobId: target.id, studentId: a.user.id } })).status, 403);

  // the owner can, and the student sees the new status
  const demo = (await t.api("POST", "/api/auth/login", { body: { email: "employer@safar.demo", password: PASSWORD } })).body.token;
  assert.equal((await t.api("PATCH", `/api/applications/${appA.body.application.id}`, { token: demo, body: { status: "Shortlisted" } })).status, 200);
  assert.equal((await t.api("GET", "/api/applications/mine", { token: a.token })).body.applications[0].status, "Shortlisted");
});

test("admin provisioning: no public path, strong password, no promotion of existing users", async () => {
  const { provisionAdmin } = await import("../src/admin-provision.js");
  await assert.rejects(provisionAdmin({ email: uniqueEmail("weak"), password: "short" }), /at least 12/);
  await assert.rejects(provisionAdmin({ email: student.email, password: "a-long-admin-passphrase-42" }), /already belongs to a student/);
  const again = await provisionAdmin({ email: adminEmail, password: "another-long-passphrase-9" });
  assert.equal(again.created, false);
  assert.equal((await t.api("POST", "/api/auth/login", { body: { email: adminEmail, password: ADMIN_PW } })).status, 200, "existing password untouched without reset flag");
  const reset = await provisionAdmin({ email: adminEmail, password: "another-long-passphrase-9", resetPassword: true });
  assert.equal(reset.updated, true);
  assert.equal((await t.api("GET", "/api/me", { token: adminToken })).status, 401, "password reset signs the admin out everywhere");
  assert.equal((await t.api("POST", "/api/auth/login", { body: { email: adminEmail, password: "another-long-passphrase-9", expectedRole: "admin" } })).status, 200);
  // the seeded demo data creates no admin account
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND email LIKE '%safar.demo'").get().n, 0);
});
