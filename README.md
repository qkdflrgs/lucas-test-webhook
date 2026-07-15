# CHeKT Monitoring Dashboard

A monitoring dashboard demo built on the [CHeKT Public API](https://public-apidoc-chekt.web.app/).
It lists sites, shows live arming state and camera status, browses activity logs and
event video — and **applies incoming webhooks to the dashboard in real time**.

- **Backend** — Express server. Holds the API key server-side and proxies the CHeKT API.
  Also receives CHeKT webhooks and relays them to the browser over SSE.
- **Frontend** — static HTML/CSS/JS (no build step). Subscribes to the SSE stream and
  updates arming badges, camera status, and the activity feed without a page reload.

```
demo/
├─ server.js          Express: API proxy + webhook receiver + SSE + static hosting
├─ lib/chekt.js       CHeKT API client (Bearer auth, per-resource helpers)
├─ public/
│  ├─ index.html      Dashboard markup
│  ├─ styles.css      Styles (dark theme)
│  └─ app.js          Dashboard logic + live webhook handling
├─ .env               Config (API key, base URL, port) — git-ignored
└─ .env.example       Template
```

## Setup

```bash
npm install
cp .env.example .env      # then fill in CHEKT_API_KEY
npm start                 # or: npm run dev  (auto-restart on change)
```

Open **http://localhost:3000**.

### Configuration (`.env`)

| Variable | Description |
|---|---|
| `CHEKT_API_KEY` | Dealer API key. Dealer portal → Settings → Developer Settings → API Keys. Required for live data. |
| `CHEKT_API_BASE` | API base URL. `https://api.chekt.com` (prod) or `https://api.chektdev.com` (dev). |
| `PORT` | HTTP port. Defaults to `3000`. |

The API key is read only on the server and is **never** sent to the browser — the frontend
talks exclusively to the local `/api/*` proxy.

## Features

- **Sites** — searchable list; partition / inactive tags; account numbers.
- **Arming** — live status with Arm / Disarm. Partition-system sites get per-partition controls.
- **Cameras** — online/offline status, zones, and an MJPEG thumbnail for online cameras.
- **Activity Log** — category + time-range filtered, cursor pagination, per-event video links.
- **Event Video** — fetches presigned mp4/snapshot URLs on demand.
- **Live Events (webhooks)** — see below.

## Live webhook updates

Point your CHeKT dealer webhook subscription at:

```
POST http://<this-host>:3000/webhook
```

Every delivery is normalized and pushed to open dashboards over Server-Sent Events. The
browser then **applies the change in place** (inspired by `lucas-test-webhook`, but instead
of logging payloads to disk it mutates the live view):

| Webhook `event_type` | What the dashboard does |
|---|---|
| `arming_status` | Update the arming badge for the matching site |
| `partition_arming_status` | Refresh partition arming state |
| `camera_network` (`is_online`) | Flip that camera online/offline + update KPIs |
| `alarm_event`, `event_video` | Prepend a live row to the activity log |
| *(any)* | Add to the **📡 Events** feed drawer + toast for notable events |

Expected CHeKT wire format (see `@chekt/webhook`):

```json
{
  "event_id": 25,
  "event_type": "arming_status",
  "status": "armed",
  "api_version": "v1",
  "payload": {
    "data": { "site_id": 1784, "site_name": "Trevor Office", "arming_status": "armed" },
    "triggered_by": { "email": "user@example.com" }
  }
}
```

### Try it locally

With the server running, open the dashboard, select the matching site, then send:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event_type":"arming_status","status":"armed","payload":{"data":{"site_id":1784,"site_name":"Trevor Office","arming_status":"armed"}}}'
```

The arming badge flips to **Armed**, a live row appears in the activity log, and the event
shows in the 📡 Events drawer — no reload.

> Receiving webhooks from CHeKT's servers requires a publicly reachable URL. For local
> testing, expose the port with a tunnel (e.g. `ngrok http 3000`) and register that URL.

## HTTP surface

Frontend-facing routes (proxied to CHeKT unless noted):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Server mode (configured? base URL) — *local* |
| GET | `/api/sites` | List sites |
| GET/POST | `/api/sites/:id/arming[/arm\|/disarm]` | Site arming |
| GET/POST | `/api/sites/:id/partition-arming[/arm\|/disarm]` | Partition arming |
| GET | `/api/sites/:id/cameras` · `/zones` · `/audio-devices` | Devices |
| GET/POST | `/api/activity-logs/categories` · `/search` | Activity logs |
| POST | `/api/events-video-urls` | Event video URLs |
| GET | `/api/events/stream` | SSE stream of webhooks — *local* |
| GET | `/api/events/recent` | Recent webhooks (hydration) — *local* |
| POST | `/webhook` (+ `/webhook/*`) | Webhook receiver — *local* |
