// server.js — Sout Network Metadata (protected, English UI)
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { parseSpotifyInput } = require('./src/spotifyId');
const { getTrackMetadata, normalizeTrack } = require('./src/spotify');
const lookupModule = require('./src/lookup');
const auth = require('./src/auth');

const app = express();
app.set('trust proxy', 1); // behind Nginx
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// public assets only (css); protected HTML is served via guarded routes
app.use('/assets', express.static(path.join(__dirname, 'public')));

const view = (name) => path.join(__dirname, 'views', name);

// first-run: until an admin exists, send everyone to /setup
app.use((req, res, next) => {
  if (auth.hasAnyAdmin()) return next();
  if (req.path === '/setup' || req.path === '/api/setup' || req.path.startsWith('/assets')) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: 'Setup required.' });
  return res.redirect('/setup');
});

// tiny login rate-limiter (per IP)
const attempts = new Map();
function tooMany(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.ts > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return rec.count >= 8;
}
function bumpAttempt(ip) {
  const rec = attempts.get(ip) || { count: 0, ts: Date.now() };
  rec.count += 1; rec.ts = Date.now();
  attempts.set(ip, rec);
}
function clearAttempts(ip) { attempts.delete(ip); }

// ---------- result builder (no method fields leak to client) ----------
function buildResult(meta) {
  const res = lookupModule.lookup(meta.licensorUuid);
  return {
    ok: true,
    found: res.found,
    distributor: res.found ? res.distributor : null,
    subLabels: res.found ? res.subLabels : [],
    track: {
      name: meta.name,
      artist: meta.artist,
      isrc: meta.isrc,
      upc: meta.upc,
      date: meta.date,
      label: meta.label,
      image: meta.image,
    },
  };
}

// ===================== PUBLIC AUTH PAGES =====================
app.get('/login', (req, res) => {
  if (auth.readUser(req)) return res.redirect('/');
  res.sendFile(view('login.html'));
});

app.get('/setup', (req, res) => {
  if (auth.hasAnyAdmin()) return res.redirect('/login');
  res.sendFile(view('setup.html'));
});

app.get('/invite/:token', (req, res) => {
  const inv = auth.getInvite(req.params.token);
  if (!inv) return res.sendFile(view('invite-invalid.html'));
  res.sendFile(view('invite.html'));
});

// ===================== AUTH API =====================
app.post('/api/setup', (req, res) => {
  try {
    if (auth.hasAnyAdmin()) return res.status(400).json({ ok: false, error: 'Setup is already complete.' });
    const { email, password } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    auth.createUser({ email, password, role: 'admin' });
    const u = auth.findUserByEmail(email);
    auth.issueCookie(res, u);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  const { email, password } = req.body || {};
  const u = auth.verifyLogin(email, password);
  if (!u) { bumpAttempt(ip); return res.status(401).json({ ok: false, error: 'Incorrect email or password.' }); }
  clearAttempts(ip);
  auth.issueCookie(res, u);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { auth.clearCookie(res); res.json({ ok: true }); });

app.post('/api/accept-invite', (req, res) => {
  try {
    const { token, password } = req.body || {};
    const email = auth.acceptInvite(token, password);
    const u = auth.findUserByEmail(email);
    auth.issueCookie(res, u);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ===================== PROTECTED PAGES =====================
app.get('/', auth.requireAuth, (req, res) => res.sendFile(view('index.html')));
app.get('/admin', auth.requireAdmin, (req, res) => res.sendFile(view('admin.html')));

// ===================== TOOL API (auth required) =====================
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ ok: true, email: req.user.email, role: req.user.role }));

app.post('/api/lookup', auth.requireAuth, async (req, res) => {
  try {
    const { url } = req.body || {};
    const parsed = parseSpotifyInput(url);
    if (parsed.type !== 'track') return res.status(400).json({ ok: false, error: 'Please enter a track link.' });
    const meta = await getTrackMetadata(parsed.gid);
    res.json(buildResult(meta));
  } catch (e) { res.status(400).json({ ok: false, error: friendly(e.message) }); }
});

// admin-only manual fallback (kept generic; only the admin ever sees it)
app.post('/api/lookup-manual', auth.requireAdmin, (req, res) => {
  try {
    let { payload } = req.body || {};
    if (!payload) return res.status(400).json({ ok: false, error: 'Nothing to process.' });
    const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const track = obj.track || obj;
    const meta = normalizeTrack(track, null);
    if (!meta.licensorUuid) return res.status(400).json({ ok: false, error: 'No usable data in this input.' });
    res.json(buildResult(meta));
  } catch (e) { res.status(400).json({ ok: false, error: 'Could not read this input.' }); }
});

// ===================== ADMIN API =====================
app.get('/api/admin/users', auth.requireAdmin, (req, res) => res.json({ ok: true, ...auth.listUsers() }));

app.post('/api/admin/invite', auth.requireAdmin, (req, res) => {
  try {
    const { email, role } = req.body || {};
    const token = auth.createInvite({ email, role });
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, link: `${base}/invite/${token}` });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/remove', auth.requireAdmin, (req, res) => {
  try {
    const { email } = req.body || {};
    if (auth.readUser(req).email === (email || '').toLowerCase().trim())
      return res.status(400).json({ ok: false, error: 'You cannot remove your own account.' });
    auth.removeUser(email);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/stats', auth.requireAdmin, (req, res) => res.json({ ok: true, count: lookupModule.count() }));
app.post('/api/admin/reload', auth.requireAdmin, (req, res) => res.json({ ok: true, count: lookupModule.reload() }));

// friendly error text (never reveal internals)
function friendly(msg) {
  if (/token|Spotify|401|403/i.test(msg)) return 'Service is busy right now. Please try again in a moment.';
  return msg || 'Something went wrong.';
}

// first-run redirect helper
app.use((req, res) => {
  if (!auth.hasAnyAdmin()) return res.redirect('/setup');
  res.redirect('/login');
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
  console.log(`Sout Network Metadata running on http://localhost:${PORT}`);
  console.log(`Distributors loaded: ${lookupModule.count()}`);
  if (!auth.hasAnyAdmin()) console.log('No admin yet — open /setup to create the admin account.');
});
