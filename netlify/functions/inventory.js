// Netlify Function — Wilson inventory.
//
// GET  = pull-feed proxy (Chief ruling 2026-10-07, design 14NqveYH0QuEmYu2FiPdnOvZgmIiPNJ_RJZjmG19z8xA).
//        Reads Torque Hub's public ADMIN dealer feed for WTS. Same-origin, so index.html and
//        vehicle.html keep calling /.netlify/functions/inventory with the same 26-key array.
//          1. Fresh feed OK  -> 200 fresh units; then store { fetched_at, units } as last-known-good.
//          2. Fresh feed bad -> serve last-known-good only if it is at most 24 h old, measured from
//             fetched_at (the last successful fresh retrieval). Reading it never refreshes fetched_at.
//          3. Neither        -> 503 { error: "inventory_unavailable" }, never [] (an outage must not
//             look like zero inventory).
// POST = legacy store written by the ADMIN server push. Unchanged; GET no longer reads that blob.
//        Retired with INVENTORY_TOKEN only after all three dealer cutovers pass (Chief ruling).
const https = require("https");

const FEED_URL = "https://admin-torquehub.netlify.app/.netlify/functions/dealer-feed?dealer=WTS";
const LEGACY_BLOB_KEY = "wilsontrailersales-inventory";      // POST (server push) only
const LKG_BLOB_KEY = "wilsontrailersales-inventory-lkg";     // { fetched_at, units } — GET only
const LKG_MAX_AGE_MS = 24 * 60 * 60 * 1000;                  // Chief 2026-10-08: 24 h maximum
const FUTURE_SKEW_MS = 5 * 60 * 1000;                        // a fetched_at further ahead than this is corrupt
const FEED_TIMEOUT_MS = 6000;
const BLOB_TIMEOUT_MS = 3000;

// Legacy header set: exactly the production (194b014) headers. POST / OPTIONS / 405 return this and nothing else.
const LEGACY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300, s-maxage=600",
};
// GET only: the legacy CORS/content headers plus the expose list for the X-Inventory-* observability headers.
// Each GET response sets its own Cache-Control below.
const GET_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-Inventory-Source, X-Inventory-Fetched-At, X-Inventory-Age-Seconds",
  "Content-Type": "application/json",
};
const FRESH_CACHE = "public, max-age=300, s-maxage=600";     // unchanged from the blob-era GET
const LKG_CACHE = "public, max-age=60, s-maxage=60";         // short, so recovery shows quickly
const ERROR_CACHE = "no-store";                              // never cache an outage

