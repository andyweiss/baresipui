import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { register, Counter, Gauge } from 'prom-client';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const BARESIP_HOST = process.env.BARESIP_HOST || 'baresip';
const BARESIP_PORT = process.env.BARESIP_PORT || 4444;
const PORT = process.env.WS_PORT || 4000;

let baresipClient = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;

const accounts = new Map();
const autoConnectConfig = new Map();
const contactPresence = new Map();
const wsClients = new Set();

const metricsAccountRegistered = new Gauge({
  name: 'baresip_account_registered',
  help: 'Account registration status',
  labelNames: ['account']
});

const metricsCallActive = new Gauge({
  name: 'baresip_call_active',
  help: 'Active call status',
  labelNames: ['account']
});

const metricsTcpConnected = new Gauge({
  name: 'baresip_tcp_connected',
  help: 'TCP connection status to Baresip'
});

const metricsEventsTotal = new Counter({
  name: 'baresip_events_total',
  help: 'Total number of events',
  labelNames: ['type']
});

const metricsLastEventTimestamp = new Gauge({
  name: 'baresip_last_event_timestamp_seconds',
  help: 'Timestamp of last event'
});

const metricsAutoConnectAttempts = new Counter({
  name: 'baresip_autoconnect_attempts_total',
  help: 'Total auto-connect attempts',
  labelNames: ['contact']
});

const metricsAutoConnectSuccess = new Counter({
  name: 'baresip_autoconnect_success_total',
  help: 'Successful auto-connects',
  labelNames: ['contact']
});

const metricsAutoConnectFailures = new Counter({
  name: 'baresip_autoconnect_failures_total',
  help: 'Failed auto-connects',
  labelNames: ['contact']
});

const metricsContactOnline = new Gauge({
  name: 'baresip_contact_online',
  help: 'Contact online status',
  labelNames: ['contact']
});

function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function parseBaresipEvent(data) {
  const lines = data.toString().split('\n').filter(line => line.trim());

  for (const line of lines) {
    const timestamp = Date.now();
    metricsLastEventTimestamp.set(timestamp / 1000);

    broadcast({
      type: 'log',
      timestamp,
      message: line
    });

    if (line.includes('registered successfully')) {
      const match = line.match(/<([^>]+)>/);
      if (match) {
        const uri = match[1];
        updateAccountStatus(uri, { 
          registered: true,
          registrationError: null // Lösche vorherige Fehler bei erfolgreicher Registrierung
        });
        metricsEventsTotal.inc({ type: 'register' });
        metricsAccountRegistered.set({ account: uri }, 1);
      }
    }

    else if (line.includes('unregistering')) {
      const match = line.match(/<([^>]+)>/);
      if (match) {
        const uri = match[1];
        updateAccountStatus(uri, { registered: false });
        metricsAccountRegistered.set({ account: uri }, 0);
      }
    }

    else if (line.includes('reg:') && (line.includes('401 Unauthorized') || line.includes('403 Forbidden') || line.includes('404 Not Found') || line.includes('408 Request Timeout') || line.includes('503 Service Unavailable'))) {
      const match = line.match(/reg:\s*([^)]+@[^)]+)/);
      if (match) {
        const uri = match[1];
        // Extrahiere nur die Fehlermeldung ohne Code
        let errorStatus = 'Registration Error';
        if (line.includes('401 Unauthorized')) errorStatus = 'Unauthorized';
        else if (line.includes('403 Forbidden')) errorStatus = 'Forbidden';
        else if (line.includes('404 Not Found')) errorStatus = 'Not Found';
        else if (line.includes('408 Request Timeout')) errorStatus = 'Timeout';
        else if (line.includes('503 Service Unavailable')) errorStatus = 'Service Unavailable';
        
        updateAccountStatus(uri, { 
          registered: false, 
          registrationError: errorStatus,
          lastRegistrationAttempt: Date.now()
        });
        metricsAccountRegistered.set({ account: uri }, 0);
      }
    }

    else if (line.includes('Call established')) {
      const match = line.match(/<([^>]+)>/);
      if (match) {
        const uri = match[1];
        updateAccountStatus(uri, { callStatus: 'In Call' });
        metricsEventsTotal.inc({ type: 'call' });
        metricsCallActive.set({ account: uri }, 1);
      }
    }

    else if (line.includes('Call ringing')) {
      const match = line.match(/<([^>]+)>/);
      if (match) {
        const uri = match[1];
        updateAccountStatus(uri, { callStatus: 'Ringing' });
        metricsEventsTotal.inc({ type: 'ringing' });
      }
    }

    else if (line.includes('Call terminated') || line.includes('session closed')) {
      const match = line.match(/<([^>]+)>/);
      if (match) {
        const uri = match[1];
        updateAccountStatus(uri, { callStatus: 'Idle' });
        metricsCallActive.set({ account: uri }, 0);
      }
    }

    else if (line.includes('presence:') && line.includes('open')) {
      const match = line.match(/sip:([^@]+@[^\s]+)/);
      if (match) {
        const contact = match[1];
        contactPresence.set(contact, 'online');
        metricsContactOnline.set({ contact }, 1);

        broadcast({
          type: 'presence',
          timestamp,
          contact,
          status: 'online'
        });

        if (autoConnectConfig.get(contact)?.enabled) {
          attemptAutoConnect(contact);
        }
      }
    }

    else if (line.includes('presence:') && (line.includes('closed') || line.includes('offline'))) {
      const match = line.match(/sip:([^@]+@[^\s]+)/);
      if (match) {
        const contact = match[1];
        contactPresence.set(contact, 'offline');
        metricsContactOnline.set({ contact }, 0);

        broadcast({
          type: 'presence',
          timestamp,
          contact,
          status: 'offline'
        });
      }
    }

    else if (line.toLowerCase().includes('error')) {
      metricsEventsTotal.inc({ type: 'error' });
    }
  }
}

