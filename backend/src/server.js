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

function parseNetstring(data) {
  const messages = [];
  let buffer = data.toString();
  
  while (buffer.length > 0) {
    const colonIndex = buffer.indexOf(':');
    if (colonIndex === -1) break;
    
    const lengthStr = buffer.substring(0, colonIndex);
    const length = parseInt(lengthStr, 10);
    if (isNaN(length)) break;
    
    const startIndex = colonIndex + 1;
    const endIndex = startIndex + length;
    
    if (buffer.length < endIndex + 1 || buffer[endIndex] !== ',') break;
    
    const message = buffer.substring(startIndex, endIndex);
    messages.push(message);
    
    buffer = buffer.substring(endIndex + 1);
  }
  
  return messages;
}

function parseBaresipEvent(data) {
  const dataStr = data.toString();
  
  // Versuche zuerst Netstring-Format zu parsen
  try {
    const netstringMessages = parseNetstring(dataStr);
    if (netstringMessages.length > 0) {
      console.log('Parsed netstring messages:', netstringMessages);
      
      for (const messageStr of netstringMessages) {
        try {
          const jsonMessage = JSON.parse(messageStr);
          
          if (jsonMessage.response) {
            // Command Response
            handleCommandResponse(jsonMessage);
          } else if (jsonMessage.event) {
            // Event Message
            handleJsonEvent(jsonMessage);
          } else {
            console.log('Unknown JSON message:', jsonMessage);
          }
        } catch (e) {
          // Falls JSON-Parsing fehlschlägt, behandle als normale Textzeile
          handleTextLine(messageStr);
        }
      }
      return;
    }
  } catch (e) {
    // Falls Netstring-Parsing fehlschlägt, behandle als normale Textzeilen
  }
  
  // Fallback: Behandle als normale Textzeilen
  const lines = dataStr.split('\n').filter(line => line.trim());
  for (const line of lines) {
    handleTextLine(line);
  }
}

function handleCommandResponse(response) {
  const timestamp = Date.now();
  
  // Debug-Log für Command Responses
  console.log(`Command Response: ${JSON.stringify(response)}`);
  
  broadcast({
    type: 'log',
    timestamp,
    message: `Command Response: ${JSON.stringify(response)}`
  });

  // Hier könnten wir spezifische Response-Behandlungen hinzufügen
  if (response.ok) {
    console.log(`Command executed successfully: ${response.data}`);
  } else {
    console.error(`Command failed: ${response.data}`);
  }
}

function handleJsonEvent(jsonEvent) {
  const timestamp = Date.now();
  metricsLastEventTimestamp.set(timestamp / 1000);

  // Debug-Log für alle JSON-Events
  console.log(`JSON Event: ${JSON.stringify(jsonEvent)}`);

  broadcast({
    type: 'log',
    timestamp,
    message: JSON.stringify(jsonEvent)
  });

  if (jsonEvent.event && jsonEvent.class === 'ua') {
    if (jsonEvent.type === 'REGISTER_OK') {
      const uri = jsonEvent.accountaor;
      updateAccountStatus(uri, { 
        registered: true,
        registrationError: null
      });
      metricsEventsTotal.inc({ type: 'register' });
      metricsAccountRegistered.set({ account: uri }, 1);
    }
    else if (jsonEvent.type === 'REGISTER_FAIL') {
      const uri = jsonEvent.accountaor;
      let errorStatus = 'Registration Error';
      if (jsonEvent.param) {
        if (jsonEvent.param.includes('401')) errorStatus = 'Unauthorized';
        else if (jsonEvent.param.includes('403')) errorStatus = 'Forbidden';
        else if (jsonEvent.param.includes('404')) errorStatus = 'Not Found';
        else if (jsonEvent.param.includes('408')) errorStatus = 'Timeout';
        else if (jsonEvent.param.includes('503')) errorStatus = 'Service Unavailable';
      }
      updateAccountStatus(uri, { 
        registered: false, 
        registrationError: errorStatus,
        lastRegistrationAttempt: timestamp
      });
      metricsAccountRegistered.set({ account: uri }, 0);
    }
    else if (jsonEvent.type === 'UNREGISTERING') {
      const uri = jsonEvent.accountaor;
      updateAccountStatus(uri, { registered: false });
      metricsAccountRegistered.set({ account: uri }, 0);
    }
    else if (jsonEvent.type === 'UA_EVENT' && jsonEvent.event_name === 'account') {
      // Antwort auf /ualist - Liste aller konfigurierten Accounts
      const uri = jsonEvent.accountaor;
      if (uri && !accounts.has(uri)) {
        const accountData = {
          uri,
          registered: false,
          callStatus: 'Idle',
          autoConnectStatus: 'Off',
          lastEvent: timestamp,
          configured: true
        };
        accounts.set(uri, accountData);
        console.log(`Loaded configured account from API: ${uri}`);
        
        // Broadcast das neue Account
        broadcast({
          type: 'accountStatus',
          data: accountData
        });
      }
    }
  }
  
  // Call Events können unter verschiedenen Klassen kommen
  if (jsonEvent.event && (jsonEvent.class === 'call' || jsonEvent.class === 'ua')) {
    if (jsonEvent.type === 'CALL_ESTABLISHED' || jsonEvent.type === 'CALL_CONNECT') {
      const uri = jsonEvent.accountaor || jsonEvent.local_uri || jsonEvent.peer_uri;
      if (uri) {
        updateAccountStatus(uri, { callStatus: 'In Call' });
        metricsEventsTotal.inc({ type: 'call' });
        metricsCallActive.set({ account: uri }, 1);
        console.log(`Call established for ${uri}`);
      }
    }
    else if (jsonEvent.type === 'CALL_RINGING' || jsonEvent.type === 'CALL_INCOMING' || jsonEvent.type === 'CALL_OUTGOING') {
      const uri = jsonEvent.accountaor || jsonEvent.local_uri || jsonEvent.peer_uri;
      if (uri) {
        updateAccountStatus(uri, { callStatus: 'Ringing' });
        metricsEventsTotal.inc({ type: 'ringing' });
        console.log(`Call ringing for ${uri}`);
      }
    }
    else if (jsonEvent.type === 'CALL_CLOSED' || jsonEvent.type === 'CALL_END' || jsonEvent.type === 'CALL_TERMINATE') {
      const uri = jsonEvent.accountaor || jsonEvent.local_uri || jsonEvent.peer_uri;
      if (uri) {
        updateAccountStatus(uri, { callStatus: 'Idle' });
        metricsCallActive.set({ account: uri }, 0);
        console.log(`Call closed for ${uri}`);
      }
    }
  }
}

