import { db } from "./db.js";
import { hashPassword, revokeUserSessions } from "./auth.js";

export const MIN_ADMIN_PASSWORD = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create an admin account (or, with resetPassword, set a new password on an existing admin).
 * Admins can only be created through this function (CLI or ADMIN_EMAIL/ADMIN_PASSWORD at startup),
 * never through the public API. An existing student/business account is never promoted.
 */
export async function provisionAdmin({ email, name = "SAFAR Admin", password, resetPassword = false }) {
  email = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error("A valid admin email is required.");
  if (typeof password !== "string" || password.length < MIN_ADMIN_PASSWORD)
    throw new Error(`Admin password must be at least ${MIN_ADMIN_PASSWORD} characters.`);
  const existing = db.prepare("SELECT id, role FROM users WHERE email = ?").get(email);
  if (existing && existing.role !== "admin") throw new Error(`${email} already belongs to a ${existing.role} account. Use a different email for the admin.`);
  const hash = await hashPassword(password);
  if (existing) {
    if (!resetPassword) return { created: false, id: existing.id };
    db.prepare("UPDATE users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?").run(hash, Date.now(), existing.id);
    revokeUserSessions(existing.id);
    return { created: false, updated: true, id: existing.id };
  }
  const now = Date.now();
  const id = Number(
    db.prepare("INSERT INTO users (email, password_hash, role, name, status, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?)")
      .run(email, hash, "admin", String(name).trim().slice(0, 80) || "SAFAR Admin", now, now).lastInsertRowid,
  );
  return { created: true, id };
}
