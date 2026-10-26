# WAREXX — interactive demo

The WAREXX app's screens running on a fictional sample business ("Sample Company"),
entirely in the browser. A service worker (`frontend/demo/public/sw.js`) answers every
`/api` request from recorded answers in `demo-data/recorded/` — there is no server,
database or production API behind it, and the page's Content-Security-Policy keeps
every request on its own origin.

This repository holds only the demo. The landing page and the production software
live elsewhere.

## Run locally

```bash
cd frontend
npm ci
npm run dev        # http://localhost:8002
```

`npm run build` writes static files to `frontend/dist/demo`; `npm run preview` serves them.
The demo must be served from the root of its origin (the service worker answers `/api`).

## Layout

- `frontend/demo/` — the demo shell: start-up, product tour, demo banner, service worker
- `frontend/vendor/warexx-app/` — snapshot of the WAREXX app's front end
- `frontend/tools/mobile-page.mjs` — builds the phone app at `/m`
- `demo-data/recorded/` — the recorded answers (`manifest.json` + `bodies/`)
- `vercel.json` — Vercel build and headers
