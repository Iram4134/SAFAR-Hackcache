import { db, tx } from "../db.js";
import { requireAuth } from "../auth.js";
import { badRequest, conflict, forbidden, idParam, notFound, send } from "../http.js";
import { parse, v } from "../validate.js";
import { SLOTS, SLOT_KEYS } from "../constants.js";
import { commonSlots, slotLabel, whenText } from "../matching.js";
import { ensureThread, json, postMessage, toApplication, toJob, toMessage } from "../models.js";

const side = (user) => (user.role === "student" ? "student" : "employer");
const payText = (j) => `₹${new Intl.NumberFormat("en-IN").format(j.pay_min)}–${new Intl.NumberFormat("en-IN").format(j.pay_max)} /${j.unit}`;

/** Load a thread and check the caller is a participant (the student, or the job's owner). */
function loadThread(ctx) {
  const t = db.prepare("SELECT * FROM threads WHERE id=?").get(idParam(ctx));
  if (!t) throw notFound("Conversation not found.");
  const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(t.job_id);
  const isStudent = ctx.user.role === "student" && t.student_id === ctx.user.id;
  const isOwner = ctx.user.role === "employer" && job.owner_id === ctx.user.id;
  if (!isStudent && !isOwner) throw notFound("Conversation not found."); // 404 so ids can't be probed
  const app = db.prepare("SELECT * FROM applications WHERE job_id=? AND student_id=?").get(t.job_id, t.student_id);
  return { t, job, app };
}

function summary(t, user) {
  const job = db.prepare("SELECT id, title, employer_name FROM jobs WHERE id=?").get(t.job_id);
  const student = db.prepare("SELECT id, name FROM users WHERE id=?").get(t.student_id);
  const last = db.prepare("SELECT sender, body, kind, created_at FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 1").get(t.id);
  const app = db.prepare("SELECT id, status FROM applications WHERE job_id=? AND student_id=?").get(t.job_id, t.student_id);
  return {
    id: t.id,
    jobId: job.id,
    jobTitle: job.title,
    employer: job.employer_name,
    studentId: student.id,
    studentName: student.name,
    counterpart: user.role === "student" ? job.employer_name : student.name,
    unread: t[`unread_${side(user)}`],
    lastAt: t.last_at,
    last: last ? { f: last.sender, t: last.kind ? (last.kind === "offer" ? "Job offer" : "Interview times") : last.body, at: last.created_at } : null,
    application: app ? { id: app.id, status: app.status } : null,
  };
}

function detail(t, job, app, user) {
  const msgs = db.prepare("SELECT * FROM messages WHERE thread_id=? ORDER BY id").all(t.id).map(toMessage);
  return {
    thread: {
      ...summary(t, user),
      messages: msgs,
      application: app ? toApplication(app, user, toJob(job)) : null,
    },
  };
}