function request(url, { method = "GET", headers = {}, body = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function blobUrl(key) {
  return `https://api.netlify.com/api/v1/blobs/${process.env.NETLIFY_SITE_ID}/torquehub/${key}`;
}
function blobToken() {
  return process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
}
function blobsConfigured() {
  return Boolean(process.env.NETLIFY_SITE_ID && blobToken());
}

const defaultDeps = {
  now: () => Date.now(),
  fetchFeed: () => request(FEED_URL, { headers: { Accept: "application/json" }, timeoutMs: FEED_TIMEOUT_MS }),
  readBlob: async (key) => {
    if (!blobsConfigured()) return null;
    const r = await request(blobUrl(key), { headers: { Authorization: `Bearer ${blobToken()}` }, timeoutMs: BLOB_TIMEOUT_MS });
    return r.status === 200 ? r.body : null;
  },
  // timeoutMs 0 = no timeout (the legacy POST never had one).
  writeBlob: async (key, body, timeoutMs = BLOB_TIMEOUT_MS) => {
    if (!blobsConfigured()) throw new Error("blobs not configured");
    const r = await request(blobUrl(key), {
      method: "PUT",
      headers: { Authorization: `Bearer ${blobToken()}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      body,
      timeoutMs,
    });
    if (r.status >= 400) throw new Error(`Blobs API error ${r.status}: ${r.body.slice(0, 200)}`);
  },
};

// A usable inventory payload is an array of objects. [] is valid (legitimate zero inventory).
function parseUnits(text) {
  let data;
  try { data = JSON.parse(text); } catch (_e) { return null; }
  if (!Array.isArray(data)) return null;
  if (!data.every((u) => u && typeof u === "object" && !Array.isArray(u))) return null;
  return data;
}

function parseLkg(text, now) {
  if (!text) return null;
  let rec;
  try { rec = JSON.parse(text); } catch (_e) { return null; }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const t = Date.parse(rec.fetched_at);
  if (!Number.isFinite(t) || t > now + FUTURE_SKEW_MS) return null;
  const units = Array.isArray(rec.units) && rec.units.every((u) => u && typeof u === "object" && !Array.isArray(u)) ? rec.units : null;
  if (!units) return null;
  return { fetchedAt: rec.fetched_at, ageMs: Math.max(0, now - t), units };
}

function createHandler(deps) {
  const { now, fetchFeed, readBlob, writeBlob } = deps;

  async function get() {
    // 1. Fresh feed.
    let fresh = null;
    try {
      const r = await fetchFeed();
      if (r && r.status === 200) fresh = parseUnits(r.body);
    } catch (_e) { fresh = null; }

    if (fresh) {
      const fetchedAt = new Date(now()).toISOString();
      try {
        await writeBlob(LKG_BLOB_KEY, JSON.stringify({ fetched_at: fetchedAt, units: fresh }));
      } catch (_e) { /* best effort: a failed LKG refresh never blocks fresh inventory */ }
      return {
        statusCode: 200,
        headers: { ...GET_HEADERS, "Cache-Control": FRESH_CACHE, "X-Inventory-Source": "fresh", "X-Inventory-Fetched-At": fetchedAt },
        body: JSON.stringify(fresh),
      };
    }

    // 2. Last-known-good, bounded at 24 h. Read-only: nothing here may rewrite fetched_at.
    let lkg = null;
    try { lkg = parseLkg(await readBlob(LKG_BLOB_KEY), now()); } catch (_e) { lkg = null; }
    if (lkg && lkg.ageMs <= LKG_MAX_AGE_MS) {
      return {
        statusCode: 200,
        headers: {
          ...GET_HEADERS,
          "Cache-Control": LKG_CACHE,
          "X-Inventory-Source": "last-known-good",
          "X-Inventory-Fetched-At": lkg.fetchedAt,
          "X-Inventory-Age-Seconds": String(Math.floor(lkg.ageMs / 1000)),
        },
        body: JSON.stringify(lkg.units),
      };
    }

    // 3. Fail closed.
    return {
      statusCode: 503,
      headers: { ...GET_HEADERS, "Cache-Control": ERROR_CACHE, "X-Inventory-Source": "unavailable" },
      body: JSON.stringify({ error: "inventory_unavailable", reason: lkg ? "last_known_good_expired" : "no_usable_last_known_good" }),
    };
  }

  // Legacy POST store — unchanged behavior (writes LEGACY_BLOB_KEY, which GET no longer reads).
  async function post(event) {
    const siteId = process.env.NETLIFY_SITE_ID;
    const token0 = blobToken();
    if (!siteId || !token0) {
      return { statusCode: 500, headers: LEGACY_HEADERS, body: JSON.stringify({ error: "Missing NETLIFY_SITE_ID or NETLIFY_BLOBS_TOKEN env vars" }) };
    }
    try {
      const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
      const token = auth.replace("Bearer ", "");
      if (!token || token !== process.env.INVENTORY_TOKEN) {
        return { statusCode: 401, headers: LEGACY_HEADERS, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      const payload = event.body;
      await writeBlob(LEGACY_BLOB_KEY, payload, 0);
      const data = JSON.parse(payload);
      return { statusCode: 200, headers: LEGACY_HEADERS, body: JSON.stringify({ success: true, count: Array.isArray(data) ? data.length : "unknown" }) };
    } catch (err) {
      return { statusCode: 500, headers: LEGACY_HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return async (event) => {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: LEGACY_HEADERS, body: "" };
    if (event.httpMethod === "GET") return get();
    if (event.httpMethod === "POST") return post(event);
    return { statusCode: 405, headers: LEGACY_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  };
}

exports.handler = createHandler(defaultDeps);
exports._test = { createHandler, LKG_BLOB_KEY, LEGACY_BLOB_KEY, LKG_MAX_AGE_MS, FEED_URL };
