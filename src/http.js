import { config } from "./config.js";

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (m, d) => new HttpError(400, m, d);
export const unauthorized = (m = "Please sign in.") => new HttpError(401, m);
export const forbidden = (m = "You do not have access to this.") => new HttpError(403, m);
export const notFound = (m = "Not found.") => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);

/** Wrap a handler result so it is sent with a specific status code. */
export const send = (status, body) => ({ __status: status, body });

export class Router {
  routes = [];
  add(method, path, ...handlers) {
    const keys = [];
    const re = new RegExp(
      "^" + path.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$",
    );
    this.routes.push({ method, re, keys, handlers });
  }
  get = (p, ...h) => this.add("GET", p, ...h);
  post = (p, ...h) => this.add("POST", p, ...h);
  put = (p, ...h) => this.add("PUT", p, ...h);
  patch = (p, ...h) => this.add("PATCH", p, ...h);
  delete = (p, ...h) => this.add("DELETE", p, ...h);

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch {
        throw badRequest("Malformed URL.");
      }
      return { route: r, params };
    }
    return { pathMatched };
  }
}

export function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

export async function readJson(req, limit = config.maxBodyBytes) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return undefined;
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > limit) throw new HttpError(413, "Request body is too large.");
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(c);
  }
  if (!size) return {};
  const type = String(req.headers["content-type"] || "");
  if (!type.includes("application/json")) throw new HttpError(415, "Send JSON with Content-Type: application/json.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("Request body is not valid JSON.");
  }
}

/** Fixed-window in-memory rate limiter, keyed by client IP. */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (ctx) => {
    const now = Date.now();
    let h = hits.get(ctx.ip);
    if (!h || h.reset < now) hits.set(ctx.ip, (h = { count: 0, reset: now + windowMs }));
    if (++h.count > max) {
      ctx.res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
      throw new HttpError(429, "Too many requests. Please try again shortly.");
    }
  };
}

export function idParam(ctx, name = "id") {
  const n = Number(ctx.params[name]);
  if (!Number.isInteger(n) || n < 1) throw notFound();
  return n;
}