export default function (r) {
  r.get("/api/threads", requireAuth, (ctx) => {
    const rows =
      ctx.user.role === "student"
        ? db.prepare("SELECT * FROM threads WHERE student_id=? ORDER BY last_at DESC").all(ctx.user.id)
        : db.prepare("SELECT t.* FROM threads t JOIN jobs j ON j.id = t.job_id WHERE j.owner_id=? ORDER BY t.last_at DESC").all(ctx.user.id);
    // ?include=messages adds every message of every thread in one call (does not mark anything as read),
    // which is what the website uses to keep its inbox in sync.
    const withMessages = ctx.query.include === "messages";
    const threads = rows.map((t) => ({
      ...summary(t, ctx.user),
      ...(withMessages ? { messages: db.prepare("SELECT * FROM messages WHERE thread_id=? ORDER BY id").all(t.id).map(toMessage) } : {}),
    }));
    return { unreadTotal: threads.reduce((n, t) => n + t.unread, 0), threads };
  });

  // Open (or reuse) a conversation. Students: { jobId }. Employers: { jobId, studentId } for an existing applicant.
  r.post("/api/threads", requireAuth, (ctx) => {
    const body = parse({ jobId: v.int({ min: 1 }), studentId: v.int({ min: 1 }) }, ctx.body, { partial: true });
    if (!body.jobId) throw badRequest("jobId is required.");
    const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(body.jobId);
    if (!job) throw notFound("Job not found.");
    let studentId;
    if (ctx.user.role === "student") studentId = ctx.user.id;
    else {
      if (job.owner_id !== ctx.user.id) throw forbidden("This job belongs to another employer.");
      studentId = body.studentId;
      if (!studentId) throw badRequest("studentId is required.");
      if (!db.prepare("SELECT 1 FROM applications WHERE job_id=? AND student_id=?").get(job.id, studentId))
        throw forbidden("You can only message students who applied to this job.");
    }
    const existed = db.prepare("SELECT 1 FROM threads WHERE job_id=? AND student_id=?").get(job.id, studentId);
    const t = ensureThread(job.id, studentId);
    return send(existed ? 200 : 201, { thread: { id: t.id } });
  });

  // Full conversation. Opening it marks it read for the caller.
  r.get("/api/threads/:id", requireAuth, (ctx) => {
    const { t, job, app } = loadThread(ctx);
    db.prepare(`UPDATE threads SET unread_${side(ctx.user)} = 0 WHERE id=?`).run(t.id);
    return detail({ ...t, [`unread_${side(ctx.user)}`]: 0 }, job, app, ctx.user);
  });

  r.post("/api/threads/:id/messages", requireAuth, (ctx) => {
    const { t } = loadThread(ctx);
    const { text } = parse({ text: v.string({ min: 1, max: 2000 }) }, ctx.body);
    const id = postMessage(t.id, ctx.user.role === "student" ? "s" : "e", text);
    return send(201, { message: toMessage(db.prepare("SELECT * FROM messages WHERE id=?").get(id)) });
  });

  // Employer proposes interview times. Defaults to up to 3 slots common to the job's shifts and the
  // applicant's free time; pass { slots: [...] } to choose your own.
  r.post("/api/threads/:id/interview", requireAuth, (ctx) => {
    const { t, job, app } = loadThread(ctx);
    if (ctx.user.role !== "employer") throw forbidden("Only the employer can propose interview times.");
    if (!app) throw conflict("This student has not applied yet.");
    if (!["Shortlisted", "Interview"].includes(app.status)) throw conflict("Shortlist the applicant before proposing interview times.");
    if (db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND kind='interview' AND state='pending'").get(t.id))
      throw conflict("An interview request is already waiting for a reply.");
    const { slots: custom } = parse({ slots: v.pick(SLOT_KEYS, { min: 1, max: 5 }) }, ctx.body ?? {}, { partial: true });
    const person = { availability: json(app.snap_availability) };
    const slots = custom || commonSlots({ schedule: json(job.schedule) }, person);
    if (!slots.length) {
      postMessage(t.id, "e", "Your free time and this job’s shifts do not overlap yet. Could you share another time you can come in?");
      return send(200, { proposed: false, reason: "no_overlap" });
    }
    const id = postMessage(t.id, "e", `Interview for ${job.title}. Please pick a time that works for you.`, { kind: "interview", slots });
    return send(201, { proposed: true, message: toMessage(db.prepare("SELECT * FROM messages WHERE id=?").get(id)) });
  });

  r.post("/api/threads/:id/offer", requireAuth, (ctx) => {
    const { t, job, app } = loadThread(ctx);
    if (ctx.user.role !== "employer") throw forbidden("Only the employer can send an offer.");
    if (!app) throw conflict("This student has not applied yet.");
    if (!["Shortlisted", "Interview"].includes(app.status)) throw conflict(`Cannot send an offer to an applicant who is ${app.status}.`);
    if (db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND kind='offer' AND state='pending'").get(t.id))
      throw conflict("An offer is already waiting for a reply.");
    const text = `${job.title} at ${job.employer_name}. Pay ${payText(job)}. ${whenText(json(job.schedule))}.`;
    const id = postMessage(t.id, "e", text, { kind: "offer" });
    return send(201, { message: toMessage(db.prepare("SELECT * FROM messages WHERE id=?").get(id)) });
  });

  // Student answers an interview or offer card.
  //   interview: { action: "pick", slot: "Sat-Morning" } | { action: "none" }
  //   offer:     { action: "accept" } | { action: "decline" }
  r.post("/api/threads/:id/messages/:messageId/respond", requireAuth, (ctx) => {
    const { t, app } = loadThread(ctx);
    if (ctx.user.role !== "student") throw forbidden("Only the student can respond to this.");
    const m = db.prepare("SELECT * FROM messages WHERE id=? AND thread_id=?").get(idParam(ctx, "messageId"), t.id);
    if (!m || !m.kind) throw notFound("Message not found.");
    if (m.state !== "pending") throw conflict("This has already been answered.");
    const { action, slot } = parse(
      { action: v.oneOf(m.kind === "interview" ? ["pick", "none"] : ["accept", "decline"]), slot: v.string({ optional: true, max: 40 }) },
      ctx.body,
    );
    const setState = db.prepare("UPDATE messages SET state=?, pick=? WHERE id=?");
    const setStatus = db.prepare("UPDATE applications SET status=?, updated_at=? WHERE id=?");
    tx(() => {
      if (m.kind === "interview") {
        if (action === "pick") {
          if (!json(m.slots).includes(slot)) throw badRequest("slot must be one of the proposed times.", { slots: json(m.slots) });
          setState.run("accepted", slot, m.id);
          postMessage(t.id, "s", `I can come on ${slotLabel(slot, SLOTS)}.`);
          if (app) setStatus.run("Interview", Date.now(), app.id);
          postMessage(t.id, "sys", `Interview confirmed: ${slotLabel(slot, SLOTS)}. Status moved to Interview.`, { notify: null });
        } else {
          setState.run("declined", null, m.id);
          postMessage(t.id, "s", "None of these times work for me. Could we find another time?");
          postMessage(t.id, "sys", "Another interview time was requested", { notify: null });
        }
      } else if (action === "accept") {
        setState.run("accepted", null, m.id);
        postMessage(t.id, "s", "I accept the offer. Thank you!");
        if (app) setStatus.run("Hired", Date.now(), app.id);
        postMessage(t.id, "sys", "Offer accepted. Status moved to Hired.", { notify: null });
      } else {
        setState.run("declined", null, m.id);
        postMessage(t.id, "s", "Thank you, but I have to decline this offer.");
        postMessage(t.id, "sys", "Offer declined", { notify: null });
      }
    });
    return { message: toMessage(db.prepare("SELECT * FROM messages WHERE id=?").get(m.id)), applicationStatus: app ? db.prepare("SELECT status FROM applications WHERE id=?").get(app.id).status : null };
  });
}
