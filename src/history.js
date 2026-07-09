// history.js — records every lookup so the admin can see who searched what.
const fs = require('fs');
const path = require('path');

const HIST_PATH = path.join(__dirname, '..', 'data', 'history.json');
const MAX = 8000; // keep the newest N entries

function load() {
  try { return JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); }
  catch (_) { return []; }
}
function save(arr) {
  const tmp = HIST_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr), 'utf8');
  fs.renameSync(tmp, HIST_PATH);
}

function log(entry) {
  try {
    const arr = load();
    arr.unshift({
      at: new Date().toISOString(),
      email: entry.email || null,
      url: entry.url || null,
      gid: entry.gid || null,
      track: entry.track || null,          // { name, artist }
      distributor: entry.distributor || null,
      found: !!entry.found,
    });
    if (arr.length > MAX) arr.length = MAX;
    save(arr);
  } catch (_) { /* logging must never break a lookup */ }
}

// options: { email, limit, offset }
function list(opts = {}) {
  let arr = load();
  if (opts.email) {
    const e = opts.email.toLowerCase();
    arr = arr.filter((x) => (x.email || '').toLowerCase() === e);
  }
  const total = arr.length;
  const offset = opts.offset || 0;
  const limit = opts.limit || 200;
  return { total, items: arr.slice(offset, offset + limit) };
}

function stats() {
  const arr = load();
  const perUser = {};
  for (const x of arr) { const e = x.email || 'unknown'; perUser[e] = (perUser[e] || 0) + 1; }
  return { total: arr.length, perUser };
}

module.exports = { log, list, stats };
