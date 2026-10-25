import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RESET_SQL, db, tx } from "./db.js";
import { config } from "./config.js";
import { hashPassword } from "./auth.js";

const seedData = JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8"));
const DAY = 864e5;
export const DEMO_PASSWORD = "safar-demo-123";

/**
 * Seed the 18 sample jobs. With demo users enabled it also creates a demo student, a demo employer
 * and the sample applicants/conversations from the prototype. Does nothing if jobs already exist.
 */
export async function seedIfEmpty({ demoUsers = config.seedDemoUsers } = {}) {
  if (db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n > 0) return false;
  const now = Date.now();
  const pw = demoUsers ? await hashPassword(DEMO_PASSWORD) : null;

  tx(() => {
    const mkUser = (email, hash, role, name) =>
      Number(db.prepare("INSERT INTO users (email, password_hash, role, name, created_at) VALUES (?,?,?,?,?)").run(email, hash, role, name, now).lastInsertRowid);

    let employerId = null;
    let studentId = null;
    if (demoUsers) {
      employerId = mkUser("employer@safar.demo", pw, "employer", "Valley Events & Tours");
      db.prepare("INSERT INTO employer_profiles (user_id, company_name, town) VALUES (?,?,?)").run(employerId, seedData.employer.name, seedData.employer.town);
      studentId = mkUser("student@safar.demo", pw, "student", seedData.demoStudent.name);
      db.prepare("INSERT INTO student_profiles (user_id, study, location, skills, availability) VALUES (?,?,?,?,?)").run(
        studentId, seedData.demoStudent.study, seedData.demoStudent.location,
        JSON.stringify(seedData.demoStudent.skills), JSON.stringify(seedData.demoStudent.availability),
      );
    }

    const jobIds = {};
    const insJob = db.prepare(
      `INSERT INTO jobs (owner_id, employer_name, title, location, type, sector, pay_min, pay_max, unit, skills, schedule, description, image, posted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const j of seedData.jobs) {
      jobIds[j.key] = Number(
        insJob.run(
          j.ownedByDemoEmployer ? employerId : null, j.employer, j.title, j.location, j.type, j.sector, j.payMin, j.payMax, j.unit,
          JSON.stringify(j.skills), JSON.stringify(j.schedule), j.description, j.image || "", now - j.daysAgo * DAY,
        ).lastInsertRowid,
      );
    }
    if (!demoUsers) return;

    for (const k of seedData.savedKeys) db.prepare("INSERT INTO saved_jobs (user_id, job_id, created_at) VALUES (?,?,?)").run(studentId, jobIds[k], now);

    // Sample applicants are placeholder accounts (no password), so they cannot log in.
    const applicantIds = {};
    for (const a of seedData.applicants) {
      const uid = (applicantIds[a.name] ||= mkUser(`${a.name.toLowerCase().replace(/[^a-z]+/g, ".")}@seed.local`, null, "student", a.name));
      db.prepare("INSERT OR IGNORE INTO student_profiles (user_id, location, skills, availability) VALUES (?,?,?,?)").run(uid, a.location, JSON.stringify(a.skills), JSON.stringify(a.availability));
      const t = now - a.daysAgo * DAY;
      db.prepare(
        `INSERT INTO applications (job_id, student_id, note, status, snap_name, snap_location, snap_skills, snap_availability, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(jobIds[a.jobKey], uid, a.note, a.status, a.name, a.location, JSON.stringify(a.skills), JSON.stringify(a.availability), t, t);
    }

    for (const th of seedData.threads) {
      const sid = th.who === "me" ? studentId : applicantIds[th.who];
      const last = Math.max(...th.msgs.map((m) => now - m.daysAgo * DAY));
      const tid = Number(
        db.prepare("INSERT INTO threads (job_id, student_id, unread_student, unread_employer, last_at) VALUES (?,?,?,?,?)")
          .run(jobIds[th.jobKey], sid, th.unread.student, th.unread.employer, last).lastInsertRowid,
      );
      for (const m of th.msgs)
        db.prepare("INSERT INTO messages (thread_id, sender, body, created_at) VALUES (?,?,?,?)").run(tid, m.from, m.text, now - m.daysAgo * DAY);
    }
  });
  return true;
}

// CLI: `npm run seed` wipes all data and re-seeds.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--reset")) {
    if (config.isProd) {
      console.error("Refusing to wipe the database when NODE_ENV=production.");
      process.exit(1);
    }
    db.exec(RESET_SQL);
  }
  const did = await seedIfEmpty();
  console.log(did ? `Seeded database at ${config.dbPath}${config.seedDemoUsers ? " (demo logins: student@safar.demo / employer@safar.demo, password " + DEMO_PASSWORD + ")" : ""}` : "Database already has data. Use --reset to wipe it.");
}
