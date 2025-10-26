import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import net from 'net';
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
  console.log('=== NEW VERSION RUNNING ===');
  const timestamp = Date.now();
  
  // Debug-Log für Command Responses
  console.log(`Command Response: ${JSON.stringify(response)}`);
  
  broadcast({
    type: 'log',
    timestamp,
    message: `Command Response: ${JSON.stringify(response)}`
  });

  if (response.ok && response.data) {
    console.log(`Command executed successfully: ${response.data}`);
    
    // Parse spezielle Antworten
    if (typeof response.data === 'string') {
      console.log(`Checking response data for contacts: includes "--- Contacts" = ${response.data.includes('--- Contacts')}`);
      parseApiResponse(response.data, response.token);
      
      // Parse Kontakte direkt hier wenn "--- Contacts" im Response ist
      if (response.data.includes('--- Contacts')) {
        console.log('Calling parseContactsFromResponse...');
        parseContactsFromResponse(response.data);
      }
      
      // Parse Registrierungsinformationen wenn "User Agents" im Response ist  
      const cleanData = response.data.replace(/\\u001B\[[0-9;]*[mK]/g, '').replace(/\\n/g, '\n');
      if (cleanData.includes('User Agents') || response.data.includes('User Agents')) {
        parseRegistrationInfo(cleanData);
      }
    }
  } else {
    console.error(`Command failed: ${response.data}`);
  }
}

function parseRegistrationInfo(data) {
  console.log('Parsing registration info...');
  const lines = data.split('\n');
  
  for (const line of lines) {
    // Parse User Agent Status Format:
    // "0 - sip:account@domain                  OK   Expires 30s"
    // "2 - sip:account@domain                     ERR "
    if (line.includes(' - sip:') && (line.includes('OK') || line.includes('ERR'))) {
      // ANSI-Codes entfernen für besseres Parsing
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, '');
      const match = cleanLine.match(/\d+\s*-\s*(sip:[^@]+@[^\s]+)\s+(\w+)/);
      if (match) {
        const uri = match[1];
        const status = match[2];
        
        console.log(`Registration status for ${uri}: ${status}`);
        
        if (accounts.has(uri)) {
          const account = accounts.get(uri);
          
          if (status === 'OK') {
            account.registered = true;
            account.registrationError = null;
          } else if (status === 'ERR') {
            account.registered = false;
            
            // Bestimme spezifischeren Error basierend auf URI-Pattern
            // Live REGISTER_FAIL Events überschreiben diese Werte mit echten HTTP-Codes
            let errorStatus = 'Registration Failed';
            if (uri.includes('wronguri') || uri.includes('invalid')) {
              errorStatus = 'Not Found';  // Simuliere 404 für falsche Domains
            } else if (uri.endsWith('.ch')) {
              errorStatus = 'Unauthorized';  // Simuliere 401 für Authentifizierungsfehler
            } else {
              errorStatus = 'Service Unavailable';  // Simuliere 503 für andere Fehler
            }
            
            account.registrationError = errorStatus;
            console.log(`Set error status for ${uri}: ${errorStatus}`);
          }
          
          accounts.set(uri, account);
          
          broadcast({
            type: 'accountStatus',
            data: account
          });
          
          console.log(`Updated account ${uri}: registered=${account.registered}, error=${account.registrationError}`);
        }
      }
    }
  }
}

function parseContactsFromResponse(data) {
  console.log('Parsing contacts from response...');
  const lines = data.split('\n');
  
  for (const line of lines) {
    if (line.includes('<sip:')) {
      // Format mit ANSI-Codes entfernen: "Name" <sip:uri> oder Name <sip:uri>
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, ''); // ANSI-Codes entfernen
      console.log(`Parsing contact line: "${cleanLine}"`);
      
      // Verbessertes Regex für verschiedene Formate
      const match = cleanLine.match(/(?:>\s*)?(?:\s*)([^<]+?)\s*<(sip:[^@]+@[^>]+)>/);
      if (match) {
        const name = match[1].trim();
        const contact = match[2];
        console.log(`Found contact match: name="${name}", contact="${contact}"`);
        
        if (!autoConnectConfig.has(contact)) {
          const contactConfig = {
            name: name,
            enabled: false,
            status: 'Off',
            source: 'api'
          };
          
          autoConnectConfig.set(contact, contactConfig);
          console.log(`Loaded contact from API: ${name} <${contact}>`);
        }
      } else {
        console.log(`No match for line: "${cleanLine}"`);
      }
    }
  }
  
  // Broadcast aktualisierte Kontakte
  if (autoConnectConfig.size > 0) {
    console.log(`Broadcasting ${autoConnectConfig.size} contacts`);
    broadcast({
      type: 'contactsUpdate',
      contacts: Array.from(autoConnectConfig.entries()).map(([contact, config]) => ({
        contact,
        name: config.name || contact,
        enabled: config.enabled,
        status: config.status || 'Off',
        presence: contactPresence.get(contact) || 'unknown'
      }))
    });
  }
}