function updateAccountStatus(uri, updates) {
  const current = accounts.get(uri) || {
    uri,
    registered: false,
    callStatus: 'Idle',
    autoConnectStatus: 'Off',
    lastEvent: Date.now(),
    configured: false
  };

  const updated = { ...current, ...updates, lastEvent: Date.now() };
  accounts.set(uri, updated);

  broadcast({
    type: 'accountStatus',
    data: updated
  });
}

function attemptAutoConnect(contact) {
  const config = autoConnectConfig.get(contact);
  if (!config || !config.enabled) return;

  updateAutoConnectStatus(contact, 'Connecting');
  metricsAutoConnectAttempts.inc({ contact });

  sendBaresipCommand(`/dial ${contact}`);

  setTimeout(() => {
    const account = Array.from(accounts.values()).find(a =>
      a.callStatus === 'In Call' || a.callStatus === 'Ringing'
    );

    if (account) {
      updateAutoConnectStatus(contact, 'Connected');
      metricsAutoConnectSuccess.inc({ contact });
    } else {
      updateAutoConnectStatus(contact, 'Failed');
      metricsAutoConnectFailures.inc({ contact });
    }
  }, 5000);
}

function updateAutoConnectStatus(contact, status) {
  const config = autoConnectConfig.get(contact) || { enabled: false };
  config.status = status;
  autoConnectConfig.set(contact, config);

  broadcast({
    type: 'autoConnectStatus',
    contact,
    status
  });
}

function loadConfiguredAccounts() {
  const accountsPath = '/opt/stacks/baresipui/baresip/config/accounts';
  
  try {
    if (fs.existsSync(accountsPath)) {
      const content = fs.readFileSync(accountsPath, 'utf8');
      const lines = content.split('\n').filter(line => 
        line.trim() && !line.startsWith('#')
      );

      for (const line of lines) {
        const match = line.match(/^<([^>]+)>/);
        if (match) {
          const uri = match[1];
          
          // Nur hinzufügen, wenn der Account noch nicht existiert
          if (!accounts.has(uri)) {
            const accountData = {
              uri,
              registered: false,
              callStatus: 'Idle',
              autoConnectStatus: 'Off',
              lastEvent: Date.now(),
              configured: true // Markierung als konfigurierter Account
            };
            
            accounts.set(uri, accountData);
            console.log(`Loaded configured account: ${uri}`);
          }
        }
      }
      
      console.log(`Loaded ${accounts.size} accounts from configuration`);
    } else {
      console.log('No accounts configuration file found');
    }
  } catch (error) {
    console.error('Error loading configured accounts:', error);
  }
}

function sendBaresipCommand(command) {
  if (baresipClient && !baresipClient.destroyed) {
    baresipClient.write(command + '\n');
    console.log(`Sent command: ${command}`);
  }
}

function connectToBaresip() {
  if (baresipClient) {
    baresipClient.destroy();
  }

  baresipClient = new net.Socket();

  baresipClient.connect(BARESIP_PORT, BARESIP_HOST, () => {
    console.log(`Connected to Baresip at ${BARESIP_HOST}:${BARESIP_PORT}`);
    reconnectAttempts = 0;
    metricsTcpConnected.set(1);

    sendBaresipCommand('/uareginfo');
    sendBaresipCommand('/listcalls');
  });

  baresipClient.on('data', (data) => {
    parseBaresipEvent(data);
  });

  baresipClient.on('error', (err) => {
    console.error('Baresip connection error:', err.message);
    metricsTcpConnected.set(0);
  });

  baresipClient.on('close', () => {
    console.log('Baresip connection closed');
    metricsTcpConnected.set(0);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnect attempts reached');
    return;
  }

  const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;

  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(connectToBaresip, delay);
}

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/health', (req, res) => {
  const isConnected = baresipClient && !baresipClient.destroyed;
  res.json({
    status: isConnected ? 'healthy' : 'unhealthy',
    tcpConnected: isConnected,
    accounts: accounts.size,
    timestamp: Date.now()
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/accounts', (req, res) => {
  res.json(Array.from(accounts.values()));
});

app.get('/contacts', (req, res) => {
  const contacts = Array.from(autoConnectConfig.entries()).map(([contact, config]) => ({
    contact,
    enabled: config.enabled,
    status: config.status || 'Off',
    presence: contactPresence.get(contact) || 'unknown'
  }));
  res.json(contacts);
});

app.post('/command', (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }

  sendBaresipCommand(command);
  res.json({ success: true });
});

app.post('/autoconnect/:contact', (req, res) => {
  const { contact } = req.params;
  const { enabled } = req.body;

  const config = autoConnectConfig.get(contact) || { status: 'Off' };
  config.enabled = enabled;
  autoConnectConfig.set(contact, config);

  if (!enabled) {
    updateAutoConnectStatus(contact, 'Off');
  }

  res.json({ success: true, contact, enabled });
});

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  wsClients.add(ws);

  ws.send(JSON.stringify({
    type: 'init',
    accounts: Array.from(accounts.values()),
    contacts: Array.from(autoConnectConfig.entries()).map(([contact, config]) => ({
      contact,
      enabled: config.enabled,
      status: config.status || 'Off',
      presence: contactPresence.get(contact) || 'unknown'
    }))
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    wsClients.delete(ws);
  });
});

connectToBaresip();

// Lade konfigurierte Accounts beim Start
loadConfiguredAccounts();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
