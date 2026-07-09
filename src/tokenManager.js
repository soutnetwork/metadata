// tokenManager.js
// Gets an anonymous Spotify web-player token via a headless browser, caches it
// (~1h), and refreshes only when needed. Hardened: single-flight refresh,
// hard timeouts, conservative memory flags, and self-recovery.
//
// On a 2GB box we deliberately do NOT keep a browser alive — we launch it only
// to refresh the token (rare), then close it immediately, so we never compete
// for memory with the main app.

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) {}

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-extensions', '--disable-background-networking',
  '--disable-background-timer-throttling', '--mute-audio', '--no-first-run',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let cache = { token: null, expiresAt: 0 };
let inFlight = null;

function invalidate() { cache = { token: null, expiresAt: 0 }; }

async function fetchFreshToken() {
  if (!chromium) { const e = new Error('browser-not-installed'); e.code = 'NO_BROWSER'; throw e; }

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, timeout: 60000 });
  try {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();

    const captured = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };

      page.on('response', async (res) => {
        const url = res.url();
        if (url.includes('/api/token') || url.includes('get_access_token') || url.includes('clienttoken')) {
          try { const j = await res.json(); if (j && j.accessToken) finish(j); } catch (_) {}
        }
      });

      page.goto('https://open.spotify.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
        .then(async () => {
          // fallback: read token from the page's embedded session config
          if (!done) {
            const cfg = await page.evaluate(() => {
              try {
                const el = document.getElementById('session') || document.getElementById('config');
                if (el) { const c = JSON.parse(el.textContent); if (c.accessToken) return c; }
              } catch (_) {}
              return null;
            }).catch(() => null);
            if (cfg) finish(cfg);
          }
        })
        .catch(() => {});

      // hard cap so we never hang
      setTimeout(() => finish(null), 30000);
    });

    if (!captured || !captured.accessToken) {
      const e = new Error('token-capture-failed'); e.code = 'TOKEN_FAIL'; throw e;
    }

    const expMs = captured.accessTokenExpirationTimestampMs || captured.expiresAt || (Date.now() + 55 * 60 * 1000);
    cache = { token: captured.accessToken, expiresAt: expMs };
    return cache.token;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function getToken() {
  if (cache.token && Date.now() < cache.expiresAt - 60000) return cache.token;
  if (!inFlight) inFlight = fetchFreshToken().finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { getToken, invalidate };
