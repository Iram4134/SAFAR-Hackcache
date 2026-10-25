# SAFAR backend

REST API + static hosting for the SAFAR student job marketplace (Jammu & Kashmir). It replaces the
prototype's `localStorage` with a real database, accounts, and server-side rules.

**Zero npm dependencies.** Uses only Node built-ins (`node:http`, `node:sqlite`, `node:crypto`).
Needs **Node 22.13 or newer**. No `npm install` step.

## Run it

```bash
cp .env.example .env      # optional in development
npm start                 # http://localhost:3000  (serves the site and the API)
npm test                  # 31 automated tests (accounts, roles, admin, privacy, persistence, core features)
```

On first start it creates `data/safar.db` and loads the 18 sample jobs. In development it also creates
demo accounts (password `safar-demo-123`):

| Login | Role | Notes |
|---|---|---|
| `student@safar.demo` | student | same profile as the prototype's "Demo Student" |
| `employer@safar.demo` | employer | owns the Event Assistant and Portrait Photographer jobs, has sample applicants |

`npm run seed` **wipes the database** and re-seeds (development only; it refuses to run with `NODE_ENV=production`).
Do not run it against data you want to keep.

## What it does

- **Accounts:** register/login as student or business (the backend role is called `employer` everywhere), scrypt password
  hashes, signed 7-day tokens backed by server-side sessions, so **logout really ends the session**. Accounts have a
  status (`active` / `disabled`). Admins are a third role that can only be created by an operator (see below).
- **Jobs:** public browse with search, type/location/sector filters, "fits my free time", sort by match/new/pay.
  Signed-in students get the same **match score** as the frontend (skills 50 + location 30 + free time 20).
- **Employers:** post, edit, close/reopen and delete their own listings; photo upload (JPEG/PNG/WebP up to ~1 MB, or https URL).
- **Applications:** apply once per job with a note; the employer sees a snapshot of the student's profile as it was
  at apply time. Pipeline: Applied → Shortlisted → Interview → Hired / Rejected.
- **Messages:** one thread per student and job, unread counters, interview-time cards and offer cards.
  Proposing times picks up to 3 slots that fit both the job's shifts and the student's free time.
  Accepting an interview moves the application to Interview; accepting an offer moves it to Hired.
- **Saved jobs** per student.

## Accounts, roles and switching

- The site opens on a public homepage: anyone can browse and search jobs. Saving, applying and messaging need a **student**
  account; posting jobs and managing applicants need a **business** account.
- **STUDENT PROFILE** / **BUSINESS PROFILE** (top right) open the matching sign-in page when you are signed out, and the
  matching dashboard when you are signed in with that role. They never switch roles: a signed-in student who clicks
  BUSINESS PROFILE gets a message asking them to **Log out** first. After logout you land on the public homepage.
- Enforced on the server, not just in the page: every private endpoint checks the token and the role
  (`401` no/invalid session, `403` wrong role). The sign-in forms also send the role they are for, so a business account
  cannot be signed in through the student form.
- Profiles are only ever "my own profile" (`/api/profile`, `/api/business/profile`); there is no `/profile/:id`.
- Business profile: business name, town, contact person, business email, phone, description. Contact details are visible
  only to the business itself and to administrators.

## Admin dashboard

Open `/admin.html` (the **Admin Dashboard** link also appears on the main site, only while signed in as an admin).
The page itself is just a shell: all data comes from `/api/admin/*`, and **every** admin endpoint requires a valid
session whose role is `admin`, checked on the server. Admins can see totals, search and filter students, businesses, jobs and applications,
open a detailed record, activate/deactivate accounts (this also signs the person out everywhere), and close/reopen/delete
listings. Password hashes, tokens and session data are never returned. Every admin action, including opening a person's
record, is written to an audit log (admin email, action, target, time, IP; never passwords or tokens), shown under
"Admin activity log". Admin accounts cannot be deactivated from the dashboard, so nobody can lock themselves out.

### Creating the first admin (there is no default admin)

Choose one:

```bash
# 1. CLI (recommended). The password is typed at a hidden prompt, or taken from ADMIN_PASSWORD, never from arguments.
npm run admin:create -- --email you@example.com --name "Your Name"
npm run admin:create -- --email you@example.com --reset-password     # new password for an existing admin

# 2. Environment, applied once at startup if that email does not exist yet
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='at-least-12-characters' npm start     # then remove ADMIN_PASSWORD
```

Passwords must be 12+ characters. An existing student or business account is never promoted to admin.

## Environment variables

See `.env.example`. Main ones: `PORT`, `DB_PATH`, `NODE_ENV`, `JWT_SECRET` (required, 32+ chars, in production),
`CORS_ORIGIN`, `TRUST_PROXY`, `SEED_DEMO_USERS`, `ALLOW_DEMO_RESET`, `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`,
`AUTH_RATE_MAX` (login/register attempts per IP per 15 min, default 20), `RATE_MAX` (all API calls per IP per minute, default 300).

## Database and migrations

SQLite (`data/safar.db`). The schema is upgraded automatically on startup using `PRAGMA user_version`; existing rows are
copied, never dropped. The first upgrade of a non-empty database file writes a backup next to it
(`safar.db.pre-v2.bak`). Version 2 adds: `users.status`, `users.updated_at`, `users.last_login_at`, the `admin` role,
`sessions` and `audit_log` tables, business contact fields (`contact_email`, `phone`, `description`) and extra indexes.
Tokens issued before the upgrade stop working, so users sign in once more.
Student data, business data, jobs, applications, messages and sessions all live in this one database (foreign keys, unique
constraints, and transactions wherever several records change together). The browser stores only the session token and
UI preferences (theme, "guide dismissed").

