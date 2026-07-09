// spotify.js — fetch metadata robustly: timeouts, retries, auth-refresh,
// and a safe per-track cache (keyed by the exact track id, so it can never
// return another track's data).

const { getToken, invalidate } = require('./tokenManager');
const BASE = 'https://spclient.wg.spotify.com/metadata/4';

// ---- safe result cache (gid -> result). gid uniquely identifies the track,
// and a released track's distributor/ISRC/UPC never change, so this is safe. ----
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h
const CACHE_MAX = 3000;
function cacheGet(gid) {
  const e = cache.get(gid);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(gid); return null; }
  return e.value;
}
function cacheSet(gid, value) {
  cache.set(gid, { value, exp: Date.now() + CACHE_TTL });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // drop oldest
}

async function fetchJson(url, token, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'App-Platform': 'WebPlayer', Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) { const e = new Error('auth'); e.code = 'AUTH'; throw e; }
    if (!res.ok) { const e = new Error('http-' + res.status); e.code = 'HTTP'; e.status = res.status; throw e; }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('timeout'); err.code = 'TIMEOUT'; throw err; }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function pickExternalId(arr, type) {
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((x) => (x.type || '').toLowerCase() === type);
  return hit ? hit.id : null;
}
function coverUrl(album) {
  try {
    const imgs = album.cover_group.image;
    const large = imgs.find((i) => i.size === 'LARGE') || imgs[imgs.length - 1];
    return `https://i.scdn.co/image/${large.file_id}`;
  } catch (_) { return null; }
}
function fmtDate(d) {
  if (!d || !d.year) return null;
  const p = (n) => String(n).padStart(2, '0');
  if (d.month && d.day) return `${d.year}-${p(d.month)}-${p(d.day)}`;
  if (d.month) return `${d.year}-${p(d.month)}`;
  return String(d.year);
}

function normalizeTrack(track, albumMeta) {
  const album = track.album || {};
  const licUuid = (track.licensor && track.licensor.uuid) || (album.licensor && album.licensor.uuid) || null;
  const artistName = (track.artist && track.artist[0] && track.artist[0].name) || null;
  return {
    name: track.name || null,
    artist: artistName,
    label: album.label || null,
    date: fmtDate(album.date),
    isrc: pickExternalId(track.external_id, 'isrc'),
    upc: albumMeta ? pickExternalId(albumMeta.external_id, 'upc') : null,
    image: coverUrl(album),
    licensorUuid: licUuid ? licUuid.replace(/-/g, '').toLowerCase() : null,
    albumGid: album.gid || null,
    trackGid: track.gid || null,
  };
}

// one full attempt: token -> track (+ album for UPC)
async function attempt(gid) {
  const token = await getToken();
  const track = await fetchJson(`${BASE}/track/${gid}?market=from_token`, token);
  if (!track || !track.gid) { const e = new Error('bad-data'); e.code = 'BAD'; throw e; }

  let albumMeta = null;
  const albumGid = track.album && track.album.gid;
  if (albumGid) {
    try { albumMeta = await fetchJson(`${BASE}/album/${albumGid}?market=from_token`, token, 5000); }
    catch (_) { albumMeta = null; } // UPC is best-effort, never fatal
  }
  return normalizeTrack(track, albumMeta);
}

async function getTrackMetadata(gid) {
  const cached = cacheGet(gid);
  if (cached) return cached;

  const MAX = 3;
  let lastErr;
  for (let i = 0; i < MAX; i++) {
    try {
      const meta = await attempt(gid);
      if (meta && meta.trackGid) {
        if (meta.licensorUuid) cacheSet(gid, meta); // only cache complete results
        return meta;
      }
      lastErr = new Error('incomplete');
    } catch (e) {
      lastErr = e;
      if (e.code === 'AUTH') invalidate();     // force a fresh token next loop
      if (e.code === 'NO_BROWSER') throw e;     // no point retrying
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1))); // small backoff
  }
  throw lastErr || new Error('lookup-failed');
}

module.exports = { getTrackMetadata, normalizeTrack, pickExternalId, fmtDate };
