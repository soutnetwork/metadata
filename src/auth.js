// auth.js — users, passwords, sessions (JWT cookie), invites, guards.
// File-based storage: no database to install or maintain.

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

// ---- secret (persists across restarts) ----
function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch (_) {
    const s = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_PATH, s, { mode: 0o600 }); } catch (_) {}
    return s;
  }
}
const SECRET = getSecret();

// ---- store ----
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch (_) {
    return { users: [], invites: [] };
  }
}
function saveDB(db) {
  const tmp = USERS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_PATH); // atomic
}

function normEmail(e) { return (e || '').trim().toLowerCase(); }

function hasAnyAdmin() {
  return loadDB().users.some((u) => u.role === 'admin');
}
function findUserByEmail(email) {
  const e = normEmail(email);
  return loadDB().users.find((u) => u.email === e) || null;
}
function listUsers() {
  const db = loadDB();
  return {
    users: db.users.map((u) => ({ email: u.email, role: u.role, createdAt: u.createdAt })),
    invites: db.invites.map((i) => ({ email: i.email, role: i.role, expiresAt: i.expiresAt })),
  };
}

function createUser({ email, password, role }) {
  const db = loadDB();
  const e = normEmail(email);
  if (!e || !password) throw new Error('Email and password are required.');
  if (db.users.some((u) => u.email === e)) throw new Error('This email already has an account.');
  db.users.push({
    id: crypto.randomUUID(),
    email: e,
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
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

function verifyLogin(email, password) {
  const u = findUserByEmail(email);
  if (!u) return null;
  if (!bcrypt.compareSync(password, u.passwordHash)) return null;
  return u;
}

// ---- invites ----
function createInvite({ email, role }) {
  const db = loadDB();
  const e = normEmail(email);
  if (!e) throw new Error('Email is required.');
  if (db.users.some((u) => u.email === e)) throw new Error('This email already has an account.');
  db.invites = db.invites.filter((i) => i.email !== e); // replace any prior invite
  const token = crypto.randomBytes(24).toString('hex');
  db.invites.push({
    token,
    email: e,
    role: role === 'admin' ? 'admin' : 'user',
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
  createUser({ email: inv.email, password, role: inv.role });
  const db = loadDB();
  db.invites = db.invites.filter((i) => i.token !== token);
  saveDB(db);
  return inv.email;
}

// ---- session cookie ----
function issueCookie(res, user) {
  const token = jwt.sign(
    { email: user.email, role: user.role },
    SECRET,
    { expiresIn: `${TOKEN_DAYS}d` }
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TOKEN_DAYS * 864e5,
  });
}
function clearCookie(res) {
  res.clearCookie(COOKIE);
}
function readUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try {
    const p = jwt.verify(token, SECRET);
    // make sure the account still exists
    const u = findUserByEmail(p.email);
    if (!u) return null;
    return { email: u.email, role: u.role };
  } catch (_) {
    return null;
  }
}

// ---- guards ----
function requireAuth(req, res, next) {
  const u = readUser(req);
  if (!u) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Please sign in.' });
    return res.redirect('/login');
  }
  req.user = u;
  next();
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
  req.user = u;
  next();
}

module.exports = {
  hasAnyAdmin, findUserByEmail, listUsers, createUser, removeUser,
  verifyLogin, createInvite, getInvite, acceptInvite,
  issueCookie, clearCookie, readUser, requireAuth, requireAdmin,
};
