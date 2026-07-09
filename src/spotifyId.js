// Spotify ID helpers: parse a track/album URL or URI, and convert
// the base62 public ID (22 chars) into the 32-char hex "gid" that the
// internal metadata endpoint uses.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// base62 (22 chars) -> hex gid (32 chars)
function base62ToHex(b62) {
  let n = 0n;
  for (const ch of b62) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`حرف غير صالح في الـ ID: ${ch}`);
    n = n * 62n + BigInt(idx);
  }
  let hex = n.toString(16);
  return hex.padStart(32, '0');
}

// Accepts:
//   https://open.spotify.com/track/5QcKfelvu87aGBWq6z7cpS?si=...
//   https://open.spotify.com/intl-ar/track/5QcKfelvu87aGBWq6z7cpS
//   spotify:track:5QcKfelvu87aGBWq6z7cpS
//   5QcKfelvu87aGBWq6z7cpS   (raw id)
// Returns { type: 'track'|'album', id, gid }
function parseSpotifyInput(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('من فضلك ادخل لينك تراك صحيح');
  }
  const s = input.trim();

  // spotify:track:xxxx  or  spotify:album:xxxx
  let m = s.match(/spotify:(track|album):([A-Za-z0-9]{22})/);
  if (m) return finalize(m[1], m[2]);

  // open.spotify.com/.../track/xxxx  or  /album/xxxx
  m = s.match(/open\.spotify\.com\/(?:[a-z-]+\/)?(track|album)\/([A-Za-z0-9]{22})/);
  if (m) return finalize(m[1], m[2]);

  // raw 22-char id -> assume track
  m = s.match(/^([A-Za-z0-9]{22})$/);
  if (m) return finalize('track', m[1]);

  throw new Error('مش قادر أستخرج الـ ID من اللينك. اتأكد إنه لينك تراك من Spotify.');
}

function finalize(type, id) {
  return { type, id, gid: base62ToHex(id) };
}

module.exports = { base62ToHex, parseSpotifyInput, ALPHABET };
