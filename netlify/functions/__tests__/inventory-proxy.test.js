'use strict';
// inventory-proxy.test.js — Wilson pull-feed proxy (Chief rulings 2026-10-07 / 2026-10-08:
// ADMIN dealer feed, last-known-good max 24 h measured from the last successful fresh retrieval,
// fail closed with non-2xx instead of []).
// Run: node --test netlify/functions/__tests__/inventory-proxy.test.js
// No network: the REAL handler logic runs through createHandler() with in-memory feed/blob fakes.
const test = require('node:test');
const assert = require('node:assert/strict');

const { _test, handler } = require('../inventory');
const { createHandler, LKG_BLOB_KEY, LEGACY_BLOB_KEY, LKG_MAX_AGE_MS, FEED_URL } = _test;

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const UNITS = [
  { stock: 'WTS-005640', year: 2018, make: 'Peerless', price: '$19,900', sold: false },
  { stock: 'WTS-487', year: 2027, make: 'Wilson', price: '$65,100', sold: true },
];
const OLDER = [{ stock: 'WTS-OLD', year: 2001, make: 'Old', price: '$1', sold: false }];
// Exactly the header set production (194b014) returns on every path. Legacy POST / OPTIONS / 405 must match it.
const PRODUCTION_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300, s-maxage=600',
};
const EXPOSE = 'X-Inventory-Source, X-Inventory-Fetched-At, X-Inventory-Age-Seconds';

function rig({ feed, blobs = {}, now = T0, writeFails = false } = {}) {
  const state = { now, blobs: { ...blobs }, writes: [], reads: [], feedCalls: 0 };
  const h = createHandler({
    now: () => state.now,
    fetchFeed: async () => { state.feedCalls++; return typeof feed === 'function' ? feed() : feed; },
    readBlob: async (key) => { state.reads.push(key); return key in state.blobs ? state.blobs[key] : null; },
    writeBlob: async (key, body) => {
      state.writes.push({ key, body });
      if (writeFails) throw new Error('blob write failed');
      state.blobs[key] = body;
    },
  });
  state.get = () => h({ httpMethod: 'GET', headers: {} });
  return state;
}
const ok = (units) => ({ status: 200, body: JSON.stringify(units) });
const lkg = (units, fetchedAtMs) => JSON.stringify({ fetched_at: new Date(fetchedAtMs).toISOString(), units });
const down = () => { throw new Error('ECONNREFUSED'); };

test('P0: the production handler points at the ADMIN dealer feed for WTS and keeps separate blob keys', () => {
  assert.equal(FEED_URL, 'https://admin-torquehub.netlify.app/.netlify/functions/dealer-feed?dealer=WTS');
  assert.equal(LEGACY_BLOB_KEY, 'wilsontrailersales-inventory');
  assert.equal(LKG_BLOB_KEY, 'wilsontrailersales-inventory-lkg');
  assert.notEqual(LKG_BLOB_KEY, LEGACY_BLOB_KEY);
  assert.equal(LKG_MAX_AGE_MS, 24 * HOUR);
  assert.equal(typeof handler, 'function');
});

test('P1: fresh success -> 200 fresh units unchanged, fresh headers, LKG stored with fetched_at = now', async () => {
  const s = rig({ feed: ok(UNITS) });
  const r = await s.get();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), UNITS);
  assert.equal(r.headers['X-Inventory-Source'], 'fresh');
  assert.equal(r.headers['X-Inventory-Fetched-At'], new Date(T0).toISOString());
  assert.equal(r.headers['Cache-Control'], 'public, max-age=300, s-maxage=600');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(r.headers['Access-Control-Expose-Headers'], EXPOSE);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].key, LKG_BLOB_KEY);
  assert.deepEqual(JSON.parse(s.writes[0].body), { fetched_at: new Date(T0).toISOString(), units: UNITS });
  assert.deepEqual(s.reads, [], 'a fresh success never needs to read the fallback');
});

test('P2: fresh [] is legitimate zero inventory -> 200 [] (not treated as an outage)', async () => {
  const s = rig({ feed: ok([]), blobs: { [LKG_BLOB_KEY]: lkg(UNITS, T0 - HOUR) } });
  const r = await s.get();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), []);
  assert.equal(r.headers['X-Inventory-Source'], 'fresh');
});

