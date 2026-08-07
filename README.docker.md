# Baresip Control Dashboard - Docker Setup

Complete Docker-based project for monitoring and controlling Baresip SIP accounts with auto-connect functionality.

## Architecture

- **App**: Nuxt 3 + TypeScript + Tailwind CSS + Socket.IO (Port 3000)
- **Baresip**: SIP softphone with TCP control interface (Port 4444 inside the Docker network)
- **Communication**: TCP netstring protocol (App → Baresip), Socket.IO (App → Browser)
- **Logging**: Shared volume — baresip stdout/stderr piped via `tee` to a log file, read by the app with `tail -F`
- **Optional talktome bridge**: App-controlled mediasoup Plain-RTP bridge; disabled by default

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

## Optional talktome mediasoup bridge

Both custom baresip image builds always include `mediasoup_bridge.so`, but it
is absent from the static module configuration. The feature defaults to
`TALKTOME_BRIDGE_ENABLED=false`; on a false startup the app does zero bridge
configuration or network work and does not restore mapped accounts' previous
audio devices. When enabled, the app loads the module at runtime and applies
per-account mappings.

The compose files derive the browser-safe
`NUXT_PUBLIC_TALKTOME_BRIDGE_ENABLED` setting from the global flag and also
pass only that non-secret flag to `baresip` as a Compose recreation marker.
Baresip does not read the flag or load the module from it. After changing the
global flag, recreate both processes:

```bash
docker compose up -d --force-recreate app baresip
```

For the source-build file, add `-f compose.build-from-source.yaml`. Recreating
baresip removes any dynamically loaded module; with the false startup gate,
the restarted deployment is hard-off. If previous audio devices must be
restored, disable or remove each mapping while the bridge is still enabled
before turning the global flag off.

Both compose files publish the bridge receive range
`40000-40199:40000-40199/udp`. This baresip-side range is independent of the
talktome server's global mediasoup `RTC_PORT_RANGE`.

Account mappings are stored in `/config/talktome-bridge.json` on the existing
config volume and are gitignored. Keep Bridge API tokens in protected runtime
environment/secret storage, never in the JSON or repository.

See [talktome mediasoup bridge setup and operations](docs/mediasoup-bridge.md)
for provisioning, network/NAT planning, UI configuration, PTT/tally behavior,
failure isolation, and troubleshooting.

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
| `TALKTOME_BRIDGE_ENABLED` | `false` | Global talktome bridge gate; also passed without secrets to baresip as a Compose recreation marker |
| `NUXT_PUBLIC_TALKTOME_BRIDGE_ENABLED` | value of `TALKTOME_BRIDGE_ENABLED` | Browser-visible runtime gate; compose derives it from the server gate |
| `TALKTOME_BASE_URL` | empty | talktome base URL; required only when the bridge is enabled |
| `TALKTOME_BRIDGE_ID` | empty | Optional bridge registration id; when unset, a UUID is generated once and persisted next to the mapping config |
| `TALKTOME_BRIDGE_TOKEN` | empty | Protected bridge/API credential; required only when enabled |
| `TALKTOME_MEDIA_ANNOUNCE_IP` | empty | Reachable Docker-host media address; required only when enabled |
| `TALKTOME_BRIDGE_CONFIG_PATH` | `/config/talktome-bridge.json` | Persistent per-account mapping file |
| `TALKTOME_BRIDGE_NAME` | `baresipui` | Name announced for this bridge |
| `TALKTOME_BRIDGE_AUTH_MODE` | `bearer` | API authentication header mode: `bearer` or `api-key` |
| `TALKTOME_BRIDGE_AUTO_PROVISION` | `true` | Allow the matching bridge token to assign/update user endpoints on its own bridge |
| `TALKTOME_BRIDGE_COMMAND_TIMEOUT_MS` | `5000` | Baresip bridge-command timeout in milliseconds (`100`–`120000`) |
| `TALKTOME_DEFAULT_AUDIO_SOURCE` | empty | Safe source restored when no previous non-bridge device was recorded |
| `TALKTOME_DEFAULT_AUDIO_PLAYER` | empty | Safe player restored when no previous non-bridge device was recorded |
| `TALKTOME_TESTED_VERSION` | `1.1.3` | Highest talktome release this image/runtime was verified against; warns in the UI when the connected server reports a newer `appVersion`. Baked into the image at build time from the repo-root `TALKTOME_TESTED_VERSION` file and not listed in the shipped compose files; power users can override it by adding it back to a service's `environment:` |
| `TALKTOME_SERVER_VERSION` | empty | Optional known server version when health/announce do not expose `appVersion` yet |

The talktome connection settings and every secret are app-only startup
settings. Nuxt public runtime configuration uses the `NUXT_PUBLIC_*` name,
which is why compose supplies the second bridge-enabled variable explicitly.
Public runtime configuration is delivered to the browser; never put the token
or any other credential in a `NUXT_PUBLIC_*` variable. The sole talktome
variable passed to baresip is the non-secret global gate, and it is present
only so Compose notices gate changes and recreates that container; baresip
does not consume it. App environment changes are not hot-reloaded. For a
global gate change, run
`docker compose up -d --force-recreate app baresip` (with the applicable
compose-file option) so both startup state and the baresip process are fresh.

## Security

The dashboard and its HTTP, WebSocket, and configuration APIs do not provide
built-in user authentication. Port 3000 can issue baresip commands and mutate
configuration, so restrict it with host firewall rules or an authenticated
TLS reverse proxy. Plain bridge RTP is not encrypted; use a trusted network,
private interconnect, or VPN.

The unauthenticated baresip `ctrl_tcp` listener on port 4444 is reachable by
the app over the private Docker network but is not published on the host.
Other containers attached to that network can still reach it. Keep the bridge
token only in protected app runtime/secret storage; it is not required by the
baresip container and must never be made public.

## Troubleshooting

### Baresip not registering
- Check SIP credentials in `baresip/config/accounts`
- Check firewall rules for SIP port (5060/UDP)
- View logs: `docker logs baresip` or use the Log Viewer page

### App not connecting to Baresip
- Ensure baresip container is running: `docker ps`
- Check health: `curl http://localhost:3000/api/health`
- Check app logs: `docker logs baresip-ui`

For short-lived local `ctrl_tcp` troubleshooting, add a temporary override
that binds only to loopback:

```bash
cat >/tmp/baresip-ctrl-tcp-loopback.yaml <<'YAML'
services:
  baresip:
    ports:
      - "127.0.0.1:4444:4444/tcp"
YAML
docker compose -f compose.yaml -f /tmp/baresip-ctrl-tcp-loopback.yaml up -d baresip
```

Port 4444 has no authentication. Do not bind it to `0.0.0.0` or a non-loopback
address. Remove the override and recreate the service when troubleshooting is
complete.

### No live logs in browser
- Open the Baresip Logs page (subscribes to log room automatically)
- Check browser console for Socket.IO connection errors
- Verify shared log file exists: `docker exec baresip ls -la /shared-logs/`

### Log file not created
- Ensure the `shared-logs` volume is mounted in both containers
- Check baresip entrypoint: `docker exec baresip ps aux` (should show `tee` process)
