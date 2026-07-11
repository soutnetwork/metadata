// server.js — Sout Network Metadata (protected, English UI)
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { parseSpotifyInput } = require('./src/spotifyId');
const { getTrackMetadata, normalizeTrack } = require('./src/spotify');
const lookupModule = require('./src/lookup');
const history = require('./src/history');
const pending = require('./src/pending');
const requests = require('./src/requests');
const auth = require('./src/auth');

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.message) || e));

const MAX_CONCURRENT = 6;
let active = 0;
const waiters = [];
function acquire() { return new Promise((res) => { if (active < MAX_CONCURRENT) { active++; res(); } else waiters.push(res); }); }
function release() { active--; if (waiters.length) { active++; waiters.shift()(); } }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, 'public')));

const view = (name) => path.join(__dirname, 'views', name);

app.use((req, res, next) => {
  if (auth.hasAnyAdmin()) return next();
  if (req.path === '/setup' || req.path === '/api/setup' || req.path === '/healthz' || req.path.startsWith('/assets')) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: 'Setup required.' });
  return res.redirect('/setup');
});

function coverFileId(imageUrl) {
  if (!imageUrl) return null;
  const m = String(imageUrl).match(/image\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// perms decide what codes are visible
function buildResult(meta, perms) {
  const res = lookupModule.lookup(meta.licensorUuid);
  const seeCodes = perms ? perms.seeCodes : true;
  return {
    ok: true,
    found: res.found,
    distributor: res.found ? res.distributor : null,
    subLabels: res.found ? res.subLabels : [],
    track: {
      name: meta.name,
      artist: meta.artist,
      isrc: seeCodes ? meta.isrc : null,
      upc: seeCodes ? meta.upc : null,
      date: meta.date,
      label: meta.label,
      image: meta.image,
      coverFile: coverFileId(meta.image),
    },
  };
}

// ===================== PUBLIC AUTH PAGES =====================
app.get('/login', (req, res) => { if (auth.readUser(req)) return res.redirect('/'); res.sendFile(view('login.html')); });
app.get('/setup', (req, res) => { if (auth.hasAnyAdmin()) return res.redirect('/login'); res.sendFile(view('setup.html')); });
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
    auth.issueCookie(res, auth.findUserByEmail(email));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const r = auth.verifyLogin(email, password, req.ip);
  if (!r.ok) return res.status(r.locked ? 423 : 401).json({ ok: false, error: r.error });
  auth.issueCookie(res, r.user);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { auth.clearCookie(res); res.json({ ok: true }); });

app.post('/api/accept-invite', (req, res) => {
  try {
    const { token, password } = req.body || {};
    const email = auth.acceptInvite(token, password);
    auth.issueCookie(res, auth.findUserByEmail(email));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ===================== PROTECTED PAGES =====================
app.get('/', auth.requireAuth, (req, res) => res.sendFile(view('index.html')));
app.get('/history', auth.requireAuth, (req, res) => res.sendFile(view('myhistory.html')));
app.get('/admin', auth.requireAdmin, (req, res) => res.sendFile(view('admin.html')));
app.get('/scanner', auth.requireAdmin, (req, res) => res.sendFile(view('scanner.html')));

// a user's own history (their searches only)
app.get('/api/my-history', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  res.json({ ok: true, ...history.list({ email: req.user.email, limit }) });
});

// ---- manual services (copyright / youtube owner / yt->distributor) ----
const SERVICE_ROUTES = { '/copyright': 'copyright', '/youtube-owner': 'youtube_owner', '/yt-distributor': 'yt_distributor' };
for (const route of Object.keys(SERVICE_ROUTES)) {
  app.get(route, auth.requireAuth, (req, res) => res.sendFile(view('service.html')));
}

app.get('/api/services', auth.requireAuth, (req, res) => res.json({ ok: true, services: requests.SERVICES }));

app.post('/api/request', auth.requireAuth, (req, res) => {
  try {
    const { type, input } = req.body || {};
    const t = requests.create({ type, input, email: req.user.email });
    res.json({ ok: true, id: t.id });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/my-requests', auth.requireAuth, (req, res) => {
  const type = req.query.type ? String(req.query.type) : null;
  res.json({ ok: true, items: requests.listByUser(req.user.email, type) });
});

// ===================== TOOL API =====================
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ ok: true, email: req.user.email, role: req.user.role, perms: req.user.perms }));

app.post('/api/lookup', auth.requireAuth, async (req, res) => {
  await acquire();
  try {
    const { url } = req.body || {};
    const parsed = parseSpotifyInput(url);
    if (parsed.type !== 'track') return res.status(400).json({ ok: false, error: 'Please enter a track link.' });
    const meta = await getTrackMetadata(parsed.gid);
    const result = buildResult(meta, req.user.perms);
    history.log({
      email: req.user.email, url, gid: parsed.gid,
      track: { name: meta.name, artist: meta.artist },
      distributor: result.distributor, found: result.found,
    });
    // unknown distributor -> collect it for the admin to identify
    if (!result.found && meta.licensorUuid) {
      pending.add({ uuid: meta.licensorUuid, track: { name: meta.name, artist: meta.artist }, url, email: req.user.email });
    }
    res.json(result);
  } catch (e) { res.status(400).json({ ok: false, error: friendly(e) }); }
  finally { release(); }
});

// cover image download (streamed with attachment header)
app.get('/api/cover', auth.requireAuth, async (req, res) => {
  try {
    if (!req.user.perms.downloadCover) return res.status(403).json({ ok: false, error: 'Not allowed.' });
    const file = (req.query.file || '').toString();
    if (!/^[a-z0-9]{20,60}$/i.test(file)) return res.status(400).json({ ok: false, error: 'Bad request.' });
    const r = await fetch(`https://i.scdn.co/image/${file}`);
    if (!r.ok) return res.status(404).json({ ok: false, error: 'Cover not found.' });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="cover-${file}.jpg"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ ok: false, error: 'Download failed.' }); }
});

