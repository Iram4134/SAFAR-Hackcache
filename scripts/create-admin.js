// Create (or reset the password of) an admin account from the command line.
//
//   npm run admin:create -- --email you@example.com --name "Your Name"
//
// The password is read from the ADMIN_PASSWORD environment variable if set, otherwise typed at a hidden
// prompt. It is never accepted as a command-line argument (those end up in shell history and process lists).
// Add --reset-password to set a new password for an admin that already exists.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { provisionAdmin, MIN_ADMIN_PASSWORD } from "../src/admin-provision.js";
import { config } from "../src/config.js";
import { db } from "../src/db.js";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const email = flag("email") || config.adminEmail;
const name = flag("name") || config.adminName;
const resetPassword = args.includes("--reset-password");

function askHidden(question) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
    muted = true;
  });
}

if (!email) {
  console.error('Usage: npm run admin:create -- --email you@example.com [--name "Your Name"] [--reset-password]');
  process.exit(1);
}
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  process.stdout.write(`Password for ${email} (min ${MIN_ADMIN_PASSWORD} characters): `);
  password = await askHidden("");
  process.stdout.write(`Repeat password: `);
  if ((await askHidden("")) !== password) { console.error("Passwords do not match."); process.exit(1); }
}
try {
  const r = await provisionAdmin({ email, name, password, resetPassword });
  console.log(r.created ? `Created admin ${email}.` : r.updated ? `Password updated for ${email}. Existing sessions were signed out.` : `${email} is already an admin. Use --reset-password to change the password.`);
} catch (e) {
  console.error("Error:", e.message);
  process.exitCode = 1;
}
db.close();
