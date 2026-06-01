# Prometheus Metrics Extension

## Overview

Exposes a `/metrics` endpoint (port 3000, same as the app) for Prometheus scraping. No additional ports or Docker changes required.

The `prom-client` package (`^15.1.3`) was already present in `package.json`.

---

## Endpoint

```
GET http://<host>:3000/metrics
```

Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: baresipui
    static_configs:
      - targets: ['baresipui:3000']
    metrics_path: /metrics
```

---

## Metrics

### Gauges — read from state on each scrape

| Metric | Labels | Description |
|---|---|---|
| `baresip_account_registered` | `account` | 1 = registered, 0 = not |
| `baresip_active_calls_count` | — | Number of currently active calls |
| `baresip_rtcp_jitter_rx_ms` | `call_id`, `account` | Receive jitter (ms) |
| `baresip_rtcp_jitter_tx_ms` | `call_id`, `account` | Transmit jitter (ms) |
| `baresip_rtcp_rtt_ms` | `call_id`, `account` | Round-trip time (ms) |
| `baresip_rtcp_lost_rx_packets` | `call_id`, `account` | Cumulative RX packets lost |
| `baresip_rtcp_lost_tx_packets` | `call_id`, `account` | Cumulative TX packets lost |
| `baresip_rtcp_rx_bitrate_kbps` | `call_id`, `account` | Receive bitrate (kbps) |
| `baresip_rtcp_tx_bitrate_kbps` | `call_id`, `account` | Transmit bitrate (kbps) |
| `baresip_rtcp_jbuf_delay_ms` | `call_id`, `account` | Jitter buffer delay (ms) |

RTCP gauges are updated every 3 seconds via the existing `getrtcpstats` polling loop and stored in the `CallInfo` objects in `StateManager`.

### Counters — incremented on events

| Metric | Labels | Description |
|---|---|---|
| `baresip_registration_changes_total` | `account`, `result` (`ok`/`fail`) | SIP registration events |
| `baresip_calls_total` | `account`, `direction` (`incoming`/`outgoing`) | Calls started |

### Histogram — observed on call end

| Metric | Labels | Buckets |
|---|---|---|
| `baresip_call_duration_seconds` | `account`, `direction` | 1min, 5min, 30min, 1h, 4h, 12h, 1d, 3d, 1w |

Duration is measured from call creation (`startTime`) to `CALL_CLOSED` event. Buckets extend to 1 week to support long-running calls.

---

## Files

| File | Role |
|---|---|
| `server/services/prometheus.ts` | Custom registry + all metric definitions + recorder functions |
| `server/api/metrics.get.ts` | Nitro route handler — returns `registry.metrics()` |
| `server/services/baresip-parser.ts` | Hooks: `recordRegistrationEvent`, `recordCallStarted`, `recordCallEnded` |

### Hook points in `baresip-parser.ts`

| Event | Function called |
|---|---|
| `REGISTER_OK` | `recordRegistrationEvent(uri, 'ok')` |
| `REGISTER_FAIL` | `recordRegistrationEvent(uri, 'fail')` |
| `CALL_INCOMING` / `CALL_OUTGOING` / `CALL_ESTABLISHED` (new call) | `recordCallStarted(uri, direction)` |
| `CALL_CLOSED` / `CALL_END` / `CALL_TERMINATE` | `recordCallEnded(uri, direction, durationMs)` |
