const env = process.env;
const isProd = env.NODE_ENV === "production";

let jwtSecret = env.JWT_SECRET || "";
if (isProd && jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be set to a random string of 32+ characters in production.");
}
if (!jwtSecret) {
  jwtSecret = "dev-only-insecure-secret-do-not-use-in-production";
  console.warn("[config] JWT_SECRET not set. Using an insecure development secret.");
}

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || "data/safar.db",
  jwtSecret,
  tokenTtlSeconds: 7 * 24 * 3600,
  corsOrigins: (env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean),
  trustProxy: env.TRUST_PROXY === "1",
  seedDemoUsers: env.SEED_DEMO_USERS ? env.SEED_DEMO_USERS === "1" : !isProd,
  allowDemoReset: env.ALLOW_DEMO_RESET === "1" && !isProd,
  maxBodyBytes: 2 * 1024 * 1024,
  authRateMax: Number(env.AUTH_RATE_MAX || 20), // login/register attempts per IP per 15 minutes
  generalRateMax: Number(env.RATE_MAX || 300), // all API calls per IP per minute
  // Optional one-time admin bootstrap (see README). Only used when ADMIN_EMAIL and ADMIN_PASSWORD are both set.
  adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || "",
  adminName: (env.ADMIN_NAME || "SAFAR Admin").trim(),
};