// admin-only manual fallback
app.post('/api/lookup-manual', auth.requireAdmin, (req, res) => {
  try {
    let { payload } = req.body || {};
    if (!payload) return res.status(400).json({ ok: false, error: 'Nothing to process.' });
    const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const track = obj.track || obj;
    const meta = normalizeTrack(track, null);
    if (!meta.licensorUuid) return res.status(400).json({ ok: false, error: 'No usable data in this input.' });
    res.json(buildResult(meta, req.user.perms));
  } catch (e) { res.status(400).json({ ok: false, error: 'Could not read this input.' }); }
});

// ===================== ADMIN API: users & permissions =====================
app.get('/api/admin/users', auth.requireAdmin, (req, res) => res.json({ ok: true, ...auth.listUsers() }));

app.post('/api/admin/invite', auth.requireAdmin, (req, res) => {
  try {
    const { email, role, perms } = req.body || {};
    const token = auth.createInvite({ email, role, perms });
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, link: `${base}/invite/${token}` });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/permissions', auth.requireAdmin, (req, res) => {
  try {
    const { email, perms } = req.body || {};
    auth.setPermissions(email, perms || {});
    res.json({ ok: true });
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

// ===================== ADMIN API: distributors =====================
app.get('/api/admin/distributors', auth.requireAdmin, (req, res) => res.json({ ok: true, count: lookupModule.count(), items: lookupModule.listAll() }));

app.get('/api/admin/pending', auth.requireAdmin, (req, res) => res.json({ ok: true, count: pending.count(), items: pending.list() }));
app.post('/api/admin/pending/dismiss', auth.requireAdmin, (req, res) => { pending.remove((req.body || {}).uuid); res.json({ ok: true }); });

app.post('/api/admin/distributors/add', auth.requireAdmin, (req, res) => {
  try { const r = lookupModule.addEntry(req.body || {}); pending.remove(r.uuid); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/admin/distributors/update', auth.requireAdmin, (req, res) => {
  try { const { uuid, distributor, notes } = req.body || {}; res.json({ ok: true, ...lookupModule.updateEntry(uuid, { distributor, notes }) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/admin/distributors/delete', auth.requireAdmin, (req, res) => {
  try { res.json({ ok: true, ...lookupModule.deleteEntry((req.body || {}).uuid) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/admin/distributors/bulk', auth.requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const input = body.rows || body.text || '';
    const r = lookupModule.bulkAdd(input);
    // clear any of these from the pending queue
    pending.remove(lookupModule.listAll().map((x) => x.uuid));
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ===================== ADMIN API: history =====================
app.get('/api/admin/history', auth.requireAdmin, (req, res) => {
  const email = req.query.email ? String(req.query.email) : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json({ ok: true, ...history.list({ email, limit, offset }) });
});
app.get('/api/admin/history/stats', auth.requireAdmin, (req, res) => res.json({ ok: true, ...history.stats() }));

app.get('/api/admin/stats', auth.requireAdmin, (req, res) => res.json({ ok: true, count: lookupModule.count() }));

// bulk scanner: paste many track links -> resolve UUIDs, flag known/unknown, collect unknowns
app.post('/api/admin/scan', auth.requireAdmin, async (req, res) => {
  let text = (req.body && req.body.text) || '';
  let links = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  links = [...new Set(links)];
  if (!links.length) return res.status(400).json({ ok: false, error: 'Paste some track links.' });
  if (links.length > 30) links = links.slice(0, 30);

  const results = new Array(links.length);
  let i = 0;
  async function worker() {
    while (i < links.length) {
      const idx = i++;
      const link = links[idx];
      try {
        let parsed;
        try { parsed = parseSpotifyInput(link); }
        catch (_) { results[idx] = { input: link, ok: false, error: 'Invalid track link' }; continue; }
        if (parsed.type !== 'track') { results[idx] = { input: link, ok: false, error: 'Not a track link' }; continue; }
        const meta = await getTrackMetadata(parsed.gid);
        const lk = lookupModule.lookup(meta.licensorUuid);
        results[idx] = {
          input: link, ok: true, uuid: meta.licensorUuid,
          found: lk.found, distributor: lk.found ? lk.distributor : null,
          track: { name: meta.name, artist: meta.artist },
        };
        if (!lk.found && meta.licensorUuid) {
          pending.add({ uuid: meta.licensorUuid, track: { name: meta.name, artist: meta.artist }, url: link, email: req.user.email });
        }
      } catch (e) { results[idx] = { input: link, ok: false, error: friendly(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, links.length) }, worker));
  res.json({ ok: true, results });
});

// export the whole distributor database as CSV (opens in Excel)
app.get('/api/admin/distributors/export', auth.requireAdmin, (req, res) => {
  const items = lookupModule.listAll();
  const rows = [['UUID', 'Distributor', 'Sub-labels']];
  for (const x of items) rows.push([x.uuid, x.distributor, (x.subLabels || []).join('; ')]);
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sout-distributors.csv"');
  res.send('\uFEFF' + csv);
});app.post('/api/admin/reload', auth.requireAdmin, (req, res) => res.json({ ok: true, count: lookupModule.reload() }));

// ---- admin: manual service requests ----
app.get('/api/admin/requests', auth.requireAdmin, (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const type = req.query.type ? String(req.query.type) : null;
  const email = req.query.email ? String(req.query.email) : null;
  res.json({ ok: true, services: requests.SERVICES, pending: requests.pendingCount(), items: requests.listAll({ status, type, email }) });
});
app.post('/api/admin/requests/resolve', auth.requireAdmin, (req, res) => {
  try { const { id, fields } = req.body || {}; res.json({ ok: true, ...requests.resolve(id, fields, req.user.email) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/admin/requests/reject', auth.requireAdmin, (req, res) => {
  try { res.json({ ok: true, ...requests.reject((req.body || {}).id, req.user.email) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

function friendly(e) {
  const code = e && e.code; const msg = (e && e.message) || '';
  if (code === 'NO_BROWSER') return 'Automatic lookup is not ready yet on the server.';
  if (code === 'TIMEOUT' || code === 'TOKEN_FAIL' || code === 'AUTH' || code === 'HTTP' || /token|Spotify|401|403/i.test(msg))
    return 'Service is busy right now. Please try again in a moment.';
  if (code === 'BAD' || msg === 'incomplete') return 'Could not read this track. Please try again.';
  if (msg && /track link|album/i.test(msg)) return msg;
  return 'Something went wrong. Please try again.';
}

app.get('/healthz', (req, res) => res.json({ ok: true, active }));

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