test('P3: every kind of fresh failure falls back to an LKG inside 24 h', async () => {
  const failures = [
    ['network error', down],
    ['HTTP 502', { status: 502, body: '{"error":"feed_unavailable"}' }],
    ['HTTP 404', { status: 404, body: '{"error":"unknown_dealer"}' }],
    ['HTTP 200 non-JSON', { status: 200, body: '<html>oops</html>' }],
    ['HTTP 200 object', { status: 200, body: '{"error":"x"}' }],
    ['HTTP 200 array of non-objects', { status: 200, body: '[1,2,3]' }],
    ['null response', null],
  ];
  for (const [label, feed] of failures) {
    const s = rig({ feed, blobs: { [LKG_BLOB_KEY]: lkg(OLDER, T0 - HOUR) } });
    const r = await s.get();
    assert.equal(r.statusCode, 200, label);
    assert.deepEqual(JSON.parse(r.body), OLDER, label);
    assert.equal(r.headers['X-Inventory-Source'], 'last-known-good', label);
    assert.equal(r.headers['X-Inventory-Fetched-At'], new Date(T0 - HOUR).toISOString(), label);
    assert.equal(r.headers['X-Inventory-Age-Seconds'], '3600', label);
    assert.equal(r.headers['Cache-Control'], 'public, max-age=60, s-maxage=60', label);
    assert.equal(r.headers['Access-Control-Expose-Headers'], EXPOSE, label);
  }
});

test('P4: 24 h boundary — exactly 24 h is served; 24 h + 1 ms fails closed', async () => {
  const at = rig({ feed: down, blobs: { [LKG_BLOB_KEY]: lkg(OLDER, T0 - 24 * HOUR) } });
  assert.equal((await at.get()).statusCode, 200);
  const over = rig({ feed: down, blobs: { [LKG_BLOB_KEY]: lkg(OLDER, T0 - 24 * HOUR - 1) } });
  const r = await over.get();
  assert.equal(r.statusCode, 503);
  assert.deepEqual(JSON.parse(r.body), { error: 'inventory_unavailable', reason: 'last_known_good_expired' });
});

test('P5: expired, missing or corrupt LKG -> 503 no-store, never [] ', async () => {
  const cases = [
    ['expired 3 days', lkg(OLDER, T0 - 72 * HOUR), 'last_known_good_expired'],
    ['missing', undefined, 'no_usable_last_known_good'],
    ['not JSON', 'garbage{', 'no_usable_last_known_good'],
    ['raw array (legacy push format, no timestamp)', JSON.stringify(OLDER), 'no_usable_last_known_good'],
    ['bad fetched_at', JSON.stringify({ fetched_at: 'yesterday-ish', units: OLDER }), 'no_usable_last_known_good'],
    ['missing fetched_at', JSON.stringify({ units: OLDER }), 'no_usable_last_known_good'],
    ['units not array', JSON.stringify({ fetched_at: new Date(T0).toISOString(), units: {} }), 'no_usable_last_known_good'],
    ['far-future fetched_at', lkg(OLDER, T0 + 6 * 60 * 1000), 'no_usable_last_known_good'],
  ];
  for (const [label, blob, reason] of cases) {
    const blobs = blob === undefined ? {} : { [LKG_BLOB_KEY]: blob };
    const s = rig({ feed: down, blobs });
    const r = await s.get();
    assert.equal(r.statusCode, 503, label);
    assert.equal(r.headers['Cache-Control'], 'no-store', label);
    assert.equal(r.headers['X-Inventory-Source'], 'unavailable', label);
    assert.equal(r.headers['Access-Control-Expose-Headers'], EXPOSE, label);
    assert.deepEqual(JSON.parse(r.body), { error: 'inventory_unavailable', reason }, label);
    assert.ok(!Array.isArray(JSON.parse(r.body)), label + ': an outage must never be an empty array');
  }
});

test('P6: stale reads never extend freshness — no write on any fallback path, age keeps growing', async () => {
  const s = rig({ feed: down, blobs: { [LKG_BLOB_KEY]: lkg(OLDER, T0 - 23 * HOUR) } });
  const r1 = await s.get();
  assert.equal(r1.statusCode, 200);
  s.now = T0 + 30 * 60 * 1000;
  const r2 = await s.get();
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.headers['X-Inventory-Fetched-At'], r1.headers['X-Inventory-Fetched-At']);
  assert.equal(Number(r2.headers['X-Inventory-Age-Seconds']), Number(r1.headers['X-Inventory-Age-Seconds']) + 1800);
  s.now = T0 + HOUR + 1;          // now 24 h + 1 ms past the only successful retrieval
  const r3 = await s.get();
  assert.equal(r3.statusCode, 503);
  assert.equal(s.writes.length, 0, 'serving or rejecting the fallback must never write it');
});

