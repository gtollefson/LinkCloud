# Concept Network Cloud

A lightweight, open-source classroom tool where students submit linked concepts and see a shared concept network update live. No accounts or logins required—each browser session counts a unique concept pair at most once.

## Why this stack?
- **Language & runtime:** Node.js + Express keeps the backend tiny, easy to reason about, and deployable on any free-tier Node host (Render, Railway, Fly.io, etc.).
- **Persistence:** `better-sqlite3` stores data in a single on-disk SQLite database—perfect for low-cost hosting without external services.
- **Realtime updates:** Socket.IO pushes graph changes instantly to every connected student.
- **Frontend:** Vanilla HTML/CSS/JS with `vis-network` for a zero-build visualization (drop into any static host).

This balance keeps the app simple to deploy and run for free while remaining fully open source and easy to extend.

## Quick start
```bash
npm install
npm run dev
```

Visit `http://localhost:3000` and submit concept links to see the network update in real time. A small demo dataset is seeded automatically on first run.

To run without auto-reload:
```bash
npm start
```

## Deployment tips (zero-cost friendly)
- **Render (free web service):** Connect the repo, set the build command to `npm install` and the start command to `npm start`. Persist the `data/` directory by enabling a disk.
- **Railway / Fly.io:** Similar setup—provision a small persistent volume mounted at `/app/data` so the SQLite file survives restarts.
- **Self-host:** Deploy on any small VM (e.g., free-tier Oracle/AWS/GCP student credits). Reverse proxy via Nginx/Caddy and run `npm start` under a process manager like `pm2` or `systemd`.

Because the frontend is static, you can also serve `public/` from any CDN and point it at a hosted API instance.

## File structure
- `server.js` – Express API + Socket.IO server, SQLite persistence, session handling.
- `public/` – Static client (`index.html`, `styles.css`, `app.js`) served directly by Express.
- `data/` – SQLite database (`concepts.db`). Keep this directory writable on your host.

## Extending the app
- Add classroom-specific rooms by tagging submissions with a code and scoping queries.
- Export network data (`GET /api/graph`) for after-class analysis.
- Use a CRON job or admin route to reset the graph between sessions.

Contributions welcome—open an issue or PR with improvements!

