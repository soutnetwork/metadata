// auth.js — users, passwords, sessions (JWT cookie), invites, guards,
// per-user permissions, account lockout, and last-login tracking.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const SECRET_PATH = path.join(DATA_DIR, '.secret');

const COOKIE = 'sn_session';
const TOKEN_DAYS = 30;
const INVITE_DAYS = 7;
const MAX_FAILED = 6;               // lock after this many failures
const LOCK_MINUTES = 15;            // lock duration

const DEFAULT_PERMS = { seeCodes: true, downloadCover: true };

function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(SECRET_PATH, 'utf8').trim(); }
  catch (_) {
    const s = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_PATH, s, { mode: 0o600 }); } catch (_) {}
    return s;
  }
}
const SECRET = getSecret();

function loadDB() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch (_) { return { users: [], invites: [] }; }
}
function saveDB(db) {
  const tmp = USERS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_PATH);
}
function normEmail(e) { return (e || '').trim().toLowerCase(); }

function effectivePerms(u) {
  if (!u) return { seeCodes: false, downloadCover: false, tools: {} };
  if (u.role === 'admin') return { seeCodes: true, downloadCover: true, tools: {} };
  const p = u.perms || {};
  return {
    seeCodes: p.seeCodes !== false,
    downloadCover: p.downloadCover !== false,
    tools: p.tools || {},
  };
}

function hasAnyAdmin() { return loadDB().users.some((u) => u.role === 'admin'); }
function findUserByEmail(email) {
  const e = normEmail(email);
  return loadDB().users.find((u) => u.email === e) || null;
}
function listUsers() {
  const db = loadDB();
  return {
    users: db.users.map((u) => ({
      email: u.email, role: u.role, createdAt: u.createdAt,
      perms: effectivePerms(u),
      lastLogin: u.lastLogin || null,
      locked: !!(u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()),
    })),
    invites: db.invites.map((i) => ({ email: i.email, role: i.role, expiresAt: i.expiresAt })),
  };
}

function createUser({ email, password, role, perms }) {
  const db = loadDB();
  const e = normEmail(email);
  if (!e || !password) throw new Error('Email and password are required.');
  if (db.users.some((u) => u.email === e)) throw new Error('This email already has an account.');
  db.users.push({
    id: crypto.randomUUID(),
    email: e,
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'user',
    perms: Object.assign({}, DEFAULT_PERMS, perms || {}),
    createdAt: new Date().toISOString(),
    lastLogin: null,
    lockedUntil: null,
    failedAttempts: 0,
  });
  saveDB(db);
}

function removeUser(email) {
  const db = loadDB();
  const e = normEmail(email);
  const before = db.users.length;
  db.users = db.users.filter((u) => u.email !== e);
  if (db.users.length === before) throw new Error('User not found.');
  if (!db.users.some((u) => u.role === 'admin')) throw new Error('Cannot remove the last admin.');
  saveDB(db);
}

function setPermissions(email, perms) {
  const db = loadDB();
  const u = db.users.find((x) => x.email === normEmail(email));
  if (!u) throw new Error('User not found.');
  u.perms = u.perms || {};
  if (perms.seeCodes !== undefined) u.perms.seeCodes = !!perms.seeCodes;
  if (perms.downloadCover !== undefined) u.perms.downloadCover = !!perms.downloadCover;
  if (perms.tools !== undefined) u.perms.tools = perms.tools;
  saveDB(db);
}

// returns { ok:true, user } | { ok:false, error, locked? }
function verifyLogin(email, password, ip) {
  const db = loadDB();
  const u = db.users.find((x) => x.email === normEmail(email));
  if (!u) return { ok: false, error: 'Incorrect email or password.' };

  if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
    return { ok: false, error: 'Account is temporarily locked. Try again later.', locked: true };
  }

  if (!bcrypt.compareSync(password, u.passwordHash)) {
    u.failedAttempts = (u.failedAttempts || 0) + 1;
    if (u.failedAttempts >= MAX_FAILED) {
      u.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      u.failedAttempts = 0;
    }
    saveDB(db);
    return { ok: false, error: 'Incorrect email or password.' };
  }

  u.failedAttempts = 0;
  u.lockedUntil = null;
  u.lastLogin = { at: new Date().toISOString(), ip: ip || null };
  saveDB(db);
  return { ok: true, user: u };
}

// ---- invites ----
function createInvite({ email, role, perms }) {
  const db = loadDB();
  const e = normEmail(email);
  if (!e) throw new Error('Email is required.');
  if (db.users.some((u) => u.email === e)) throw new Error('This email already has an account.');
  db.invites = db.invites.filter((i) => i.email !== e);
  const token = crypto.randomBytes(24).toString('hex');
  db.invites.push({
    token, email: e, role: role === 'admin' ? 'admin' : 'user',
    perms: Object.assign({}, DEFAULT_PERMS, perms || {}),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(),
  });
  saveDB(db);
  return token;
}
function getInvite(token) {
  const db = loadDB();
  const inv = db.invites.find((i) => i.token === token);
  if (!inv) return null;
  if (new Date(inv.expiresAt).getTime() < Date.now()) return null;
  return inv;
}
function acceptInvite(token, password) {
  const inv = getInvite(token);
  if (!inv) throw new Error('This invite link is invalid or has expired.');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  createUser({ email: inv.email, password, role: inv.role, perms: inv.perms });
  const db = loadDB();
  db.invites = db.invites.filter((i) => i.token !== token);
  saveDB(db);
  return inv.email;
}

// ---- session cookie ----
function issueCookie(res, user) {
  const token = jwt.sign({ email: user.email, role: user.role }, SECRET, { expiresIn: `${TOKEN_DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TOKEN_DAYS * 864e5,
  });
}
function clearCookie(res) { res.clearCookie(COOKIE); }

function readUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try {
    const p = jwt.verify(token, SECRET);
    const u = findUserByEmail(p.email);
    if (!u) return null;
    return { email: u.email, role: u.role, perms: effectivePerms(u) };
  } catch (_) { return null; }
}

function requireAuth(req, res, next) {
  const u = readUser(req);
  if (!u) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Please sign in.' });
    return res.redirect('/login');
  }
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  const u = readUser(req);
  if (!u) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Please sign in.' });
    return res.redirect('/login');
  }
  if (u.role !== 'admin') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: 'Admins only.' });
    return res.redirect('/');
  }
  req.user = u; next();
}

module.exports = {
  hasAnyAdmin, findUserByEmail, listUsers, createUser, removeUser, setPermissions,
  verifyLogin, createInvite, getInvite, acceptInvite, effectivePerms,
  issueCookie, clearCookie, readUser, requireAuth, requireAdmin,
};
