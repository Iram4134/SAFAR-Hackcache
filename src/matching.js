import { DAYS, NEAR, REGION, SLOTS } from "./constants.js";

export function locScore(jobLoc, userLoc) {
  if (jobLoc === "Remote") return 1;
  if (jobLoc === userLoc) return 1;
  if (NEAR.some((p) => p.includes(jobLoc) && p.includes(userLoc))) return 0.7;
  if (REGION[jobLoc] && REGION[jobLoc] === REGION[userLoc]) return 0.4;
  return 0;
}

export function locLabel(jobLoc, l) {
  if (jobLoc === "Remote") return "Remote";
  return l === 1 ? "Same town" : l === 0.7 ? "Nearby" : l === 0.4 ? "Same region" : "Different region";
}

/** Same weighting as the frontend: skills 50, location 30, free time 20. */
export function score(job, person) {
  const need = job.skills || [];
  const have = new Set(person.skills || []);
  const matched = need.filter((s) => have.has(s));
  const missing = need.filter((s) => !have.has(s));
  const sk = need.length ? matched.length / need.length : 1;
  const l = locScore(job.location, person.location);
  const sched = job.schedule || [];
  const av = new Set(person.availability || []);
  const fit = sched.filter((k) => av.has(k)).length;
  const a = sched.length ? fit / sched.length : 1;
  const pts = { skills: Math.round(sk * 50), loc: Math.round(l * 30), avail: Math.round(a * 20) };
  return {
    total: pts.skills + pts.loc + pts.avail,
    pts,
    matched,
    missing,
    locationLabel: locLabel(job.location, l),
    slotsFit: fit,
    slotsTotal: sched.length,
    fitsSchedule: sched.length === 0 || a === 1,
  };
}

/** Up to 3 slots that are in both the job's shifts and the person's free time. */
export function commonSlots(job, person) {
  const av = new Set(person.availability || []);
  const c = job.schedule && job.schedule.length ? job.schedule.filter((k) => av.has(k)) : (person.availability || []).slice();
  return c.slice(0, 3);
}

export function slotLabel(key, SLOTS) {
  const [day, slot] = key.split("-");
  const s = SLOTS.find((x) => x.id === slot);
  return `${day} ${s ? `${s.label.toLowerCase()} (${s.time})` : slot}`;
}

function rangeDays(idxs) {
  const out = [];
  let i = 0;
  while (i < idxs.length) {
    let j = i;
    while (j + 1 < idxs.length && idxs[j + 1] === idxs[j] + 1) j++;
    out.push(j - i >= 2 ? `${DAYS[idxs[i]]}–${DAYS[idxs[j]]}` : idxs.slice(i, j + 1).map((k) => DAYS[k]).join(", "));
    i = j + 1;
  }
  return out.join(", ");
}

/** Human text for a schedule, e.g. "Sat, Sun · Morning + Afternoon". Same wording as the frontend. */
export function whenText(keys) {
  if (!keys || !keys.length) return "Flexible hours";
  const byDay = {};
  keys.forEach((k) => {
    const [d, s] = k.split("-");
    (byDay[d] = byDay[d] || new Set()).add(s);
  });
  const groups = {};
  DAYS.forEach((d, i) => {
    if (!byDay[d]) return;
    const sl = SLOTS.filter((s) => byDay[d].has(s.id)).map((s) => s.id);
    const key = sl.join("+");
    (groups[key] = groups[key] || { sl, days: [] }).days.push(i);
  });
  return Object.values(groups)
    .map((g) => `${rangeDays(g.days)} · ${g.sl.length === 3 ? "All day" : g.sl.join(" + ")}`)
    .join("; ");
}