function handleTextLine(line) {
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
    const match = line.match(/reg:\s*(sip:[^@]+@[^)]+)/);
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
        lastRegistrationAttempt: timestamp
      });
      metricsAccountRegistered.set({ account: uri }, 0);
      console.log(`Registration error for ${uri}: ${errorStatus}`);
    }
  }

  // Parse Account aus reg:-Zeilen (auch bei Fehlern)
  else if (line.includes('reg:') && line.includes('sip:')) {
    const match = line.match(/reg:\s*(sip:[^@\s]+@[^\s);]+)/);
    if (match) {
      const uri = match[1];
      if (!accounts.has(uri)) {
        const accountData = {
          uri,
          registered: false,
          callStatus: 'Idle',
          autoConnectStatus: 'Off',
          lastEvent: timestamp,
          configured: true
        };
        accounts.set(uri, accountData);
        console.log(`Found account in reg message: ${uri}`);
        
        // Broadcast das neue Account
        broadcast({
          type: 'accountStatus',
          data: accountData
        });
      }
    }
  }  else if (line.includes('Call established')) {
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

  // Parse Account-Liste aus /ualist Response oder anderen Account-Referenzen
  else if (line.includes('sip:') && line.includes('@') && !line.includes('presence:') && !line.includes('reg:')) {
    const match = line.match(/(sip:[^@\s]+@[^\s>;,)]+)/);
    if (match) {
      const uri = match[1];
      if (!accounts.has(uri)) {
        const accountData = {
          uri,
          registered: false,
          callStatus: 'Idle',
          autoConnectStatus: 'Off',
          lastEvent: timestamp,
          configured: true
        };
        accounts.set(uri, accountData);
        console.log(`Loaded configured account from text: ${uri}`);
        
        // Broadcast das neue Account
        broadcast({
          type: 'accountStatus',
          data: accountData
        });
      }
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

  sendBaresipCommand('dial', contact);

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
  // Da die API-Befehle keine brauchbaren Antworten liefern, lade direkt aus der Konfiguration
  console.log('Loading accounts from configuration file...');
  
  // Direkt laden ohne API-Versuche (da sie nur Fehler verursachen)
  setTimeout(() => {
    console.log(`Current accounts count before config load: ${accounts.size}, contacts: ${autoConnectConfig.size}`);
    loadAccountsFromConfig();
  }, 500); // Verkürze, da wir keine API-Befehle mehr senden
}

function loadAccountsFromConfig() {
  console.log('Fallback: Loading accounts from configuration files...');
  
  // Lade Accounts aus der accounts-Datei
  const accountsPath = process.env.ACCOUNTS_PATH || '/config/accounts';
  console.log(`Looking for accounts file at: ${accountsPath}`);
  
  try {
    if (fs.existsSync(accountsPath)) {
      console.log(`Found accounts file: ${accountsPath}`);
      const content = fs.readFileSync(accountsPath, 'utf8');
      const lines = content.split('\n').filter(line => 
        line.trim() && !line.startsWith('#')
      );

      for (const line of lines) {
        const match = line.match(/^<([^>]+)>/);
        if (match) {
          const uri = match[1];
          
          if (!accounts.has(uri)) {
            // Account existiert noch nicht - erstelle neu
            const accountData = {
              uri,
              registered: false,
              callStatus: 'Idle',
              autoConnectStatus: 'Off',
              lastEvent: Date.now(),
              configured: true
            };
            
            accounts.set(uri, accountData);
            console.log(`Loaded new configured account from file: ${uri}`);
            
            // Broadcast das neue Account
            broadcast({
              type: 'accountStatus',
              data: accountData
            });
          } else {
            // Account existiert bereits - markiere als konfiguriert
            const existing = accounts.get(uri);
            existing.configured = true;
            accounts.set(uri, existing);
            console.log(`Marked existing account as configured: ${uri}`);
            
            // Broadcast das aktualisierte Account
            broadcast({
              type: 'accountStatus',
              data: existing
            });
          }
        }
      }
      
      console.log(`Loaded ${accounts.size} accounts from configuration file`);
    } else {
      console.log('No accounts configuration file found at:', accountsPath);
    }
  } catch (error) {
    console.error('Error loading configured accounts from file:', error);
  }

  // Lade auch Kontakte aus der contacts-Datei
  loadContactsFromConfig();
}

function loadContactsFromConfig() {
  const contactsPath = process.env.CONTACTS_PATH || '/config/contacts';
  console.log(`Looking for contacts file at: ${contactsPath}`);
  
  try {
    if (fs.existsSync(contactsPath)) {
      console.log(`Found contacts file: ${contactsPath}`);
      const content = fs.readFileSync(contactsPath, 'utf8');
      const lines = content.split('\n').filter(line => 
        line.trim() && !line.startsWith('#')
      );

      for (const line of lines) {
        const match = line.match(/^"([^"]+)"\s*<sip:([^@]+@[^>]+)>/);
        if (match) {
          const [, name, contact] = match;
          
          if (!autoConnectConfig.has(contact)) {
            const contactConfig = {
              enabled: false,
              status: 'Off'
            };
            
            autoConnectConfig.set(contact, contactConfig);
            console.log(`Loaded contact from file: ${name} <${contact}>`);
          }
        }
      }
      
      console.log(`Loaded ${autoConnectConfig.size} contacts from configuration file`);
      
      // Broadcast die Kontakte an alle Clients
      broadcast({
        type: 'contactsUpdate',
        contacts: Array.from(autoConnectConfig.entries()).map(([contact, config]) => ({
          contact,
          enabled: config.enabled,
          status: config.status || 'Off',
          presence: contactPresence.get(contact) || 'unknown'
        }))
      });
    } else {
      console.log('No contacts configuration file found at:', contactsPath);
    }
  } catch (error) {
    console.error('Error loading contacts from file:', error);
  }
}

