// usage.js — counts how many times each user used each tool per day.
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', 'data', 'usage.json');

function today() { return new Date().toISOString().slice(0, 10); } // UTC date
function load() { try { return JSON.parse(fs.readFileSync(P, 'utf8')); } catch (_) { return {}; } }
function save(d) { const t = P + '.tmp'; fs.writeFileSync(t, JSON.stringify(d), 'utf8'); fs.renameSync(t, P); }
function key(email, tool) { return (email || '').toLowerCase() + '|' + tool + '|' + today(); }

function count(email, tool) { return load()[key(email, tool)] || 0; }

function incr(email, tool) {
  const d = load();
  const k = key(email, tool);
  d[k] = (d[k] || 0) + 1;
  // prune anything not from today to keep the file tiny
  const suffix = '|' + today();
  for (const kk of Object.keys(d)) if (!kk.endsWith(suffix)) delete d[kk];
  save(d);
}

module.exports = { count, incr, today };
