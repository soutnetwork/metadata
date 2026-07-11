// requests.js — a simple ticket system for manual services.
// A user submits a request (with a link) -> it's "pending" -> the admin fills
// in the answer -> it becomes "approved" and the user sees it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const P = path.join(__dirname, '..', 'data', 'requests.json');
const MAX = 20000;

// Service definitions. Each has the user input label and the fields the admin fills.
const SERVICES = {
  copyright: {
    title: 'Copyright / Strike',
    inputLabel: 'Video link that received the strike',
    fields: [{ key: 'channel', label: 'Channel that issued the strike' }],
    eta: '1–20 minutes',
  },
  youtube_owner: {
    title: 'YouTube Channel Owner',
    inputLabel: 'YouTube channel link',
    fields: [
      { key: 'owner', label: 'Owner (CMS & MCN) email' },
    ],
    eta: '1–20 minutes',
  },
  yt_distributor: {
    title: 'YouTube → Distributor',
    inputLabel: 'YouTube video link',
    fields: [{ key: 'distributor', label: 'Distributor' }],
    eta: '1–20 minutes',
  },
};

function isService(t) { return Object.prototype.hasOwnProperty.call(SERVICES, t); }

function load() { try { return JSON.parse(fs.readFileSync(P, 'utf8')); } catch (_) { return []; } }
function save(a) { const t = P + '.tmp'; fs.writeFileSync(t, JSON.stringify(a), 'utf8'); fs.renameSync(t, P); }

function create({ type, input, email }) {
  if (!isService(type)) throw new Error('Unknown service.');
  if (!input || !input.trim()) throw new Error('A link is required.');
  const arr = load();
  const ticket = {
    id: crypto.randomBytes(8).toString('hex'),
    type, input: input.trim(), email,
    status: 'pending', fields: {},
    createdAt: new Date().toISOString(),
    resolvedAt: null, resolvedBy: null,
  };
  arr.unshift(ticket);
  if (arr.length > MAX) arr.length = MAX;
  save(arr);
  return ticket;
}

function listByUser(email, type) {
  const e = (email || '').toLowerCase();
  return load().filter((t) => (t.email || '').toLowerCase() === e && (!type || t.type === type));
}

function listAll({ status, type } = {}) {
  return load().filter((t) => (!status || t.status === status) && (!type || t.type === type));
}

function get(id) { return load().find((t) => t.id === id) || null; }

function resolve(id, fields, adminEmail) {
  const arr = load();
  const t = arr.find((x) => x.id === id);
  if (!t) throw new Error('Request not found.');
  t.fields = Object.assign({}, t.fields, fields || {});
  t.status = 'approved';
  t.resolvedAt = new Date().toISOString();
  t.resolvedBy = adminEmail || null;
  save(arr);
  return t;
}

function reject(id, adminEmail) {
  const arr = load();
  const t = arr.find((x) => x.id === id);
  if (!t) throw new Error('Request not found.');
  t.status = 'rejected';
  t.resolvedAt = new Date().toISOString();
  t.resolvedBy = adminEmail || null;
  save(arr);
  return t;
}

function pendingCount() { return load().filter((t) => t.status === 'pending').length; }

module.exports = { SERVICES, isService, create, listByUser, listAll, get, resolve, reject, pendingCount };
