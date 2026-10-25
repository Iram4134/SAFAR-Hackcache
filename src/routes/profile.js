import { db, tx } from "../db.js";
import { requireRole } from "../auth.js";
import { parse, v } from "../validate.js";
import { SKILLS, SLOT_KEYS, TOWNS } from "../constants.js";
import { getBusinessProfile, getStudentProfile } from "../models.js";

// Profiles are always addressed as "the signed-in user's own profile". There is no /profile/:id, so one
// user cannot read or change another user's profile by editing a URL or request.
export default function (r) {
  r.get("/api/profile", requireRole("student"), (ctx) => ({ profile: getStudentProfile(ctx.user.id) }));

  // Partial update: send only the fields that changed (the frontend saves field by field).
  r.put("/api/profile", requireRole("student"), (ctx) => {
    const data = parse(
      {
        name: v.string({ min: 1, max: 80 }),
        study: v.string({ max: 80, optional: true }),
        location: v.oneOf(TOWNS),
        skills: v.pick(SKILLS, { max: SKILLS.length }),
        availability: v.pick(SLOT_KEYS, { max: SLOT_KEYS.length }),
      },
      ctx.body,
      { partial: true },
    );
    tx(() => {
      const now = Date.now();
      if (data.name !== undefined) db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(data.name, now, ctx.user.id);
      const cur = getStudentProfile(ctx.user.id);
      db.prepare("UPDATE student_profiles SET study=?, location=?, skills=?, availability=?, updated_at=? WHERE user_id=?").run(
        data.study ?? cur.study,
        data.location ?? cur.location,
        JSON.stringify(data.skills ?? cur.skills),
        JSON.stringify(data.availability ?? cur.availability),
        now,
        ctx.user.id,
      );
    });
    return { profile: getStudentProfile(ctx.user.id) };
  });

  r.get("/api/business/profile", requireRole("employer"), (ctx) => ({
    profile: { contactName: ctx.user.name, email: ctx.user.email, ...getBusinessProfile(ctx.user.id) },
  }));

  // Business profile: company name, town, contact details and description. Renaming the company also
  // updates the name shown on this employer's existing listings.
  r.put("/api/business/profile", requireRole("employer"), (ctx) => {
    const data = parse(
      {
        contactName: v.string({ min: 1, max: 80 }),
        companyName: v.string({ min: 2, max: 100 }),
        town: v.oneOf(TOWNS),
        contactEmail: v.optionalEmail(),
        phone: v.phone(),
        description: v.string({ max: 1000, optional: true }),
      },
      ctx.body,
      { partial: true },
    );
    tx(() => {
      const now = Date.now();
      const cur = getBusinessProfile(ctx.user.id);
      if (data.contactName !== undefined) db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(data.contactName, now, ctx.user.id);
      const next = {
        name: data.companyName ?? cur.name,
        town: data.town ?? cur.town,
        contactEmail: data.contactEmail ?? cur.contactEmail,
        phone: data.phone ?? cur.phone,
        description: data.description ?? cur.description,
      };
      db.prepare("UPDATE employer_profiles SET company_name=?, town=?, contact_email=?, phone=?, description=?, updated_at=? WHERE user_id=?").run(
        next.name, next.town, next.contactEmail, next.phone, next.description, now, ctx.user.id,
      );
      if (next.name !== cur.name) db.prepare("UPDATE jobs SET employer_name=? WHERE owner_id=?").run(next.name, ctx.user.id);
    });
    const u = db.prepare("SELECT name, email FROM users WHERE id=?").get(ctx.user.id);
    return { profile: { contactName: u.name, email: u.email, ...getBusinessProfile(ctx.user.id) } };
  });
}
