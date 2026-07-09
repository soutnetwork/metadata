// spotify.js — fetch metadata from the internal web-player endpoint.

const { getToken } = require('./tokenManager');

const BASE = 'https://spclient.wg.spotify.com/metadata/4';

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'App-Platform': 'WebPlayer',
      Accept: 'application/json',
    },
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error(`Spotify رفض الطلب (${res.status}) — التوكن محتاج يتجدّد`);
    e.code = 'AUTH';
    throw e;
  }
  if (!res.ok) throw new Error(`Spotify رجّع خطأ ${res.status}`);
  return res.json();
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
  } catch (_) {
    return null;
  }
}

function fmtDate(d) {
  if (!d) return null;
  const { year, month, day } = d;
  if (!year) return null;
  const p = (n) => String(n).padStart(2, '0');
  if (month && day) return `${year}-${p(month)}-${p(day)}`;
  if (month) return `${year}-${p(month)}`;
  return String(year);
}

// Normalize the raw track metadata JSON into the shape the app/card use.
function normalizeTrack(track, albumMeta) {
  const album = track.album || {};
  const licUuid =
    (track.licensor && track.licensor.uuid) ||
    (album.licensor && album.licensor.uuid) ||
    null;

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

// Full auto path: gid -> token -> track meta (+ album meta for UPC)
async function getTrackMetadata(gid) {
  let token = await getToken();

  let track;
  try {
    track = await fetchJson(`${BASE}/track/${gid}?market=from_token`, token);
  } catch (e) {
    if (e.code === 'AUTH') {
      // force refresh once
      const { getToken: gt } = require('./tokenManager');
      token = await gt();
      track = await fetchJson(`${BASE}/track/${gid}?market=from_token`, token);
    } else {
      throw e;
    }
  }

  // best-effort album fetch for UPC (never fatal)
  let albumMeta = null;
  const albumGid = track.album && track.album.gid;
  if (albumGid) {
    try {
      albumMeta = await fetchJson(`${BASE}/album/${albumGid}?market=from_token`, token);
    } catch (_) {
      albumMeta = null;
    }
  }

  return normalizeTrack(track, albumMeta);
}

module.exports = { getTrackMetadata, normalizeTrack, pickExternalId, fmtDate };
