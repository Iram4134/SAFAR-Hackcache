import { randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { db } from "./db.js";
import { forbidden, unauthorized } from "./http.js";

const scryptAsync = promisify(scrypt);
const N = 16384;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// A throwaway hash so unknown emails cost the same time as wrong passwords.
const DUMMY = await hashPassword("not-a-real-password");

export async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  const key = await scryptAsync(password, salt, expected.length, { N: Number(parts[1]), r: 8, p: 1 });
  return timingSafeEqual(key, expected) && Boolean(stored);
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const sign = (data) => createHmac("sha256", config.jwtSecret).update(data).digest("base64url");

/** Create a server-side session row and return a signed token that points at it (jti = session id). */
export function issueToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const jti = randomBytes(18).toString("base64url");
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    jti, user.id, now * 1000, (now + config.tokenTtlSeconds) * 1000,
  );
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ sub: user.id, role: user.role, jti, iat: now, exp: now + config.tokenTtlSeconds }));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

/** Revoke one session (logout) or every session of a user (deactivation). */
export const revokeSession = (jti) =>
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), jti);
export const revokeUserSessions = (userId) =>
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), userId);
/** Housekeeping: forget sessions that expired more than a day ago. */
export const purgeOldSessions = () =>
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now() - 864e5);

function verifyToken(token) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) return null;
  const good = Buffer.from(sign(`${h}.${p}`));
  const given = Buffer.from(s);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  try {
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    if (header.alg !== "HS256" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

const findSession = db.prepare(
  `SELECT u.id, u.email, u.role, u.name, u.status, s.revoked_at, s.expires_at
   FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
);

/** Valid signature + live (not revoked, not expired) server-side session + active account. */
function loadUser(ctx) {
  const m = /^Bearer (.+)$/.exec(ctx.req.headers.authorization || "");
  if (!m) return null;
  const payload = verifyToken(m[1]);
  if (!payload || typeof payload.jti !== "string") return null; // tokens issued before sessions existed are not accepted
  const row = findSession.get(payload.jti);
  if (!row || row.revoked_at || row.expires_at < Date.now() || row.status !== "active") return null;
  if (row.id !== payload.sub) return null;
  ctx.sessionId = payload.jti;
  return { id: row.id, email: row.email, role: row.role, name: row.name };
}

/** Middleware: attach ctx.user if a valid token is present; never fails. */
export const optionalAuth = (ctx) => {
  ctx.user = loadUser(ctx);
};
/** Middleware: require a valid token. */
export const requireAuth = (ctx) => {
  ctx.user = loadUser(ctx);
  if (!ctx.user) throw unauthorized();
};
/** Middleware factory: require a signed-in user with the given role. */
export const requireRole = (role) => (ctx) => {
  requireAuth(ctx);
  if (ctx.user.role !== role) throw forbidden(`Only ${role} accounts can do this.`);
};
