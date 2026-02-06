# Baresip Control Dashboard - Docker Setup

Complete Docker-based project for monitoring and controlling Baresip SIP accounts with auto-connect functionality.

## Architecture

- **Frontend**: Nuxt 3 + TypeScript + Tailwind CSS (Port 3000)
- **Backend**: Node.js + Express + WebSocket + Prometheus (Port 4000)
- **Baresip**: SIP softphone with TCP control interface (Port 4444)
- **Prometheus**: Metrics collection (Port 9090)

## Quick Start

### 1. Configure SIP Accounts

Edit `baresip-config/accounts` with your SIP credentials:

```
<sip:user1@sip.example.com>;auth_pass=password1
<sip:user2@sip.example.com>;auth_pass=password2
```

### 2. Configure Auto-Connect Contacts

Edit `baresip-config/contacts` with contacts to auto-connect:

```
"Contact 1" <sip:contact1@sip.example.com>
"Contact 2" <sip:contact2@sip.example.com>
```

### 3. Build and Start

```bash
docker-compose build
docker-compose up -d
```

### 4. Access

- **Dashboard**: http://localhost:3000
- **Logs**: http://localhost:3000/baresip-logs
- **API**: http://localhost:4000
- **Metrics**: http://localhost:4000/metrics
- **Prometheus**: http://localhost:9090

## Features

### Dashboard
- Real-time status for all SIP accounts
- Registration status (Registered/Unregistered)
- Call status (Idle/Ringing/In Call)
- Auto-connect status per contact
- Control buttons (Register, Call, Hangup)

### Live Log Stream
- All Baresip events in real-time
- Auto-scroll functionality
- Keyword highlighting (CALL, REGISTER, ERROR, etc.)
- Timestamp for each event

### Auto-Connect
- Monitors presence status of configured contacts
- Automatically dials when contact comes online
- Toggle on/off per contact via UI
- Status tracking (Connecting/Connected/Failed)

### Prometheus Metrics

Available at `http://localhost:4000/metrics`:

- `baresip_account_registered{account="<uri>"}` - Account registration status
- `baresip_call_active{account="<uri>"}` - Active call indicator
- `baresip_tcp_connected` - TCP connection to Baresip status
- `baresip_events_total{type="<type>"}` - Total events by type
- `baresip_last_event_timestamp_seconds` - Last event timestamp
- `baresip_autoconnect_attempts_total{contact="<uri>"}` - Auto-connect attempts
- `baresip_autoconnect_success_total{contact="<uri>"}` - Successful auto-connects
- `baresip_autoconnect_failures_total{contact="<uri>"}` - Failed auto-connects
- `baresip_contact_online{contact="<uri>"}` - Contact online status

## API Endpoints

### GET /health
Health check and connection status

### GET /metrics
Prometheus metrics

### GET /accounts
List all SIP accounts with status

### GET /contacts
List all contacts with auto-connect status

### POST /command
Send command to Baresip
```json
{
  "command": "/uareginfo"
}
```

### POST /autoconnect/:contact
Toggle auto-connect for a contact
```json
{
  "enabled": true
}
```

## Docker Services

### backend
- Connects to Baresip via TCP
- Parses events and maintains state
- WebSocket server for real-time updates
- Prometheus metrics exporter
- Auto-reconnect with exponential backoff

### frontend
- Nuxt 3 application
- WebSocket client for real-time updates
- Dashboard and log viewer

### baresip
- SIP softphone
- TCP control interface on port 4444
- Handles multiple SIP accounts

### prometheus
- Scrapes metrics from backend every 15s
- Web UI on port 9090

## Development

### Local Development

Backend:
```bash
cd backend
npm install
npm run dev
```

Frontend:
```bash
npm install
npm run dev
```

### Logs

View logs:
```bash
docker-compose logs -f
docker-compose logs -f backend
docker-compose logs -f frontend
docker-compose logs -f baresip
```

### Stop Services

```bash
docker-compose down
```

### Rebuild

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Troubleshooting

### Baresip not connecting
- Check SIP credentials in `baresip-config/accounts`
- Check firewall rules for SIP ports (5060)
- View Baresip logs: `docker-compose logs baresip`

### Backend not connecting to Baresip
- Ensure Baresip container is running
- Check backend logs: `docker-compose logs backend`
- Verify TCP interface: `docker-compose exec baresip netstat -tln | grep 4444`

### Frontend not receiving updates
- Check WebSocket connection in browser console
- Verify backend is running: `curl http://localhost:4000/health`
- Check network tab for WebSocket errors

## Configuration

### Environment Variables

Frontend (`.env`):
```
NUXT_PUBLIC_WS_URL=ws://localhost:4000
NUXT_PUBLIC_API_URL=http://localhost:4000
```

Backend (docker-compose.yml):
```
BARESIP_HOST=baresip
BARESIP_PORT=4444
WS_PORT=4000
```

### Baresip Configuration

Edit `baresip-config/config` for Baresip settings:
- Audio devices
- Network settings
- Modules
- SIP settings
