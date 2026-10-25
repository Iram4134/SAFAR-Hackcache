import { db } from "./db.js";
import { score } from "./matching.js";

export const json = (s) => {
  try { return JSON.parse(s); } catch { return []; }
};

/** Job row -> API shape (same field names as the frontend's job object). */
export function toJob(r, viewer) {
  const job = {
    id: r.id,
    title: r.title,
    employer: r.employer_name,
    location: r.location,
    type: r.type,
    sector: r.sector,
    pay: [r.pay_min, r.pay_max],
    unit: r.unit,
    skills: json(r.skills),
    schedule: json(r.schedule),
    desc: r.description,
    img: r.image,
    status: r.status,
    postedAt: r.posted_at,
    ownerId: r.owner_id,
  };
  if (viewer?.role === "student") {
    const p = getStudentProfile(viewer.id);
    job.match = score(job, p);
    job.saved = Boolean(db.prepare("SELECT 1 FROM saved_jobs WHERE user_id=? AND job_id=?").get(viewer.id, r.id));
    const app = db.prepare("SELECT id, status FROM applications WHERE job_id=? AND student_id=?").get(r.id, viewer.id);
    job.application = app ? { id: app.id, status: app.status } : null;
  }
  return job;
}

export function getStudentProfile(userId) {
  const u = db.prepare("SELECT name FROM users WHERE id=?").get(userId);
  const p = db.prepare("SELECT study, location, skills, availability FROM student_profiles WHERE user_id=?").get(userId);
  return {
    name: u?.name || "",
    study: p?.study || "",
    location: p?.location || "Srinagar",
    skills: json(p?.skills),
    availability: json(p?.availability),
  };
}

export function getBusinessProfile(userId) {
  const r = db
    .prepare("SELECT company_name, town, contact_email, phone, description FROM employer_profiles WHERE user_id=?")
    .get(userId);
  if (!r) return null;
  return { name: r.company_name, town: r.town, contactEmail: r.contact_email, phone: r.phone, description: r.description };
}

/** Application row -> API shape. `viewer` decides the `mine` flag. */
export function toApplication(r, viewer, job) {
  const applicant = { name: r.snap_name, location: r.snap_location, skills: json(r.snap_skills), availability: json(r.snap_availability) };
  const out = {
    id: r.id,
    jobId: r.job_id,
    studentId: r.student_id,
    applicant,
    note: r.note,
    status: r.status,
    at: r.created_at,
    updatedAt: r.updated_at,
    mine: viewer?.id === r.student_id,
  };
  if (job) out.match = score(job, applicant);
  return out;
}

const addMsg = db.prepare(
  "INSERT INTO messages (thread_id, sender, kind, body, slots, state, created_at) VALUES (?,?,?,?,?,?,?)",
);

/**
 * Append a message to a thread and bump the other side's unread counter.
 * sender: 's' student, 'e' employer, 'sys' system (notifies `notify` side).
 */
export function postMessage(threadId, sender, body, { kind = null, slots = null, notify = undefined } = {}) {
  const now = Date.now();
  const id = addMsg.run(threadId, sender, kind, body, slots ? JSON.stringify(slots) : null, kind ? "pending" : null, now).lastInsertRowid;
  // notify: "student" | "employer" | null (no unread bump). Default: the other party.
  const target = notify === undefined ? (sender === "s" ? "employer" : "student") : notify;
  if (target) db.prepare(`UPDATE threads SET unread_${target} = unread_${target} + 1, last_at = ? WHERE id = ?`).run(now, threadId);
  else db.prepare("UPDATE threads SET last_at = ? WHERE id = ?").run(now, threadId);
  return Number(id);
}

export function ensureThread(jobId, studentId) {
  const found = db.prepare("SELECT * FROM threads WHERE job_id=? AND student_id=?").get(jobId, studentId);
  if (found) return found;
  const id = db
    .prepare("INSERT INTO threads (job_id, student_id, last_at) VALUES (?,?,?)")
    .run(jobId, studentId, Date.now()).lastInsertRowid;
  return db.prepare("SELECT * FROM threads WHERE id=?").get(id);
}

export function toMessage(m) {
  return {
    id: m.id,
    f: m.sender,
    t: m.body,
    at: m.created_at,
    ...(m.kind ? { kind: m.kind, slots: json(m.slots), state: m.state, pick: m.pick || null } : {}),
  };
}
