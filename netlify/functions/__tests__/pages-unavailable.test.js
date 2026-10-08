'use strict';
// pages-unavailable.test.js — buyer-facing outage state (Chief 2026-10-08): when the inventory
// endpoint is unavailable the pages must say so plainly and must NOT claim there are no units for
// sale or that a trailer no longer exists. Legitimate zero inventory keeps its existing message.
// Run: node --test netlify/functions/__tests__/pages-unavailable.test.js
// No browser: the REAL inline scripts from index.html / vehicle.html run in a vm with a tiny DOM fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const mainScript = (file) => {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const s = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((src) => src.includes("const ENDPOINT='/.netlify/functions/inventory'"));
  assert.ok(s, `${file}: main inventory script not found`);
  return s;
};

function el(extra = {}) {
  const listeners = {};
  return {
    innerHTML: '', textContent: '', value: '', href: '', src: '', style: {}, listeners,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelectorAll() { return []; },
    appendChild() {},
    ...extra,
  };
}
const settle = () => new Promise((r) => setImmediate(r));

function runIndex(fetchImpl) {
  const ids = {
    inventoryGrid: el(), searchInput: el(), typeFilter: el({ value: 'all' }), sortSelect: el({ value: 'newest' }),
    heroSlides: el(), heroCopy: el(), heroPrimaryCta: el(),
  };
  const sel = { '.hero-prev': el(), '.hero-next': el() };
  const document = { getElementById: (id) => ids[id] || el(), querySelector: (q) => sel[q] || el(), querySelectorAll: () => [], createElement: () => el() };
  const ctx = { document, window: {}, fetch: fetchImpl, setInterval: () => 1, clearInterval: () => {}, console };
  vm.runInNewContext(mainScript('index.html'), ctx);
  return ids;
}

const UNITS = [{ stock: 'WTS-005640', year: 2018, make: 'Peerless', price: '$19,900', subcategory: 'Chip Trailer', condition: 'Used', sold: false, photos: [] }];
const okRes = (data) => Promise.resolve({ ok: true, status: 200, json: async () => data });

test('U1: HTTP 503 from the inventory endpoint -> "temporarily unavailable", never a zero-inventory claim', async () => {
  const ids = runIndex(() => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'inventory_unavailable' }) }));
  await settle();
  assert.match(ids.inventoryGrid.innerHTML, /Inventory is temporarily unavailable\. Please check back shortly/);
  assert.match(ids.heroSlides.innerHTML, /Inventory temporarily unavailable/);
  assert.match(ids.heroCopy.textContent, /check back shortly/);
  for (const t of [ids.inventoryGrid.innerHTML, ids.heroSlides.innerHTML, ids.heroCopy.textContent]) {
    assert.ok(!/No inventory/i.test(t), 'outage must not read as no inventory: ' + t);
  }
});

test('U2: searching, filtering or sorting during an outage keeps the unavailable message', async () => {
  const ids = runIndex(() => Promise.reject(new Error('network down')));
  await settle();
  ids.searchInput.value = 'peerless';
  for (const fn of ids.searchInput.listeners.input) fn();
  for (const fn of ids.typeFilter.listeners.change) fn();
  for (const fn of ids.sortSelect.listeners.change) fn();
  assert.match(ids.inventoryGrid.innerHTML, /temporarily unavailable/);
  assert.ok(!/No inventory/i.test(ids.inventoryGrid.innerHTML));
});

test('U3: a 200 that is not JSON is treated as unavailable, not as zero inventory', async () => {
  const ids = runIndex(() => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }));
  await settle();
  assert.match(ids.inventoryGrid.innerHTML, /temporarily unavailable/);
});

test('U4: legitimate zero inventory (200 []) keeps the existing no-inventory message', async () => {
  const ids = runIndex(() => okRes([]));
  await settle();
  assert.match(ids.inventoryGrid.innerHTML, /No inventory is currently available/);
  assert.match(ids.heroSlides.innerHTML, /No inventory currently available/);
  assert.ok(!/temporarily unavailable/.test(ids.inventoryGrid.innerHTML));
});

test('U5: normal inventory still renders cards', async () => {
  const ids = runIndex(() => okRes(UNITS));
  await settle();
  assert.match(ids.inventoryGrid.innerHTML, /2018 Peerless/);
  assert.match(ids.inventoryGrid.innerHTML, /\$19,900/);
  assert.ok(!/unavailable/i.test(ids.inventoryGrid.innerHTML));
});

function runVdp(search, fetchImpl) {
  const h2 = el({ textContent: 'Trailer Not Found' });
  const p = el({ textContent: 'This listing may no longer be available.' });
  const errBox = el({ style: { display: 'none' }, querySelector: (q) => (q === 'h2' ? h2 : q === 'p' ? p : el()) });
  const loading = el({ style: { display: 'block' } });
  const ids = { 'vdp-loading': loading, 'vdp-error': errBox };
  const document = { getElementById: (id) => ids[id] || el(), querySelector: () => el(), querySelectorAll: () => [], title: '' };
  const ctx = { document, window: { location: { search } }, URLSearchParams, fetch: fetchImpl, console, alert: () => {} };
  vm.runInNewContext(mainScript('vehicle.html'), ctx);
  return { h2, p, errBox, loading };
}

test('V1: VDP outage (network error or 503) -> "Inventory Temporarily Unavailable", not "Trailer Not Found"', async () => {
  for (const f of [() => Promise.reject(new Error('down')), () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })]) {
    const v = runVdp('?stock=WTS-005640', f);
    await settle();
    assert.equal(v.errBox.style.display, 'block');
    assert.equal(v.loading.style.display, 'none');
    assert.equal(v.h2.textContent, 'Inventory Temporarily Unavailable');
    assert.match(v.p.textContent, /check back shortly or call Wilson Trailer Sales & Service at 252-429-8805/);
  }
});

test('V2: a stock that is genuinely not in the feed still shows "Trailer Not Found"', async () => {
  const v = runVdp('?stock=WTS-NOPE', () => okRes(UNITS));
  await settle();
  assert.equal(v.errBox.style.display, 'block');
  assert.equal(v.h2.textContent, 'Trailer Not Found');
});