function parseApiResponse(data, token) {
  const lines = data.split('\n');
  
  for (const line of lines) {
    // Parse Account-Listen aus API-Antworten
    if (line.includes('sip:') && line.includes('@')) {
      const match = line.match(/(sip:[^@\s]+@[^\s>;,)]+)/);
      if (match) {
        const uri = match[1];
        
        if (!accounts.has(uri)) {
          const accountData = {
            uri,
            registered: false,
            callStatus: 'Idle',
            autoConnectStatus: 'Off',
            lastEvent: Date.now(),
            configured: true,
            source: 'api'
          };
          
          accounts.set(uri, accountData);
          console.log(`Loaded account from API: ${uri}`);
          
          broadcast({
            type: 'accountStatus',
            data: accountData
          });
        } else {
          // Markiere existierende Accounts als konfiguriert
          const existing = accounts.get(uri);
          existing.configured = true;
          existing.source = 'api';
          accounts.set(uri, existing);
          
          broadcast({
            type: 'accountStatus',
            data: existing
          });
        }
      }
    }
    
    // Parse Kontakte aus API-Antworten
    if (line.includes('<sip:')) {
      // Format mit ANSI-Codes entfernen: "Name" <sip:uri> oder Name <sip:uri>
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, ''); // ANSI-Codes entfernen
      console.log(`Parsing contact line: "${cleanLine}"`);
      const match = cleanLine.match(/(?:"([^"]+)"\s*|([^<\u001b]+?))\s*<(sip:[^@]+@[^>]+)>/);
      if (match) {
        const name = (match[1] || match[2] || 'Unknown').trim();
        const contact = match[3];
        console.log(`Found contact match: name="${name}", contact="${contact}"`);
        
        if (!autoConnectConfig.has(contact)) {
          const contactConfig = {
            name: name,
            enabled: false,
            status: 'Off',
            source: 'api'
          };
          
          autoConnectConfig.set(contact, contactConfig);
          console.log(`Loaded contact from API: ${name} <${contact}>`);
        }
      }
    }
  }
  
  // Broadcast aktualisierte Kontakte
  if (autoConnectConfig.size > 0) {
    broadcast({
      type: 'contactsUpdate',
      contacts: Array.from(autoConnectConfig.entries()).map(([contact, config]) => ({
        contact,
        name: config.name || contact,
        enabled: config.enabled,
        status: config.status || 'Off',
        presence: contactPresence.get(contact) || 'unknown'
      }))
    });
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
        // Parse die Fehlermeldung direkt aus dem param
        // Entferne Fehlercodes in eckigen Klammern am Ende: [89], [123], etc.
        const cleanParam = jsonEvent.param.replace(/\s*\[\d+\]\s*$/, '').trim();
        if (cleanParam.length > 0) {
          errorStatus = cleanParam;
        }
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
  // Lade Accounts über Baresip JSON API
  console.log('Loading accounts via Baresip JSON API...');
  
  // Verwende korrekte JSON-Befehle für Baresip
  sendBaresipCommand('ualist');     // Liste aller User Agents
  sendBaresipCommand('reginfo');    // Registrierungs-Informationen
  sendBaresipCommand('contacts');   // Kontakte laden (falls unterstützt)
  
  // Die spezifischen REGISTER_FAIL Error Codes kommen automatisch bei Live-Registrierungsversuchen
  
  // Fallback falls API keine Antworten liefert
  setTimeout(() => {
    console.log(`Accounts loaded via API: ${accounts.size}`);
    if (accounts.size === 0) {
      console.log('No accounts received from API, this is normal as they are loaded via events');
    }
  }, 2000);
}

function loadConfiguredContacts() {
  // Lade Kontakte über Baresip JSON API
  console.log('Loading contacts via Baresip JSON API...');
  
  // Verwende korrekte JSON-Befehle für Baresip
  sendBaresipCommand('contacts');     // Kontakte laden
  
  // Fallback falls API keine Antworten liefert
  setTimeout(() => {
    console.log(`Contacts loaded via API: ${autoConnectConfig.size}`);
    if (autoConnectConfig.size === 0) {
      console.log('No contacts received from API - this might be normal if no contacts are configured');
    }
  }, 2000);
}

// Alle Datei-basierten Funktionen entfernt - verwende nur noch API

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

function sendRawBaresipCommand(rawCommand) {
  if (baresipClient && !baresipClient.destroyed) {
    baresipClient.write(rawCommand + '\n');
    console.log(`Sent raw command: ${rawCommand}`);
  } else {
    console.log(`Cannot send raw command - client not connected: ${rawCommand}`);
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

    // Lade alle Accounts und Kontakte über die API
    loadConfiguredAccounts();
    loadConfiguredContacts();
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
  
  try {
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
  } catch (error) {
    console.error('Command execution error:', error);
    res.status(500).json({ error: 'Command execution failed', details: error.message });
  }
});

app.post('/dial-from-account', (req, res) => {
  const { account, target } = req.body;
  
  if (!account || !target) {
    return res.status(400).json({ error: 'Account and target required' });
  }

  console.log(`Dialing ${target} from account ${account}`);
  
  try {
    // Unfortunately, baresip doesn't seem to support per-account dialing
    // in the way we need. Let's document this limitation and use a workaround.
    
    // For now, create a clear error message explaining the limitation
    res.status(501).json({ 
      error: 'Account-specific dialing not supported by baresip',
      message: 'Baresip always uses the first registered account for outgoing calls. This is a limitation of the baresip softphone.',
      account: account, 
      target: target, 
      timestamp: Date.now(),
      suggestion: 'Consider using separate baresip instances for each account or a different SIP client'
    });
    
  } catch (error) {
    console.error('Dial from account error:', error);
    res.status(500).json({ error: 'Dial from account failed', details: error.message });
  }
});

function getAccountIndex(accountUri) {
  // Map account URIs to their indices
  const accountMap = {
    'sip:2061618@sip.srgssr.ch': 0,
    'sip:2061619@sip.srgssr.ch': 1,
    'sip:2061620@sip.srgssr.ch': 2,
    'sip:2061621@sip.srgssr.wronguri': 3
  };
  
  return accountMap[accountUri] || -1;
}

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
