import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { HttpError, Router, clientIp, rateLimiter, readJson, send } from "./http.js";
import authRoutes from "./routes/auth.js";
import profileRoutes from "./routes/profile.js";
import jobRoutes from "./routes/jobs.js";
import savedRoutes from "./routes/saved.js";
import applicationRoutes from "./routes/applications.js";
import threadRoutes from "./routes/threads.js";
import adminRoutes from "./routes/admin.js";
import { RESET_SQL, db } from "./db.js";
import { seedIfEmpty } from "./seed.js";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2",
};

/** Each app gets its own router and rate limiters, so tests can start several isolated servers. */
function buildRouter({ authMax, generalMax }) {
  const router = new Router();
  const generalLimit = rateLimiter({ windowMs: 60_000, max: generalMax });
  const authLimiter = rateLimiter({ windowMs: 15 * 60_000, max: authMax }); // brute-force guard on login/register

  router.get("/api/health", () => ({ ok: true, time: Date.now() }));
  authRoutes(router, { authLimiter });
  profileRoutes(router);
  jobRoutes(router);
  savedRoutes(router);
  applicationRoutes(router);
  threadRoutes(router);
  adminRoutes(router);

  // Development only: wipe and re-seed (enable with ALLOW_DEMO_RESET=1, never in production).
  if (config.allowDemoReset) {
    router.post("/api/dev/reset", async () => {
      db.exec(RESET_SQL);
      await seedIfEmpty();
      return { ok: true };
    });
  }
  return { router, generalLimit };
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

function writeJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store" });
  res.end(data);
}

async function serveStatic(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) return writeJson(res, 405, { error: { message: "Method not allowed." } });
  let file = normalize(join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return writeJson(res, 403, { error: { message: "Forbidden." } });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    if (extname(pathname)) return writeJson(res, 404, { error: { message: "Not found." } });
    file = join(PUBLIC_DIR, "index.html"); // single-page app fallback
  }
  try {
    const body = await readFile(file);
    const type = MIME[extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": type.startsWith("text/html") ? "no-cache" : "public, max-age=3600" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    writeJson(res, 404, { error: { message: "Not found." } });
  }
}

async function handle(req, res, { router, generalLimit }) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  if (config.isProd) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return writeJson(res, 400, { error: { message: "Bad URL." } });
  }
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, decodeURIComponent(url.pathname).replace(/\0/g, ""));

  try {
    const ctx = { req, res, ip: clientIp(req), query: Object.fromEntries(url.searchParams), user: null, params: {}, body: undefined };
    generalLimit(ctx);
    const m = router.match(req.method, url.pathname);
    if (!m.route) throw new HttpError(m.pathMatched ? 405 : 404, m.pathMatched ? "Method not allowed." : "Unknown endpoint.");
    ctx.params = m.params;
    ctx.body = await readJson(req);
    let result;
    for (const h of m.route.handlers) result = await h(ctx);
    if (result && result.__status) writeJson(res, result.__status, result.body);
    else writeJson(res, 200, result ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) {
      writeJson(res, e.status, { error: { message: e.message, ...(e.details ? { details: e.details } : {}) } });
    } else {
      console.error("[error]", req.method, req.url, e);
      writeJson(res, 500, { error: { message: "Something went wrong on our side." } });
    }
  }
}

export function createApp({ authMax = config.authRateMax, generalMax = config.generalRateMax } = {}) {
  const parts = buildRouter({ authMax, generalMax });
  return createServer((req, res) => {
    handle(req, res, parts).catch((e) => {
      console.error("[fatal]", e);
      if (!res.headersSent) writeJson(res, 500, { error: { message: "Something went wrong on our side." } });
    });
  });
}
