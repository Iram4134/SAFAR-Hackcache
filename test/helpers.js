// Shared setup for the test files. Each test file runs in its own process, so these env vars apply per file.
process.env.DB_PATH ||= ":memory:";
process.env.NODE_ENV = "test";
process.env.SEED_DEMO_USERS = "1";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-12345";
process.env.AUTH_RATE_MAX ||= "1000";
process.env.RATE_MAX ||= "100000";

export const SECRET = process.env.JWT_SECRET;
export const PASSWORD = "safar-demo-123";

export async function startApp(opts) {
  const { createApp } = await import("../src/app.js");
  const { seedIfEmpty } = await import("../src/seed.js");
  await seedIfEmpty();
  const server = createApp(opts);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, { token, body, headers } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return { server, base, api, close: () => new Promise((r) => server.close(r)) };
}

let n = 0;
export const uniqueEmail = (p = "user") => `${p}.${Date.now()}.${++n}@example.test`;

export const studentBody = (o = {}) => ({ email: uniqueEmail("stu"), password: "correct-horse-1", role: "student", name: "Test Student", ...o });
export const businessBody = (o = {}) => ({
  email: uniqueEmail("biz"), password: "correct-horse-1", role: "employer", name: "Biz Owner",
  companyName: "Chinar Cafe", town: "Srinagar", phone: "+91 99060 12345", description: "Small cafe near Lal Chowk.", ...o,
});
