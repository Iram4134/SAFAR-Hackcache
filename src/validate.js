import { HttpError } from "./http.js";

// Each validator takes (value) and returns the cleaned value or throws a string message.
export const v = {
  string({ min = 0, max = 500, optional = false, trim = true } = {}) {
    return (x) => {
      if (x == null || x === "") {
        if (optional || min === 0) return "";
        throw "is required";
      }
      if (typeof x !== "string") throw "must be text";
      const s = trim ? x.trim() : x;
      if (s.length < min) throw min === 1 ? "is required" : `must be at least ${min} characters`;
      if (s.length > max) throw `must be at most ${max} characters`;
      return s;
    };
  },
  email() {
    return (x) => {
      if (typeof x !== "string") throw "is required";
      const s = x.trim().toLowerCase();
      if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw "must be a valid email address";
      return s;
    };
  },
  /** Like email() but may be left empty. */
  optionalEmail() {
    const strict = v.email();
    return (x) => (x == null || x === "" ? "" : strict(x));
  },
  /** Optional phone number: digits, spaces, +, -, brackets; 7 to 20 characters. */
  phone() {
    return (x) => {
      if (x == null || x === "") return "";
      if (typeof x !== "string") throw "must be text";
      const s = x.trim();
      if (!/^[0-9+()\-\s]{7,20}$/.test(s)) throw "must be a valid phone number";
      return s;
    };
  },
  password() {
    return (x) => {
      if (typeof x !== "string" || x.length < 8) throw "must be at least 8 characters";
      if (x.length > 128) throw "must be at most 128 characters";
      return x;
    };
  },
  oneOf(list) {
    return (x) => {
      if (!list.includes(x)) throw `must be one of: ${list.join(", ")}`;
      return x;
    };
  },
  int({ min = 0, max = 10_000_000 } = {}) {
    return (x) => {
      const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
      if (!Number.isInteger(n)) throw "must be a whole number";
      if (n < min || n > max) throw `must be between ${min} and ${max}`;
      return n;
    };
  },
  /** Array of unique values, each from `allowed`. */
  pick(allowed, { min = 0, max = 100 } = {}) {
    return (x) => {
      if (x == null) x = [];
      if (!Array.isArray(x)) throw "must be a list";
      const set = [...new Set(x)];
      const badItem = set.find((i) => !allowed.includes(i));
      if (badItem !== undefined) throw `contains an unknown value: ${String(badItem).slice(0, 40)}`;
      if (set.length < min) throw `needs at least ${min} item${min === 1 ? "" : "s"}`;
      if (set.length > max) throw `can have at most ${max} items`;
      return set;
    };
  },
  /** Empty, an https URL, or a small base64 image data URL (what the frontend's photo picker produces). */
  image() {
    return (x) => {
      if (x == null || x === "") return "";
      if (typeof x !== "string") throw "must be text";
      if (/^https:\/\/[^\s'"()\\]{1,500}$/.test(x)) return x;
      if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x)) {
        if (x.length > 1_500_000) throw "image is too large (max about 1 MB)";
        return x;
      }
      throw "must be an https URL or a JPEG/PNG/WebP image";
    };
  },
};

/**
 * Validate `input` against `shape` ({field: validator}). With partial=true,
 * missing fields are skipped (for PATCH). Throws a 422 listing every problem.
 */
export function parse(shape, input, { partial = false } = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  const out = {};
  const errors = {};
  for (const [key, fn] of Object.entries(shape)) {
    if (partial && input[key] === undefined) continue;
    try {
      out[key] = fn(input[key]);
    } catch (msg) {
      if (typeof msg !== "string") throw msg;
      errors[key] = `${key} ${msg}`;
    }
  }
  if (Object.keys(errors).length) throw new HttpError(422, "Some fields need attention.", errors);
  return out;
}
