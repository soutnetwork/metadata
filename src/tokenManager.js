// tokenManager.js
// ----------------------------------------------------------------------------
// This is the ONLY fragile part of the whole project. Spotify protects its
// anonymous token endpoint with an anti-bot mechanism (TOTP) that changes
// from time to time. Instead of re-implementing that TOTP by hand (which
// breaks often), we let Spotify's OWN JavaScript generate a valid token by
// loading open.spotify.com in a real headless browser, then we grab the
// token it produces. That token is valid for ~1 hour, so we cache it and
// only re-launch the browser when it expires. Most lookups never touch the
// browser at all.
//
// If Spotify ever changes things and token fetching breaks, THIS is the only
// file you need to look at. Everything else keeps working (and the manual
// "paste JSON" mode in the app works with no token at all).
// ----------------------------------------------------------------------------

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  // playwright not installed yet — auto mode will report a clear error.
}

let cache = { token: null, expiresAt: 0 };
let inFlight = null;

async function fetchFreshToken() {
  if (!chromium) {
    throw new Error(
      'Playwright مش متسطّب. شغّل: npm install  ثم  npx playwright install --with-deps chromium'
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    let captured = null;
    page.on('response', async (res) => {
      const url = res.url();
      if (
        url.includes('/api/token') ||
        url.includes('get_access_token') ||
        url.includes('clienttoken')
      ) {
        try {
          const j = await res.json();
          if (j && j.accessToken) captured = j;
        } catch (_) {}
      }
    });

    await page.goto('https://open.spotify.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // wait up to ~15s for the token response to show up
    for (let i = 0; i < 30 && !captured; i++) {
      await page.waitForTimeout(500);
    }

    // Fallback: read it from the page's session config if the network hook missed it
    if (!captured) {
      captured = await page
        .evaluate(() => {
          try {
            const el = document.getElementById('session') || document.getElementById('config');
            if (el) {
              const cfg = JSON.parse(el.textContent);
              if (cfg.accessToken) return cfg;
            }
          } catch (_) {}
          return null;
        })
        .catch(() => null);
    }

    if (!captured || !captured.accessToken) {
      throw new Error('معرفتش أجيب التوكن من Spotify. جرّب تاني، ولو استمرت المشكلة استخدم وضع لصق الـ JSON اليدوي.');
    }

    const expMs =
      captured.accessTokenExpirationTimestampMs ||
      captured.expiresAt ||
      Date.now() + 55 * 60 * 1000;

    cache = { token: captured.accessToken, expiresAt: expMs };
    return cache.token;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function getToken() {
  // reuse cached token until 60s before expiry
  if (cache.token && Date.now() < cache.expiresAt - 60000) {
    return cache.token;
  }
  // collapse concurrent refreshes into one browser launch
  if (!inFlight) {
    inFlight = fetchFreshToken().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

module.exports = { getToken };
