import { db } from "../db.js";
import { requireRole } from "../auth.js";
import { idParam, notFound } from "../http.js";
import { toJob } from "../models.js";

export default function (r) {
  r.get("/api/saved", requireRole("student"), (ctx) => {
    const rows = db
      .prepare("SELECT j.* FROM saved_jobs s JOIN jobs j ON j.id = s.job_id WHERE s.user_id = ? ORDER BY s.created_at DESC")
      .all(ctx.user.id);
    const jobs = rows.map((j) => toJob(j, ctx.user)).sort((a, b) => b.match.total - a.match.total || b.postedAt - a.postedAt);
    return { jobs };
  });

  // Idempotent: saving twice is fine.
  r.put("/api/saved/:jobId", requireRole("student"), (ctx) => {
    const jobId = idParam(ctx, "jobId");
    if (!db.prepare("SELECT 1 FROM jobs WHERE id=?").get(jobId)) throw notFound("Job not found.");
    db.prepare("INSERT OR IGNORE INTO saved_jobs (user_id, job_id, created_at) VALUES (?,?,?)").run(ctx.user.id, jobId, Date.now());
    return { saved: true };
  });

  r.delete("/api/saved/:jobId", requireRole("student"), (ctx) => {
    db.prepare("DELETE FROM saved_jobs WHERE user_id=? AND job_id=?").run(ctx.user.id, idParam(ctx, "jobId"));
    return { saved: false };
  });
}
