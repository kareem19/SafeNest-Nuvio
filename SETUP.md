# Hosting SafeNest for public users (all free)

Two free pieces, both deployed from the same GitHub repo:

| Piece | Where | What it does | Free limits |
|---|---|---|---|
| Landing page (`docs/index.html`) | GitHub Pages | style previews, optional TMDB key, makes the personal link | static, about 100 GB/month |
| Addon + API (`src/`) | Cloudflare Workers | answers Nuvio, scrapes, caches | 100k requests/day, 10 ms CPU, KV 1,000 writes/day, AI 10,000 neurons/day |

Bandwidth on Workers is free. If the addon outgrows the limits, Workers Paid is $5/month (10 million requests).

## 1. GitHub
Upload (with the upload button, not paste): `src/`, `tests/`, `docs/`, `package.json`, `wrangler.toml`, `README.md`, `SETUP.md`.

## 2. Cloudflare Worker (already done if your addon works)
- Settings > Builds > Build command: `npm test` (a wrong label on a known title blocks the deploy).
- Optional but recommended for public use: Settings > Variables and secrets > Secret `CONFIG_SECRET` = any long random text.
  With it, personal links are encrypted, so nobody can read a user's TMDB key out of the link.
- Optional: Secret `TMDB_API_KEY` (your own) so users who add no key still get age ratings.

## 3. Landing page on GitHub Pages
1. Open `docs/index.html`, find the line `const API = ... 'https://YOUR-WORKER.workers.dev'` and put your Worker address there.
2. GitHub repo > Settings > Pages > Source: Deploy from a branch > Branch `main`, folder `/docs` > Save.
3. After a minute the page is live at `https://<your-user>.github.io/<repo>/`.

## 4. Free domain (optional)
The `github.io` address is free and has HTTPS, so a domain is not required.
For a nicer name, a free subdomain such as `yourname.is-a.dev` (request it with a pull request on the is-a.dev GitHub repo)
can point to GitHub Pages: add it under Pages > Custom domain. Keep the Worker on its free `workers.dev` address.

## Why not another host
- Vercel / Netlify free plans: non-commercial limits and slower cold starts for scraping.
- Render free: the server sleeps, so the first card of the day is slow.
- Deno Deploy: free and good, but the Worker would need rewriting.
