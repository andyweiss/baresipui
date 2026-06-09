# Baresip Control Dashboard - Docker Setup

Complete Docker-based project for monitoring and controlling Baresip SIP accounts with auto-connect functionality.

## Architecture

- **App**: Nuxt 3 + TypeScript + Tailwind CSS + Socket.IO (Port 3000)
- **Baresip**: SIP softphone with TCP control interface (Port 4444)
- **Communication**: TCP netstring protocol (App → Baresip), Socket.IO (App → Browser)
- **Logging**: Shared volume — baresip stdout/stderr piped via `tee` to a log file, read by the app with `tail -F`

```
┌──────────┐  TCP:4444  ┌───────────┐  Socket.IO  ┌─────────┐
│ Baresip  │◄──────────►│  Nuxt App │◄───────────►│ Browser │
│          │            │  :3000    │             │         │
│  stdout ─┼── tee ──►  /shared-logs/baresip.log  │         │
│          │            │  tail -F ◄──────────────│         │
└──────────┘            └───────────┘             └─────────┘
```

## Quick Start

### 1. Configure SIP Accounts

Edit `baresip/config/accounts` with your SIP credentials:

```
<sip:user1@sip.example.com>;auth_pass=password1
<sip:user2@sip.example.com>;auth_pass=password2
```

### 2. Configure Contacts

Edit `baresip/config/contacts` with contacts for presence monitoring and auto-connect:

```
"Contact 1" <sip:contact1@sip.example.com>
"Contact 2" <sip:contact2@sip.example.com>
```

### 3. Build and Start

Using pre-built images:
```bash
docker compose up -d
```

Building from source:
```bash
docker compose -f compose.build-from-source.yaml build
docker compose -f compose.build-from-source.yaml up -d
```

### 4. Access

- **Dashboard**: http://localhost:3000
- **Logs**: http://localhost:3000/baresip-logs
- **Health**: http://localhost:3000/api/health
- **Metrics**: http://localhost:3000/Metrics

## Features

### Dashboard
- Real-time status for all SIP accounts
- Registration status (Registered/Configured/Unregistered)
- Call status (Idle/Ringing/In Call) with error details
- Auto-connect contact assignment per account
- Call and Hangup buttons with dial modal
- Call statistics (codec, jitter, packet loss, bitrate) via info button
- Audio level meters (PPM) per active call 
- Connection line visualization for active calls
- Prometheus Metrics 

### Live Log Viewer
- Combined log stream from container stdout and TCP socket events
- Hierarchical log level filter (Debug shows all, Warnings shows warn+error, etc.)
- Source filter (Baresip container / TCP Socket / System)
- Account filter (search by SIP account number)
- Free-text search across all log fields
- Auto-scroll with manual scroll pause
- Log history on page load (last 1000 entries, deduplicated and sorted)

### Auto-Connect
- Assign a contact to any registered SIP account
- Monitors presence status of assigned contact
- Automatically dials when contact comes online (presence: open/busy)
- Shows contact name and presence state when idle
- Reconnects automatically on call failure

### Call History
- Automatic logging of incoming calls
- Stored persistently in `baresip/config/call-history.json`

## Logging Architecture

Logs come from two independent sources, unified into a single format:

| Source | Origin | Live Broadcast |
|--------|--------|----------------|
| **Container logs** | baresip stdout/stderr → `tee` → `/shared-logs/baresip.log` → `tail -F` | Yes, via stateManager |
| **TCP socket events** | baresip TCP:4444 → parser → stateManager | Yes, via stateManager |

All logs share a unified `LogEntry` format:
```typescript
interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;      // 'baresip', 'tcp-socket', 'system', or module name
  message: string;
  accountUri?: string;
  data?: any;
}
```

### Log Rotation
- Log file: `/shared-logs/baresip.log`
- Maximum size: 100 MB per file
- Maximum files: 5 (baresip.log, baresip.log.1 through baresip.log.5)
- Check interval: every 5 minutes
- `tail -F` follows file renames automatically



## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (TCP connection status, account count) |
| GET | `/api/accounts` | List all SIP accounts with status |
| GET | `/api/contacts` | List all contacts with presence |
| GET | `/api/baresip-logs` | Container logs (query: `limit`, `level`, `accountUri`) |
| GET | `/api/logs` | State manager logs |
| GET | `/api/call-history` | Call history entries |
| POST | `/api/command` | Send command to baresip (`{ command, params }`) |
| POST | `/api/autoconnect/assign` | Assign auto-connect contact (`{ account, contact }`) |
| POST | `/api/logs/clear` | Clear all logs |

## Socket.IO Events

### Client → Server
| Event | Description |
|-------|-------------|
| `subscribeLogs` | Join the logs room (receive live log updates + history) |
| `unsubscribeLogs` | Leave the logs room |

### Server → Client
| Event | Description |
|-------|-------------|
| `init` | Initial state (accounts, contacts, calls, audio meters) |
| `accountUpdate` | Single account status change |
| `accountsUpdate` | All accounts update |
| `contactsUpdate` | All contacts with presence |
| `callAdded` / `callUpdated` / `callRemoved` | Call lifecycle |
| `audioMeter` | Audio level update (volatile) |
| `logHistory` | Historical logs on subscribe (up to 1000 entries) |
| `logBatch` | Live log batch (every 500ms) |
| `logsCleared` | Logs were cleared |
| `presence` | Single contact presence change |

## Docker Services

### app (baresip-ui)
- Nuxt 3 application with server-side Nitro API
- Connects to baresip via TCP netstring protocol
- Socket.IO server for real-time browser updates
- Reads container logs from shared volume (read-only)
- Log rotation management
- Auto-reconnect with exponential backoff

### baresip
- SIP softphone with TCP control interface
- Entrypoint wrapped with `tee` to pipe stdout/stderr to shared volume
- `init: true` for proper signal handling (tini as PID 1)
- Multiple SIP account support
- Presence monitoring via SUBSCRIBE/NOTIFY

## Development

### Build from Source

```bash
docker compose -f compose.build-from-source.yaml build --no-cache
docker compose -f compose.build-from-source.yaml up -d
```

### View Logs

```bash
# App logs
docker logs -f baresip-ui

# Baresip container logs
docker logs -f baresip

# Baresip log file (shared volume)
docker exec baresip-ui cat /shared-logs/baresip.log | tail -100
```

### Stop / Restart

```bash
docker compose -f compose.build-from-source.yaml down
docker compose -f compose.build-from-source.yaml up -d
```

### Rebuild App Only

```bash
docker compose -f compose.build-from-source.yaml build --no-cache app
docker compose -f compose.build-from-source.yaml up -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BARESIP_HOST` | `baresip` | Hostname of baresip container |
| `BARESIP_PORT` | `4444` | TCP control port |
| `BARESIP_LOG_FILE` | `/shared-logs/baresip.log` | Path to shared log file |
| `DEBUG_TCP_BUS` | `false` | Enable raw TCP data logging |

## Troubleshooting

### Baresip not registering
- Check SIP credentials in `baresip/config/accounts`
- Check firewall rules for SIP port (5060/UDP)
- View logs: `docker logs baresip` or use the Log Viewer page

### App not connecting to Baresip
- Ensure baresip container is running: `docker ps`
- Check health: `curl http://localhost:3000/api/health`
- Check app logs: `docker logs baresip-ui`

### No live logs in browser
- Open the Baresip Logs page (subscribes to log room automatically)
- Check browser console for Socket.IO connection errors
- Verify shared log file exists: `docker exec baresip ls -la /shared-logs/`

### Log file not created
- Ensure the `shared-logs` volume is mounted in both containers
- Check baresip entrypoint: `docker exec baresip ps aux` (should show `tee` process)