function createNetstring(data) {
  const netstring = `${data.length}:${data},`;
  console.log(`Creating netstring: "${data}" -> "${netstring}"`);
  return netstring;
}

function sendBaresipCommand(command, params = null, token = null) {
  if (baresipClient && !baresipClient.destroyed) {
    // Erstelle JSON-Nachricht für Baresip
    const jsonMessage = {
      command: command,
      ...(params && { params: params }),
      ...(token && { token: token })
    };
    
    const jsonString = JSON.stringify(jsonMessage);
    const netstring = createNetstring(jsonString);
    
    baresipClient.write(netstring);
    console.log(`Sent JSON command: ${jsonString} (as netstring: ${netstring})`);
  } else {
    console.log(`Cannot send command - client not connected: ${command}`);
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

    // Lade alle Accounts über die API
    loadConfiguredAccounts();
    
    // Lade Kontakte direkt (da sie nicht über API verfügbar sind)
    setTimeout(() => {
      loadContactsFromConfig();
    }, 500);
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
  const { command, params, token } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }

  console.log(`Received command from frontend: ${command}${params ? ' with params: ' + params : ''}`);
  
  // Unterscheide zwischen alten Text-Befehlen und neuen strukturierten Befehlen
  if (command.startsWith('/') || (!params && typeof command === 'string' && command.includes(' '))) {
    // Alter Stil: Parse Text-Befehl zu JSON-Format
    const [cmd, ...paramsParts] = command.replace('/', '').split(' ');
    const parsedParams = paramsParts.join(' ');
    sendBaresipCommand(cmd, parsedParams, token);
  } else {
    // Neuer Stil: Direkter JSON-Befehl
    sendBaresipCommand(command, params, token);
  }
  
  res.json({ success: true, command: command, params: params, timestamp: Date.now() });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