test('P7: a later fresh success replaces the LKG and resets its age', async () => {
  let up = false;
  const s = rig({ feed: () => (up ? ok(UNITS) : down()), blobs: { [LKG_BLOB_KEY]: lkg(OLDER, T0 - 20 * HOUR) } });
  assert.equal((await s.get()).headers['X-Inventory-Source'], 'last-known-good');
  up = true; s.now = T0 + 2 * HOUR;
  const fresh = await s.get();
  assert.equal(fresh.headers['X-Inventory-Source'], 'fresh');
  up = false; s.now = T0 + 3 * HOUR;
  const after = await s.get();
  assert.equal(after.statusCode, 200);
  assert.deepEqual(JSON.parse(after.body), UNITS);
  assert.equal(after.headers['X-Inventory-Age-Seconds'], '3600');
});

test('P8: the legacy push blob is never read by GET, even when it is the only copy', async () => {
  const s = rig({ feed: down, blobs: { [LEGACY_BLOB_KEY]: JSON.stringify(UNITS) } });
  const r = await s.get();
  assert.equal(r.statusCode, 503);
  assert.deepEqual(s.reads, [LKG_BLOB_KEY]);
});

test('P9: a failed LKG write never blocks fresh inventory', async () => {
  const s = rig({ feed: ok(UNITS), writeFails: true });
  const r = await s.get();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), UNITS);
});

test('P10: a throwing fallback read fails closed (503), not []', async () => {
  const h = createHandler({ now: () => T0, fetchFeed: down, readBlob: async () => { throw new Error('blobs down'); }, writeBlob: async () => {} });
  const r = await h({ httpMethod: 'GET', headers: {} });
  assert.equal(r.statusCode, 503);
});

test('P11: legacy POST / OPTIONS / 405 unchanged — exact production headers (no expose list), legacy key only', async () => {
  const saved = { ...process.env };
  process.env.NETLIFY_SITE_ID = 'site'; process.env.NETLIFY_BLOBS_TOKEN = 'blob'; process.env.INVENTORY_TOKEN = 'inv';
  try {
    const writes = [];
    let writeFails = false;
    const h = createHandler({ now: () => T0, fetchFeed: async () => ok(UNITS), readBlob: async () => null,
      writeBlob: async (key, body, timeoutMs) => { writes.push({ key, body, timeoutMs }); if (writeFails) throw new Error('Blobs API error 500: x'); } });
    const legacy = [];
    const bad = await h({ httpMethod: 'POST', headers: { authorization: 'Bearer nope' }, body: '[]' });
    assert.equal(bad.statusCode, 401); legacy.push(['POST 401', bad]);
    const good = await h({ httpMethod: 'POST', headers: { Authorization: 'Bearer inv' }, body: JSON.stringify(UNITS) });
    assert.equal(good.statusCode, 200);
    assert.deepEqual(JSON.parse(good.body), { success: true, count: 2 }); legacy.push(['POST 200', good]);
    writeFails = true;
    const failed = await h({ httpMethod: 'POST', headers: { authorization: 'Bearer inv' }, body: '[]' });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(JSON.parse(failed.body), { error: 'Blobs API error 500: x' }); legacy.push(['POST 500 write', failed]);
    writeFails = false;
    const opt = await h({ httpMethod: 'OPTIONS', headers: {} });
    assert.equal(opt.statusCode, 204); assert.equal(opt.body, ''); legacy.push(['OPTIONS 204', opt]);
    const del = await h({ httpMethod: 'DELETE', headers: {} });
    assert.equal(del.statusCode, 405); legacy.push(['DELETE 405', del]);
    delete process.env.NETLIFY_SITE_ID;
    const missing = await h({ httpMethod: 'POST', headers: { authorization: 'Bearer inv' }, body: '[]' });
    assert.equal(missing.statusCode, 500); legacy.push(['POST 500 env', missing]);
    for (const [label, r] of legacy) {
      assert.deepEqual(r.headers, PRODUCTION_HEADERS, label + ': legacy headers must equal production exactly');
      assert.ok(!('Access-Control-Expose-Headers' in r.headers), label + ': no expose list on legacy paths');
    }
    assert.deepEqual(writes.map(w => [w.key, w.timeoutMs]), [[LEGACY_BLOB_KEY, 0], [LEGACY_BLOB_KEY, 0]], 'POST writes only the legacy key, with no timeout');
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
