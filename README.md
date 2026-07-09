# Sout Network — Metadata

Internal distributor-lookup dashboard. Paste a track link and it returns the
distributor, release date, UPC and ISRC. Access is protected: an admin account
plus invited users. Runs on your own server, no external database.

---

## What you get

- **Login-protected** dashboard (nobody without an account can reach it).
- **Admin** (you): invite people, manage accounts, remove access.
- **Users** (team / clients): can use the lookup only.
- English interface, clean and neutral.
- File-based storage — nothing to install or maintain besides Node.

---

## Requirements

- Node.js **18+**
- A subdomain, e.g. `metadata.soutnetwork.com`

---

## 1) Install & run

```bash
npm install
npx playwright install --with-deps chromium
NODE_ENV=production pm2 start server.js --name metadata
pm2 save
```

Runs on port **3005** (override with `PORT`).

## 2) DNS

Add an **A record** for `metadata` pointing to your server IP (same as you did
for your other subdomains).

## 3) Nginx + SSL

```nginx
server {
    server_name metadata.soutnetwork.com;

    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then issue the certificate:

```bash
sudo certbot --nginx -d metadata.soutnetwork.com
```

## 4) Create your admin account

Open `https://metadata.soutnetwork.com` — the first visit shows a one-time
**setup** screen. Enter your email + password. That becomes the admin.
After that, the setup screen is closed forever.

## 5) Invite people

Go to **Admin → Invite someone**, type their email, pick a role, and you get a
link. Send it to them; they set their own password and they're in.

---

## Adding distributors to the reference set

Everything lives in one file: **`data/uuid-map.json`**.

You keep working in Excel; regenerate the JSON with:

```bash
npm i xlsx                                   # once
node scripts/xlsx-to-json.js "your-file.xlsx"
```

Then (no restart needed) sign in as admin — the count refreshes on load. Or:

```bash
curl -X POST https://metadata.soutnetwork.com/api/admin/reload \
  -b "sn_session=YOUR_COOKIE"
```

---

## If the automatic lookup ever stops working

Only one file is involved: **`src/tokenManager.js`** (isolated on purpose).
Meanwhile, as admin you have an **Advanced input** fallback on the lookup page
that always works. Regular users never see it.

---

## Files

| File | Purpose |
|------|---------|
| `server.js` | Server, routes, guards |
| `src/auth.js` | Accounts, passwords, sessions, invites |
| `src/spotifyId.js` | Link → internal id |
| `src/tokenManager.js` | Access token (the only sensitive part) |
| `src/spotify.js` | Fetch + extract fields |
| `src/lookup.js` | Distributor lookup |
| `data/uuid-map.json` | Reference set (97 distributors) |
| `views/` | All pages (login, setup, invite, tool, admin) |
| `public/style.css` | Shared styling |

## Notes on data files (auto-created, keep private)

- `data/users.json` — accounts (passwords are hashed). **Not** in git.
- `data/.secret` — session signing key. **Not** in git.

Back these two up if you want accounts to survive a server rebuild.
