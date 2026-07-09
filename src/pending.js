// pending.js — collects unknown licensor codes so the admin can identify and
// add them later. When a lookup finds a code that's not in the reference set,
// it lands here as a "pending" request.
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '..', 'data', 'pending.json');
const MAX = 3000;

function load() { try { return JSON.parse(fs.readFileSync(P, 'utf8')); } catch (_) { return []; } }
function save(a) { const t = P + '.tmp'; fs.writeFileSync(t, JSON.stringify(a), 'utf8'); fs.renameSync(t, P); }

// add or update a pending unknown code (deduped by uuid)
function add({ uuid, track, url, email }) {
  if (!uuid) return;
  try {
    const arr = load();
    const now = new Date().toISOString();
    const existing = arr.find((x) => x.uuid === uuid);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = now;
      if (track && track.name && !existing.track) existing.track = track;
      if (url && !existing.sampleUrl) existing.sampleUrl = url;
    } else {
      arr.unshift({ uuid, track: track || null, sampleUrl: url || null, firstBy: email || null, firstSeen: now, lastSeen: now, count: 1 });
      if (arr.length > MAX) arr.length = MAX;
    }
    save(arr);
  } catch (_) {}
}

function list() { return load().sort((a, b) => (b.count || 0) - (a.count || 0)); }

// remove one or many uuids (called when the admin adds them to the map)
function remove(uuids) {
  const set = new Set((Array.isArray(uuids) ? uuids : [uuids]).map((u) => (u || '').toLowerCase()));
  try {
    const arr = load().filter((x) => !set.has((x.uuid || '').toLowerCase()));
    save(arr);
  } catch (_) {}
}

function count() { return load().length; }

module.exports = { add, list, remove, count };
