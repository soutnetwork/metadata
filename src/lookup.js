// lookup.js — resolve a licensor UUID to a distributor name.

const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join(__dirname, '..', 'data', 'uuid-map.json');

let map = {};
function load() {
  try {
    map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  } catch (e) {
    console.error('فشل تحميل uuid-map.json:', e.message);
    map = {};
  }
}
load();

function reload() {
  load();
  return Object.keys(map).length;
}

function normalizeUuid(u) {
  return (u || '').toString().trim().toLowerCase().replace(/-/g, '');
}

// Returns:
//   { found:true,  uuid, distributor, subLabels:[...], count }
//   { found:false, uuid }
function lookup(uuidRaw) {
  const uuid = normalizeUuid(uuidRaw);
  if (!uuid) return { found: false, uuid: null };
  const hit = map[uuid];
  if (!hit) return { found: false, uuid };
  return {
    found: true,
    uuid,
    distributor: hit.distributor,
    subLabels: hit.sub_labels || [],
  };
}

function count() {
  return Object.keys(map).length;
}

module.exports = { lookup, reload, count, normalizeUuid };