## API

All paths are under `/api`. Send `Authorization: Bearer <token>`. Errors look like
`{"error":{"message":"…","details":{"field":"…"}}}` (422 carries per-field messages).

| | Endpoint | Who |
|---|---|---|
| | `GET /health`, `GET /meta` (skills, towns, sectors, slots…) | anyone |
| Auth | `POST /auth/register` (student or employer only), `POST /auth/login` (optional `expectedRole`), `POST /auth/logout`, `GET /me` | anyone / signed in |
| Profile | `GET /profile`, `PUT /profile` (partial: name, study, location, skills, availability) | student |
| | `GET /business/profile`, `PUT /business/profile` (partial: contactName, companyName, town, contactEmail, phone, description) | employer |
| Admin | `GET /admin/stats`, `GET /admin/students`, `GET /admin/students/:id`, `GET /admin/businesses`, `GET /admin/businesses/:id`, `PATCH /admin/users/:id/status`, `GET /admin/jobs`, `PATCH`/`DELETE /admin/jobs/:id`, `GET /admin/applications`, `GET /admin/audit` | admin only |
| Jobs | `GET /jobs`, `GET /jobs/:id` | anyone (students get `match`, `saved`, `application`) |
| | `POST /jobs`, `PATCH /jobs/:id`, `DELETE /jobs/:id`, `GET /employer/jobs` | employer (own jobs) |
| Saved | `GET /saved`, `PUT /saved/:jobId`, `DELETE /saved/:jobId` | student |
| Apply | `POST /jobs/:id/applications`, `GET /applications/mine` | student |
| | `GET /applications?jobId=&status=`, `PATCH /applications/:id` `{status}` | employer |
| Chat | `GET /threads` (`?include=messages` adds all messages without marking read), `POST /threads`, `GET /threads/:id` (marks read), `POST /threads/:id/messages` | participants |
| | `POST /threads/:id/interview`, `POST /threads/:id/offer` | employer |
| | `POST /threads/:id/messages/:mid/respond` `{action: pick\|none\|accept\|decline, slot}` | student |

Job and application JSON uses the **same field names as the frontend** (`pay: [min, max]`, `desc`, `img`,
`postedAt`, `applicant`, `msgs`-style `f`/`t`/`at`), so existing rendering code keeps working.

## The website

`public/index.html` is the SAFAR single-page site, now backed by the API through `public/safar-api.js` (`window.SafarAPI`).
Jobs, profiles, saved jobs, applications and messages are all read from and written to the server; nothing is kept in
`localStorage` except the session token and UI preferences. The inbox refreshes when you open Messages/Applications/Dashboard
and every 20 seconds while the tab is visible. A rejected or expired session sends the user back to the sign-in page.

## Production notes

- Set `NODE_ENV=production` and a 32+ character `JWT_SECRET` (the server refuses to start without one).
  Demo accounts (and the demo-login helper on the sign-in page) are off by default in production. Create your admin with `npm run admin:create`.
- Put it behind HTTPS (Nginx, Caddy, Render, Railway…) and set `TRUST_PROXY=1` so rate limiting sees real IPs.
- If the frontend is on another domain, set `CORS_ORIGIN=https://your-site.example`.
- Back up `data/safar.db` (SQLite, WAL mode).

## Testing

```bash
npm test      # node --test: 31 tests, no extra packages
```

Covers: student/business registration and login, duplicate emails, validation, no plain-text passwords, anonymous access to
private endpoints, student vs business vs admin separation, admin access to student/business records (and no secrets in
responses), cross-user access to profiles/applications/conversations, logout invalidating the session, profile persistence
across logout/login, persistence across a real server restart (separate processes), forged/expired/tampered tokens,
rate limiting, admin bootstrap, upgrading a database from the original schema without data loss, and the original core
features (jobs, matching, saved, applications, hiring flow, messaging).

## Known limits

- **The frontend is not covered by `npm test`.** It was exercised in a real browser (Chromium via Playwright) during
  development, but those scripts are not part of the project.
- The session token lives in `localStorage` (7-day expiry, revocable on the server). That is simple but readable by any
  script running on the page, so keep the site free of third-party scripts; an HttpOnly cookie would be the next hardening step.
- `/admin.html` is a public static page that shows nothing until the server confirms an admin session; the protection is on the API.
- No Content-Security-Policy header yet (the single-file site uses inline scripts and styles).
- **No email verification or password reset yet**, and no employer verification. Worth adding before public launch.
  Admin password resets are done from the command line.
- Rate limiting is in memory, per process (login/register: 20 per 15 min per IP by default; everything: 300 per minute).
- SQLite means a single server. Fine for thousands of users; move to Postgres beyond that.
- The website loads up to 500 open jobs at once and filters them in the browser; add server-side paging in the UI beyond that.
- Seed jobs from companies without an account can receive messages, but nobody answers.
- Chat is request/response with polling; WebSockets would be a later upgrade.
- Job photos are stored in the database as data URLs. Move to object storage if volume grows.
- Admins can close, reopen and delete listings and deactivate accounts, but cannot edit people's profiles or delete accounts.
