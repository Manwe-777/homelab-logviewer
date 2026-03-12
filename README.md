# homelab-logviewer

A lightweight web UI for monitoring logs from Docker containers and log files in a homelab environment.

## How it works

A small Express server serves a browser-based UI and exposes three API endpoints:

- `GET /api/sources` — returns the configured log sources
- `GET /api/logs/:id` — reads log content (file or Docker container)
- `GET /api/status/:id` — returns running/stopped/unhealthy status

The frontend polls for new log lines at a configurable interval and appends them in real time without a full reload. For file sources, polling uses byte offsets. For Docker sources, it uses the Docker Engine Unix socket and timestamp-based pagination.

## Configuration

Copy `.env.example` to `.env` and set your sources:

```env
PORT=3102
MAX_LINES=500
POLL_INTERVAL=2000

LOG_SOURCES=[
  { "name": "Syslog", "path": "/logs/syslog" },
  { "name": "Plex", "container": "big-bear-plex" }
]
```

## Running

```bash
# With Docker Compose (recommended)
docker compose up -d

# Or directly
npm install
npm start
```

The UI is available at `http://localhost:3102`.
