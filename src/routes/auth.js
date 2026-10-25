import { db, tx } from "../db.js";
import { hashPassword, issueToken, requireAuth, revokeSession, verifyPassword } from "../auth.js";
import { HttpError, conflict, forbidden, send } from "../http.js";
import { parse, v } from "../validate.js";
import { TOWNS } from "../constants.js";
import { getBusinessProfile, getStudentProfile } from "../models.js";

export function publicUser(u) {
  const out = { id: u.id, email: u.email, role: u.role, name: u.name };
  if (u.role === "student") out.profile = getStudentProfile(u.id);
  else if (u.role === "employer") out.company = getBusinessProfile(u.id);
  return out;
}

const ROLE_LABEL = { student: "student", employer: "business", admin: "admin" };

export default function (r, { authLimiter }) {
  // Public sign-up is only ever for students and businesses. Admin accounts cannot be created here.
  r.post("/api/auth/register", authLimiter, async (ctx) => {
    const base = parse(
      { email: v.email(), password: v.password(), role: v.oneOf(["student", "employer"]), name: v.string({ min: 1, max: 80 }) },
      ctx.body,
    );
    const extra =
      base.role === "employer"
        ? parse(
            {
              companyName: v.string({ min: 2, max: 100 }),
              town: v.oneOf(TOWNS),
              contactEmail: v.optionalEmail(),
              phone: v.phone(),
              description: v.string({ max: 1000, optional: true }),
            },
            ctx.body,
          )
        : {};
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(base.email)) throw conflict("An account with this email already exists.");
    const hash = await hashPassword(base.password);
    let user;
    try {
      user = tx(() => {
        const now = Date.now();
        const id = Number(
          db.prepare("INSERT INTO users (email, password_hash, role, name, status, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?)")
            .run(base.email, hash, base.role, base.name, now, now).lastInsertRowid,
        );
        if (base.role === "student") db.prepare("INSERT INTO student_profiles (user_id, updated_at) VALUES (?, ?)").run(id, now);
        else
          db.prepare(
            "INSERT INTO employer_profiles (user_id, company_name, town, contact_email, phone, description, updated_at) VALUES (?,?,?,?,?,?,?)",
          ).run(id, extra.companyName, extra.town, extra.contactEmail || base.email, extra.phone, extra.description || "", now);
        return db.prepare("SELECT id, email, role, name FROM users WHERE id=?").get(id);
      });
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw conflict("An account with this email already exists.");
      throw e;
    }
    return send(201, { token: issueToken(user), user: publicUser(user) });
  });

  // `expectedRole` is optional. The website's student and business forms send it so that a business
  // account cannot be signed in through the student form (and vice versa). Admins use their own page.
  r.post("/api/auth/login", authLimiter, async (ctx) => {
    const { email, password } = parse({ email: v.email(), password: v.string({ min: 1, max: 128, trim: false }) }, ctx.body);
    const expectedRole = ctx.body.expectedRole;
    if (expectedRole !== undefined && !["student", "employer", "admin"].includes(expectedRole))
      throw new HttpError(422, "Some fields need attention.", { expectedRole: "expectedRole must be one of: student, employer, admin" });
    const row = db.prepare("SELECT id, email, role, name, status, password_hash FROM users WHERE email=?").get(email);
    const ok = await verifyPassword(password, row?.password_hash);
    if (!row || !ok) throw new HttpError(401, "Email or password is incorrect.");
    if (row.status !== "active") throw forbidden("This account has been deactivated. Please contact SAFAR support.");
    if (expectedRole !== undefined && expectedRole !== row.role)
      throw forbidden(`This email belongs to a ${ROLE_LABEL[row.role]} account. Use the ${ROLE_LABEL[row.role]} sign-in instead.`);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), row.id);
    const user = { id: row.id, email: row.email, role: row.role, name: row.name };
    return { token: issueToken(user), user: publicUser(user) };
  });

  // Ends the current session on the server. The token stops working immediately, even if someone kept a copy.
  r.post("/api/auth/logout", requireAuth, (ctx) => {
    revokeSession(ctx.sessionId);
    return { ok: true };
  });

  r.get("/api/me", requireAuth, (ctx) => ({ user: publicUser(ctx.user) }));
}
