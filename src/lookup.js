// lookup.js — resolve a licensor UUID to a distributor, plus admin CRUD
// over the reference set (data/uuid-map.json).

const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join(__dirname, '..', 'data', 'uuid-map.json');

let map = {};
function load() {
  try { map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); }
  catch (e) { console.error('failed to load uuid-map.json:', e.message); map = {}; }
}
load();

function persist() {
  const tmp = MAP_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, MAP_PATH);
}
function reload() { load(); return Object.keys(map).length; }
function count() { return Object.keys(map).length; }

function normalizeUuid(u) { return (u || '').toString().trim().toLowerCase().replace(/-/g, ''); }

function lookup(uuidRaw) {
  const uuid = normalizeUuid(uuidRaw);
  if (!uuid) return { found: false, uuid: null };
  const hit = map[uuid];
  if (!hit) return { found: false, uuid };
  return { found: true, uuid, distributor: hit.distributor, subLabels: hit.sub_labels || [] };
}

// ---- admin CRUD ----
function listAll() {
  return Object.keys(map)
    .map((uuid) => ({ uuid, distributor: map[uuid].distributor, subLabels: map[uuid].sub_labels || [] }))
    .sort((a, b) => a.distributor.localeCompare(b.distributor));
}

function addEntry({ uuid, distributor, notes }) {
  const u = normalizeUuid(uuid);
  if (!u || u.length < 8) throw new Error('A valid code is required.');
  if (!distributor || !distributor.trim()) throw new Error('Distributor name is required.');
  const subs = (notes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const existed = !!map[u];
  map[u] = { distributor: distributor.trim(), sub_labels: subs };
  persist();
  return { uuid: u, updated: existed };
}

function updateEntry(uuidRaw, { distributor, notes }) {
  const u = normalizeUuid(uuidRaw);
  if (!map[u]) throw new Error('Code not found.');
  if (distributor && distributor.trim()) map[u].distributor = distributor.trim();
  if (notes !== undefined) map[u].sub_labels = (notes || '').split(',').map((s) => s.trim()).filter(Boolean);
  persist();
  return { uuid: u };
}

function deleteEntry(uuidRaw) {
  const u = normalizeUuid(uuidRaw);
  if (!map[u]) throw new Error('Code not found.');
  delete map[u];
  persist();
  return { uuid: u };
}

// bulk: accepts an array of {uuid,distributor,notes} OR raw CSV/lines text
function bulkAdd(input) {
  let rows = [];
  if (Array.isArray(input)) {
    rows = input;
  } else if (typeof input === 'string') {
    rows = input.split(/\r?\n/).map((line) => {
      const parts = line.split(',');
      if (parts.length < 2) return null;
      return { uuid: parts[0], distributor: parts[1], notes: parts.slice(2).join(',') };
    }).filter(Boolean);
  }
  let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const u = normalizeUuid(r.uuid);
    const name = (r.distributor || '').trim();
    if (!u || u.length < 8 || !name) { skipped++; continue; }
    const subs = (r.notes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (map[u]) updated++; else added++;
    map[u] = { distributor: name, sub_labels: subs };
  }
  persist();
  return { added, updated, skipped, total: count() };
}

module.exports = {
  lookup, reload, count, normalizeUuid,
  listAll, addEntry, updateEntry, deleteEntry, bulkAdd,
};
