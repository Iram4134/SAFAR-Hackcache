import { db, tx } from "../db.js";
import { requireRole } from "../auth.js";
import { conflict, forbidden, idParam, notFound, send } from "../http.js";
import { parse, v } from "../validate.js";
import { STATUSES } from "../constants.js";
import { ensureThread, getStudentProfile, postMessage, toApplication, toJob } from "../models.js";

const jobOf = (id) => db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
const jobForMatch = (row) => toJob(row);

export default function (r) {
  // Student applies. Creates the application, opens (or reuses) the chat thread and posts the note.
  r.post("/api/jobs/:id/applications", requireRole("student"), (ctx) => {
    const jobId = idParam(ctx);
    const { note } = parse({ note: v.string({ max: 1000, optional: true }) }, ctx.body ?? {});
    const job = jobOf(jobId);
    if (!job) throw notFound("Job not found.");
    if (job.status !== "open") throw conflict("This job is no longer accepting applications.");
    const p = getStudentProfile(ctx.user.id);
    const appId = tx(() => {
      if (db.prepare("SELECT 1 FROM applications WHERE job_id=? AND student_id=?").get(jobId, ctx.user.id))
        throw conflict("You have already applied to this job.");
      const now = Date.now();
      const id = Number(
        db
          .prepare(
            `INSERT INTO applications (job_id, student_id, note, snap_name, snap_location, snap_skills, snap_availability, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(jobId, ctx.user.id, note, p.name || ctx.user.name, p.location, JSON.stringify(p.skills), JSON.stringify(p.availability), now, now)
          .lastInsertRowid,
      );
      const th = ensureThread(jobId, ctx.user.id);
      if (note) postMessage(th.id, "s", note);
      postMessage(th.id, "sys", `Application sent for ${job.title}. ${job.employer_name} will update your status here.`, { notify: "student" });
      return id;
    });
    const row = db.prepare("SELECT * FROM applications WHERE id=?").get(appId);
    return send(201, { application: toApplication(row, ctx.user, jobForMatch(job)) });
  });

  // Student: my applications, newest first, with the job attached.
  r.get("/api/applications/mine", requireRole("student"), (ctx) => {
    const rows = db.prepare("SELECT * FROM applications WHERE student_id=? ORDER BY created_at DESC").all(ctx.user.id);
    return {
      applications: rows.map((a) => ({ ...toApplication(a, ctx.user), job: toJob(jobOf(a.job_id), ctx.user) })),
    };
  });

  // Employer: all applicants across my listings. Optional ?jobId= and ?status=
  r.get("/api/applications", requireRole("employer"), (ctx) => {
    const where = ["j.owner_id = ?"];
    const args = [ctx.user.id];
    if (ctx.query.jobId) { where.push("a.job_id = ?"); args.push(Number(ctx.query.jobId) || 0); }
    if (ctx.query.status && STATUSES.includes(ctx.query.status)) { where.push("a.status = ?"); args.push(ctx.query.status); }
    const rows = db
      .prepare(`SELECT a.* FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC`)
      .all(...args);
    const cache = new Map();
    const job = (id) => cache.get(id) || (cache.set(id, jobForMatch(jobOf(id))), cache.get(id));
    return { applications: rows.map((a) => ({ ...toApplication(a, ctx.user, job(a.job_id)), jobTitle: job(a.job_id).title })) };
  });

  // Employer: my listings with applicant counts per status (dashboard).
  r.get("/api/employer/jobs", requireRole("employer"), (ctx) => {
    const rows = db.prepare("SELECT * FROM jobs WHERE owner_id=? ORDER BY posted_at DESC").all(ctx.user.id);
    const counts = db.prepare("SELECT status, COUNT(*) AS n FROM applications WHERE job_id=? GROUP BY status");
    return {
      jobs: rows.map((j) => {
        const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        for (const c of counts.all(j.id)) byStatus[c.status] = c.n;
        return { ...toJob(j, ctx.user), applicants: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
      }),
    };
  });

  // Employer moves an applicant through the pipeline. Posts a status line into the chat.
  r.patch("/api/applications/:id", requireRole("employer"), (ctx) => {
    const id = idParam(ctx);
    const { status } = parse({ status: v.oneOf(STATUSES) }, ctx.body);
    const app = db.prepare("SELECT * FROM applications WHERE id=?").get(id);
    const job = app && jobOf(app.job_id);
    if (!app || !job) throw notFound("Application not found.");
    if (job.owner_id !== ctx.user.id) throw forbidden("This applicant belongs to another employer.");
    if (app.status !== status) {
      tx(() => {
        db.prepare("UPDATE applications SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), id);
        const th = ensureThread(app.job_id, app.student_id);
        postMessage(th.id, "sys", `Status updated to ${status === "Rejected" ? "Not selected" : status}`, { notify: "student" });
      });
    }
    return { application: toApplication(db.prepare("SELECT * FROM applications WHERE id=?").get(id), ctx.user, jobForMatch(job)) };
  });
}
