import { config } from "./config.js";
import { createApp } from "./app.js";
import { seedIfEmpty } from "./seed.js";
import { db } from "./db.js";
import { provisionAdmin } from "./admin-provision.js";
import { purgeOldSessions } from "./auth.js";

const seeded = await seedIfEmpty();
if (seeded) console.log("[seed] Loaded sample jobs" + (config.seedDemoUsers ? " and demo accounts (see README)." : "."));

// Optional admin bootstrap: only when both variables are set. Never promotes an existing student/business.
if (config.adminEmail && config.adminPassword) {
  try {
    const r = await provisionAdmin({ email: config.adminEmail, name: config.adminName, password: config.adminPassword });
    if (r.created) console.log(`[admin] Created admin account ${config.adminEmail}. Remove ADMIN_PASSWORD from your environment now.`);
  } catch (e) {
    console.error("[admin] Could not create the admin account:", e.message);
  }
}
purgeOldSessions();
setInterval(purgeOldSessions, 6 * 3600_000).unref();

const server = createApp();
server.listen(config.port, () => console.log(`SAFAR running at http://localhost:${config.port}  (${config.isProd ? "production" : "development"})`));

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => {
  console.log("[shutdown] Received SIGTERM");
  shutdown();
});
process.on("SIGINT", () => {
  console.log("[shutdown] Received SIGINT");
  shutdown();
});

