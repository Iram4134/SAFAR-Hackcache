/* SAFAR API client. Include with <script src="/safar-api.js"></script>, then use window.SafarAPI.
 * Every method returns a promise that resolves to the parsed JSON, or rejects with an Error that has
 * .status (HTTP code) and .details (per-field messages on 422). The token is kept in localStorage. */
(function (root) {
  const TOKEN_KEY = "safar-token";
  let base = ""; // set with SafarAPI.configure({ baseUrl: "https://api.example.com" }) if hosted elsewhere
  const store = {
    get() { try { return root.localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(t) { try { t ? root.localStorage.setItem(TOKEN_KEY, t) : root.localStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  async function call(method, path, body) {
    const token = store.get();
    const res = await fetch(base + "/api" + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && token) { store.set(null); if (root.SafarAPI && root.SafarAPI.onUnauthorized) root.SafarAPI.onUnauthorized(); } // expired, revoked or invalid token
      const err = new Error((data && data.error && data.error.message) || "Request failed");
      err.status = res.status;
      err.details = data && data.error && data.error.details;
      throw err;
    }
    return data;
  }
  const qs = (o) => { const p = new URLSearchParams(Object.entries(o || {}).filter(([, v]) => v !== "" && v != null)); return p.size ? "?" + p : ""; };

  root.SafarAPI = {
    onUnauthorized: null, // set to a function to be told when the server rejects the session (expired, signed out, deactivated)
    configure(o) { if (o.baseUrl != null) base = o.baseUrl.replace(/\/$/, ""); },
    isSignedIn: () => Boolean(store.get()),

    // auth
    async register(o) { const r = await call("POST", "/auth/register", o); store.set(r.token); return r.user; },
    // role ("student" | "employer" | "admin") makes the server refuse accounts of any other role.
    async login(email, password, role) { const r = await call("POST", "/auth/login", { email, password, expectedRole: role }); store.set(r.token); return r.user; },
    // Ends the session on the server, then forgets the token here (even if the network call fails).
    async logout() { try { await call("POST", "/auth/logout"); } catch {} store.set(null); },
    me: () => call("GET", "/me").then((r) => r.user),
    meta: () => call("GET", "/meta"),

    // student profile
    getProfile: () => call("GET", "/profile").then((r) => r.profile),
    saveProfile: (patch) => call("PUT", "/profile", patch).then((r) => r.profile), // {name, study, location, skills, availability}

    // business profile (employer accounts)
    getBusinessProfile: () => call("GET", "/business/profile").then((r) => r.profile),
    saveBusinessProfile: (patch) => call("PUT", "/business/profile", patch).then((r) => r.profile), // {contactName, companyName, town, contactEmail, phone, description}

    // admin (admin accounts only; the server checks the role on every call)
    admin: {
      stats: () => call("GET", "/admin/stats"),
      students: (f) => call("GET", "/admin/students" + qs(f)),
      student: (id) => call("GET", "/admin/students/" + id).then((r) => r.student),
      businesses: (f) => call("GET", "/admin/businesses" + qs(f)),
      business: (id) => call("GET", "/admin/businesses/" + id).then((r) => r.business),
      setStatus: (userId, status) => call("PATCH", "/admin/users/" + userId + "/status", { status }),
      jobs: (f) => call("GET", "/admin/jobs" + qs(f)),
      setJobStatus: (id, status) => call("PATCH", "/admin/jobs/" + id, { status }),
      deleteJob: (id) => call("DELETE", "/admin/jobs/" + id),
      applications: (f) => call("GET", "/admin/applications" + qs(f)),
      audit: (f) => call("GET", "/admin/audit" + qs(f)),
    },

    // jobs
    listJobs: (filters) => call("GET", "/jobs" + qs(filters)),            // {q,type,location,sector,fit:1,sort,limit,offset}
    getJob: (id) => call("GET", "/jobs/" + id).then((r) => r.job),
    postJob: (job) => call("POST", "/jobs", job).then((r) => r.job),      // {title,location,type,sector,pay:[min,max],unit,skills,schedule,desc,img}
    updateJob: (id, patch) => call("PATCH", "/jobs/" + id, patch).then((r) => r.job), // also {status:"closed"} or {img}
    deleteJob: (id) => call("DELETE", "/jobs/" + id),
    myListings: () => call("GET", "/employer/jobs").then((r) => r.jobs),

    // saved
    listSaved: () => call("GET", "/saved").then((r) => r.jobs),
    save: (jobId) => call("PUT", "/saved/" + jobId),
    unsave: (jobId) => call("DELETE", "/saved/" + jobId),

    // applications
    apply: (jobId, note) => call("POST", "/jobs/" + jobId + "/applications", { note }).then((r) => r.application),
    myApplications: () => call("GET", "/applications/mine").then((r) => r.applications),
    applicants: (filters) => call("GET", "/applications" + qs(filters)).then((r) => r.applications), // {jobId,status}
    setStatus: (appId, status) => call("PATCH", "/applications/" + appId, { status }).then((r) => r.application),

    // messages
    threads: () => call("GET", "/threads"),                               // {unreadTotal, threads}
    threadsWithMessages: () => call("GET", "/threads?include=messages"),  // same, plus every message (does not mark read)
    openThread: (jobId, studentId) => call("POST", "/threads", { jobId, studentId }).then((r) => r.thread),
    getThread: (id) => call("GET", "/threads/" + id).then((r) => r.thread), // marks as read
    send: (threadId, text) => call("POST", "/threads/" + threadId + "/messages", { text }).then((r) => r.message),
    proposeInterview: (threadId, slots) => call("POST", "/threads/" + threadId + "/interview", slots ? { slots } : {}),
    sendOffer: (threadId) => call("POST", "/threads/" + threadId + "/offer", {}),
    respond: (threadId, messageId, action, slot) => call("POST", `/threads/${threadId}/messages/${messageId}/respond`, { action, slot }),
  };
})(typeof window !== "undefined" ? window : globalThis);
