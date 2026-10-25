import { db, tx } from "../db.js";
import { requireRole, revokeUserSessions } from "../auth.js";
import { badRequest, conflict, forbidden, idParam, notFound } from "../http.js";
import { parse, v } from "../validate.js";
import { STATUSES } from "../constants.js";
import { getBusinessProfile, getStudentProfile, json } from "../models.js";

const admin = requireRole("admin");

function audit(ctx, action, targetType, targetId, detail = "") {
  db.prepare("INSERT INTO audit_log (admin_id, admin_email, action, target_type, target_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(ctx.user.id, ctx.user.email, action, targetType, targetId ?? null, String(detail).slice(0, 300), ctx.ip, Date.now());
}

const paging = (q) => ({
  limit: Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 100),
  offset: Math.max(parseInt(q.offset, 10) || 0, 0),
});
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => "\\" + c)}%`;

// Only ever returns the columns an admin needs. password_hash and sessions are never selected.
const userRow = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  status: u.status,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at || null,
  canLogin: Boolean(u.has_login),
});
const USER_COLS = "u.id, u.name, u.email, u.role, u.status, u.created_at, u.last_login_at, (u.password_hash IS NOT NULL) AS has_login";

export default function (r) {
  r.get("/api/admin/stats", admin, () => {
    const n = (sql, ...a) => db.prepare(sql).get(...a).n;
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM applications GROUP BY status").all()) byStatus[row.status] = row.n;
    return {
      students: n("SELECT COUNT(*) AS n FROM users WHERE role='student'"),
      businesses: n("SELECT COUNT(*) AS n FROM users WHERE role='employer'"),
      admins: n("SELECT COUNT(*) AS n FROM users WHERE role='admin'"),
      disabledAccounts: n("SELECT COUNT(*) AS n FROM users WHERE status='disabled'"),
      jobs: n("SELECT COUNT(*) AS n FROM jobs"),
      openJobs: n("SELECT COUNT(*) AS n FROM jobs WHERE status='open'"),
      applications: n("SELECT COUNT(*) AS n FROM applications"),
      applicationsByStatus: byStatus,
      newUsersLast7Days: n("SELECT COUNT(*) AS n FROM users WHERE created_at > ? AND role != 'admin'", Date.now() - 7 * 864e5),
    };
  });

  // Student / business lists: ?q= (name or email), ?status=active|disabled, ?limit= ?offset=
  for (const [path, role] of [["students", "student"], ["businesses", "employer"]]) {
    r.get(`/api/admin/${path}`, admin, (ctx) => {
      const { limit, offset } = paging(ctx.query);
      const where = ["u.role = ?"];
      const args = [role];
      if (["active", "disabled"].includes(ctx.query.status)) { where.push("u.status = ?"); args.push(ctx.query.status); }
      const needle = String(ctx.query.q || "").trim();
      if (needle) {
        if (role === "employer") { where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR p.company_name LIKE ? ESCAPE '\\')"); args.push(like(needle), like(needle), like(needle)); }
        else { where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')"); args.push(like(needle), like(needle)); }
      }
      const join = role === "employer" ? "LEFT JOIN employer_profiles p ON p.user_id = u.id" : "LEFT JOIN student_profiles p ON p.user_id = u.id";
      const extra = role === "employer" ? ", p.company_name, p.town" : ", p.location, p.study";
      if (role === "student" && ctx.query.location) { where.push("p.location = ?"); args.push(String(ctx.query.location)); }
      const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${join} WHERE ${where.join(" AND ")}`).get(...args).n;
      const rows = db
        .prepare(`SELECT ${USER_COLS}${extra} FROM users u ${join} WHERE ${where.join(" AND ")} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`)
        .all(...args, limit, offset);
      const items = rows.map((u) =>
        role === "employer"
          ? { ...userRow(u), companyName: u.company_name, town: u.town, jobs: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE owner_id=?").get(u.id).n }
          : { ...userRow(u), location: u.location, study: u.study, applications: db.prepare("SELECT COUNT(*) AS n FROM applications WHERE student_id=?").get(u.id).n },
      );
      return { total, limit, offset, [path]: items };
    });

    r.get(`/api/admin/${path}/:id`, admin, (ctx) => {
      const id = idParam(ctx);
      const u = db.prepare(`SELECT ${USER_COLS}, u.updated_at FROM users u WHERE u.id = ? AND u.role = ?`).get(id, role);
      if (!u) throw notFound("Account not found.");
      audit(ctx, "view_account", role, id, `Opened ${role} record`);
      if (role === "student") {
        const applications = db
          .prepare(
            `SELECT a.id, a.status, a.created_at, a.updated_at, j.id AS job_id, j.title, j.employer_name
             FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.student_id = ? ORDER BY a.created_at DESC`,
          )
          .all(id)
          .map((a) => ({ id: a.id, jobId: a.job_id, jobTitle: a.title, employer: a.employer_name, status: a.status, at: a.created_at, updatedAt: a.updated_at }));
        return {
          student: {
            ...userRow(u),
            updatedAt: u.updated_at,
            profile: getStudentProfile(id),
            savedJobs: db.prepare("SELECT COUNT(*) AS n FROM saved_jobs WHERE user_id=?").get(id).n,
            applications,
          },
        };
      }
      const jobs = db.prepare("SELECT * FROM jobs WHERE owner_id = ? ORDER BY posted_at DESC").all(id).map((j) => ({
        id: j.id, title: j.title, location: j.location, status: j.status, postedAt: j.posted_at,
        applicants: db.prepare("SELECT COUNT(*) AS n FROM applications WHERE job_id=?").get(j.id).n,
      }));
      return { business: { ...userRow(u), updatedAt: u.updated_at, profile: getBusinessProfile(id), jobs } };
    });
  }

  // Activate / deactivate a student or business account. Admin accounts cannot be changed here, which
  // also means an admin cannot lock themselves (or another admin) out. Deactivation ends live sessions.
  r.patch("/api/admin/users/:id/status", admin, (ctx) => {
    const id = idParam(ctx);
    const { status } = parse({ status: v.oneOf(["active", "disabled"]) }, ctx.body);
    const u = db.prepare("SELECT id, role, status, email FROM users WHERE id=?").get(id);
    if (!u) throw notFound("Account not found.");
    if (u.role === "admin") throw forbidden("Admin accounts cannot be changed from the dashboard.");
    if (u.status !== status) {
      tx(() => {
        db.prepare("UPDATE users SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), id);
        if (status === "disabled") revokeUserSessions(id);
        audit(ctx, status === "disabled" ? "deactivate_account" : "activate_account", u.role, id, `${u.role} account ${u.email}`);
      });
    }
    return { user: { id, status } };
  });

  // Listings: ?q= ?status=open|closed
  r.get("/api/admin/jobs", admin, (ctx) => {
    const { limit, offset } = paging(ctx.query);
    const where = ["1=1"];
    const args = [];
    if (["open", "closed"].includes(ctx.query.status)) { where.push("j.status = ?"); args.push(ctx.query.status); }
    const needle = String(ctx.query.q || "").trim();
    if (needle) { where.push("(j.title LIKE ? ESCAPE '\\' OR j.employer_name LIKE ? ESCAPE '\\')"); args.push(like(needle), like(needle)); }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs j WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db
      .prepare(
        `SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applicants
         FROM jobs j WHERE ${where.join(" AND ")} ORDER BY j.posted_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    return {
      total, limit, offset,
      jobs: rows.map((j) => ({
        id: j.id, title: j.title, employer: j.employer_name, ownerId: j.owner_id, location: j.location, type: j.type,
        sector: j.sector, pay: [j.pay_min, j.pay_max], unit: j.unit, skills: json(j.skills), status: j.status,
        postedAt: j.posted_at, applicants: j.applicants,
      })),
    };
  });

  r.patch("/api/admin/jobs/:id", admin, (ctx) => {
    const id = idParam(ctx);
    const { status } = parse({ status: v.oneOf(["open", "closed"]) }, ctx.body);
    const j = db.prepare("SELECT id, title, status FROM jobs WHERE id=?").get(id);
    if (!j) throw notFound("Job not found.");
    if (j.status !== status) {
      db.prepare("UPDATE jobs SET status=? WHERE id=?").run(status, id);
      audit(ctx, status === "closed" ? "close_job" : "reopen_job", "job", id, j.title);
    }
    return { job: { id, status } };
  });

  r.delete("/api/admin/jobs/:id", admin, (ctx) => {
    const id = idParam(ctx);
    const j = db.prepare("SELECT id, title FROM jobs WHERE id=?").get(id);
    if (!j) throw notFound("Job not found.");
    tx(() => {
      db.prepare("DELETE FROM jobs WHERE id=?").run(id); // cascades to applications, threads and messages
      audit(ctx, "delete_job", "job", id, j.title);
    });
    return { ok: true };
  });

  // Applications across the marketplace: ?status= ?jobId=
  r.get("/api/admin/applications", admin, (ctx) => {
    const { limit, offset } = paging(ctx.query);
    const where = ["1=1"];
    const args = [];
    if (STATUSES.includes(ctx.query.status)) { where.push("a.status = ?"); args.push(ctx.query.status); }
    if (ctx.query.jobId) { where.push("a.job_id = ?"); args.push(Number(ctx.query.jobId) || 0); }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM applications a WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db
      .prepare(
        `SELECT a.id, a.status, a.created_at, a.updated_at, a.job_id, a.student_id, a.snap_name, j.title, j.employer_name
         FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    return {
      total, limit, offset,
      applications: rows.map((a) => ({
        id: a.id, status: a.status, at: a.created_at, updatedAt: a.updated_at, jobId: a.job_id, jobTitle: a.title,
        employer: a.employer_name, studentId: a.student_id, studentName: a.snap_name,
      })),
    };
  });

  r.get("/api/admin/audit", admin, (ctx) => {
    const { limit, offset } = paging(ctx.query);
    const rows = db
      .prepare("SELECT id, admin_email, action, target_type, target_id, detail, created_at FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(limit, offset);
    return {
      entries: rows.map((e) => ({ id: e.id, admin: e.admin_email, action: e.action, targetType: e.target_type, targetId: e.target_id, detail: e.detail, at: e.created_at })),
    };
  });
}
