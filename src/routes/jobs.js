import { db } from "../db.js";
import { optionalAuth, requireRole } from "../auth.js";
import { HttpError, forbidden, idParam, notFound, send } from "../http.js";
import { parse, v } from "../validate.js";
import { DAYS, JOB_LOCATIONS, SECTORS, SKILLS, SLOTS, SLOT_KEYS, STATUSES, TOWNS, TYPES, UNITS } from "../constants.js";
import { json, toJob } from "../models.js";
import { config } from "../config.js";

const jobShape = {
  title: v.string({ min: 2, max: 100 }),
  location: v.oneOf(JOB_LOCATIONS),
  type: v.oneOf(TYPES),
  sector: v.oneOf(SECTORS),
  unit: v.oneOf(UNITS),
  skills: v.pick(SKILLS, { min: 1, max: 8 }),
  schedule: v.pick(SLOT_KEYS, { max: SLOT_KEYS.length }), // empty = flexible hours
  desc: v.string({ max: 2000, optional: true }),
  img: v.image(),
};
/** pay must be [min, max] with whole rupee amounts and max >= min. Returns null when partial and absent. */
function parsePay(body, { partial = false } = {}) {
  if (partial && body.pay === undefined) return null;
  const fail = (msg) => new HttpError(422, "Some fields need attention.", { pay: msg });
  if (!Array.isArray(body.pay) || body.pay.length !== 2) throw fail("pay must be [min, max], for example [800, 1000]");
  const [min, max] = body.pay.map((n) => (typeof n === "string" && n.trim() !== "" ? Number(n) : n));
  if (![min, max].every((n) => Number.isInteger(n) && n > 0 && n <= 10_000_000)) throw fail("pay amounts must be whole numbers above zero");
  if (max < min) throw fail("pay maximum must be at least the minimum");
  return [min, max];
}

export default function (r) {
  // Public listing. Students who are signed in also get match scores, saved and applied flags.
  // Query: q, type, location, sector, fit=1 (only jobs that fit my free time), sort=match|new|pay, limit, offset
  r.get("/api/jobs", optionalAuth, (ctx) => {
    const q = ctx.query;
    const where = ["status = 'open'"];
    const args = [];
    for (const [param, col] of [["type", "type"], ["location", "location"], ["sector", "sector"]]) {
      if (q[param] && q[param] !== "All") { where.push(`${col} = ?`); args.push(q[param]); }
    }
    let rows = db.prepare(`SELECT * FROM jobs WHERE ${where.join(" AND ")}`).all(...args);
    const needle = (q.q || "").trim().toLowerCase();
    if (needle) {
      rows = rows.filter((j) =>
        [j.title, j.employer_name, j.location, j.sector, j.type, ...json(j.skills)].join(" ").toLowerCase().includes(needle),
      );
    }
    let jobs = rows.map((row) => toJob(row, ctx.user));
    if (q.fit === "1" && ctx.user?.role === "student") jobs = jobs.filter((j) => j.match.fitsSchedule);
    const sort = q.sort || (ctx.user?.role === "student" ? "match" : "new");
    jobs.sort(
      sort === "pay" ? (a, b) => b.pay[1] - a.pay[1] || b.postedAt - a.postedAt
      : sort === "match" && ctx.user?.role === "student" ? (a, b) => b.match.total - a.match.total || b.postedAt - a.postedAt
      : (a, b) => b.postedAt - a.postedAt,
    );
    const total = jobs.length;
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    return { total, limit, offset, jobs: jobs.slice(offset, offset + limit) };
  });

  r.get("/api/jobs/:id", optionalAuth, (ctx) => {
    const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(idParam(ctx));
    // Closed listings stay visible to their owner and to students who already applied.
    if (!row) throw notFound("Job not found.");
    const job = toJob(row, ctx.user);
    if (row.status === "closed" && ctx.user?.id !== row.owner_id && !job.application) throw notFound("Job not found.");
    return { job };
  });

  r.post("/api/jobs", requireRole("employer"), (ctx) => {
    const data = parse(jobShape, ctx.body);
    const pay = parsePay(ctx.body);
    const company = db.prepare("SELECT company_name FROM employer_profiles WHERE user_id=?").get(ctx.user.id);
    const id = db
      .prepare(
        `INSERT INTO jobs (owner_id, employer_name, title, location, type, sector, pay_min, pay_max, unit, skills, schedule, description, image, posted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ctx.user.id, company?.company_name || ctx.user.name, data.title, data.location, data.type, data.sector,
        pay[0], pay[1], data.unit, JSON.stringify(data.skills), JSON.stringify(data.schedule),
        data.desc || "No description added.", data.img, Date.now(),
      ).lastInsertRowid;
    return send(201, { job: toJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(id), ctx.user) });
  });

  // Partial update by the owner. Also used to change the photo (img) or close/reopen (status).
  r.patch("/api/jobs/:id", requireRole("employer"), (ctx) => {
    const id = idParam(ctx);
    const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!row) throw notFound("Job not found.");
    if (row.owner_id !== ctx.user.id) throw forbidden("You can only edit your own listings.");
    const data = parse({ ...jobShape, status: v.oneOf(["open", "closed"]) }, ctx.body, { partial: true });
    const pay = parsePay(ctx.body, { partial: true });
    const next = {
      title: data.title ?? row.title,
      location: data.location ?? row.location,
      type: data.type ?? row.type,
      sector: data.sector ?? row.sector,
      unit: data.unit ?? row.unit,
      skills: JSON.stringify(data.skills ?? json(row.skills)),
      schedule: JSON.stringify(data.schedule ?? json(row.schedule)),
      description: data.desc ?? row.description,
      image: data.img ?? row.image,
      status: data.status ?? row.status,
      pay_min: pay ? pay[0] : row.pay_min,
      pay_max: pay ? pay[1] : row.pay_max,
    };
    db.prepare(
      `UPDATE jobs SET title=:title, location=:location, type=:type, sector=:sector, unit=:unit, skills=:skills,
       schedule=:schedule, description=:description, image=:image, status=:status, pay_min=:pay_min, pay_max=:pay_max WHERE id=:id`,
    ).run({ ...next, id });
    return { job: toJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(id), ctx.user) };
  });

  r.delete("/api/jobs/:id", requireRole("employer"), (ctx) => {
    const id = idParam(ctx);
    const row = db.prepare("SELECT owner_id FROM jobs WHERE id=?").get(id);
    if (!row) throw notFound("Job not found.");
    if (row.owner_id !== ctx.user.id) throw forbidden("You can only delete your own listings.");
    db.prepare("DELETE FROM jobs WHERE id=?").run(id); // cascades to applications, threads, messages
    return { ok: true };
  });

  r.get("/api/meta", () => ({
    days: DAYS, slots: SLOTS, skills: SKILLS, towns: TOWNS, locations: JOB_LOCATIONS,
    sectors: SECTORS, types: TYPES, units: UNITS, statuses: STATUSES,
    // Development convenience only: the sign-in page can pre-fill the demo accounts. Never sent in production.
    demo: config.seedDemoUsers && !config.isProd
      ? { student: "student@safar.demo", employer: "employer@safar.demo", password: "safar-demo-123" }
      : null,
  }));
}
