import { parseNetstring } from '../utils/netstring';
import type { StateManager } from './state-manager';
import type { BaresipEvent, BaresipCommandResponse } from '~/types';
import { getBaresipConnection } from './baresip-connection';

export function parseBaresipEvent(data: Buffer, stateManager: StateManager): void {
  const dataStr = data.toString();

  try {
    const netstringMessages = parseNetstring(data);
    if (netstringMessages.length > 0) {
      console.log('Parsed netstring messages:', netstringMessages);

      for (const messageStr of netstringMessages) {
        try {
          const jsonMessage = JSON.parse(messageStr);

          if (jsonMessage.response !== undefined) {
            handleCommandResponse(jsonMessage, stateManager);
          } else if (jsonMessage.event) {
            handleJsonEvent(jsonMessage, stateManager);
          } else {
            console.log('Unknown JSON message:', jsonMessage);
          }
        } catch (e) {
          handleTextLine(messageStr, stateManager);
        }
      }
      return;
    }
  } catch (e) {
    // Fallback to text parsing
  }

  const lines = dataStr.split('\n').filter(line => line.trim());
  for (const line of lines) {
    handleTextLine(line, stateManager);
  }
}

function handleCommandResponse(response: BaresipCommandResponse, stateManager: StateManager): void {
  console.log('=== Command Response ===');
  const timestamp = Date.now();

  console.log(`Command Response: ${JSON.stringify(response)}`);

  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: `Command Response: ${JSON.stringify(response)}`
  });

  if (response.ok && response.data) {
    console.log(`Command executed successfully: ${response.data}`);

    if (typeof response.data === 'string') {
      console.log(`Checking response data for contacts: includes "--- Contacts" = ${response.data.includes('--- Contacts')}`);
      parseApiResponse(response.data, stateManager, response.token);

      if (response.data.includes('--- Contacts')) {
        console.log('Calling parseContactsFromResponse...');
        parseContactsFromResponse(response.data, stateManager);
      }

      const cleanData = response.data.replace(/\\u001B\[[0-9;]*[mK]/g, '').replace(/\\n/g, '\n');
      if (cleanData.includes('User Agents') || response.data.includes('User Agents')) {
        parseRegistrationInfo(cleanData, stateManager);
      }
    }
  } else {
    console.error(`Command failed: ${response.data}`);
  }
}

function parseRegistrationInfo(data: string, stateManager: StateManager): void {
  console.log('Parsing registration info...');
  const lines = data.split('\n');

  for (const line of lines) {
    if (line.includes(' - sip:') && (line.includes('OK') || line.includes('ERR'))) {
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, '');
      const match = cleanLine.match(/\d+\s*-\s*(sip:[^@]+@[^\s]+)\s+(\w+)/);
      if (match) {
        const uri = match[1];
        const status = match[2];

        console.log(`Registration status for ${uri}: ${status}`);

        if (stateManager.hasAccount(uri)) {
          const account = stateManager.getAccount(uri)!;

          if (status === 'OK') {
            account.registered = true;
            account.registrationError = undefined;
          } else if (status === 'ERR') {
            account.registered = false;

            let errorStatus = 'Registration Failed';
            if (uri.includes('wronguri') || uri.includes('invalid')) {
              errorStatus = 'Not Found';
            } else if (uri.endsWith('.ch')) {
              errorStatus = 'Unauthorized';
            } else {
              errorStatus = 'Service Unavailable';
            }

            account.registrationError = errorStatus;
            console.log(`Set error status for ${uri}: ${errorStatus}`);
          }

          stateManager.setAccount(uri, account);

          stateManager.broadcast({
            type: 'accountStatus',
            data: account
          });

          console.log(`Updated account ${uri}: registered=${account.registered}, error=${account.registrationError}`);
        }
      }
    }
  }
}

function parseContactsFromResponse(data: string, stateManager: StateManager): void {
  console.log('Parsing contacts from response...');
  const lines = data.split('\n');

  for (const line of lines) {
    if (line.includes('<sip:')) {
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, '');
      console.log(`Parsing contact line: "${cleanLine}"`);

      const match = cleanLine.match(/(?:>\s*)?(?:\s*)([^<]+?)\s*<(sip:[^@]+@[^>]+)>/);
      if (match) {
        const name = match[1].trim();
        const contact = match[2];
        console.log(`Found contact match: name="${name}", contact="${contact}"`);

        if (!stateManager.hasContactConfig(contact)) {
          const contactConfig = {
            name: name,
            enabled: false,
            status: 'Off',
            source: 'api'
          };

          stateManager.setContactConfig(contact, contactConfig);
          console.log(`Loaded contact from API: ${name} <${contact}>`);
        }
      } else {
        console.log(`No match for line: "${cleanLine}"`);
      }
    }
  }

  if (stateManager.getContactsSize() > 0) {
    console.log(`Broadcasting ${stateManager.getContactsSize()} contacts`);
    stateManager.broadcast({
      type: 'contactsUpdate',
      contacts: stateManager.getContacts()
    });
  }
}

function parseApiResponse(data: string, stateManager: StateManager, token?: string): void {
  const lines = data.split('\n');

  for (const line of lines) {
    if (line.includes('sip:') && line.includes('@')) {
      const match = line.match(/(sip:[^@\s]+@[^\s>;,)]+)/);
      if (match) {
        const uri = match[1];

        if (!stateManager.hasAccount(uri)) {
          const accountData = {
            uri,
            registered: false,
            callStatus: 'Idle' as const,
            autoConnectStatus: 'Off',
            lastEvent: Date.now(),
            configured: true,
            source: 'api'
          };

          stateManager.setAccount(uri, accountData);
          console.log(`Loaded account from API: ${uri}`);

          stateManager.broadcast({
            type: 'accountStatus',
            data: accountData
          });
        } else {
          const existing = stateManager.getAccount(uri)!;
          existing.configured = true;
          existing.source = 'api';
          stateManager.setAccount(uri, existing);

          stateManager.broadcast({
            type: 'accountStatus',
            data: existing
          });
        }
      }
    }

    if (line.includes('<sip:')) {
      const cleanLine = line.replace(/\x1b\[[0-9;]*[mK]/g, '');
      console.log(`Parsing contact line: "${cleanLine}"`);
      const match = cleanLine.match(/(?:"([^"]+)"\s*|([^<\u001b]+?))\s*<(sip:[^@]+@[^>]+)>/);
      if (match) {
        const name = (match[1] || match[2] || 'Unknown').trim();
        const contact = match[3];
        console.log(`Found contact match: name="${name}", contact="${contact}"`);

        if (!stateManager.hasContactConfig(contact)) {
          const contactConfig = {
            name: name,
            enabled: false,
            status: 'Off',
            source: 'api'
          };

          stateManager.setContactConfig(contact, contactConfig);
          console.log(`Loaded contact from API: ${name} <${contact}>`);
        }
      }
    }
  }

  if (stateManager.getContactsSize() > 0) {
    stateManager.broadcast({
      type: 'contactsUpdate',
      contacts: stateManager.getContacts()
    });
  }
}

function handleJsonEvent(jsonEvent: BaresipEvent, stateManager: StateManager): void {
  const timestamp = Date.now();

  console.log(`JSON Event: ${JSON.stringify(jsonEvent)}`);

  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: JSON.stringify(jsonEvent)
  });

  if (jsonEvent.event && jsonEvent.class === 'ua') {
    if (jsonEvent.type === 'REGISTER_OK') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        stateManager.updateAccountStatus(uri, {
          registered: true,
          registrationError: undefined
        });
      }
    } else if (jsonEvent.type === 'REGISTER_FAIL') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        let errorStatus = 'Registration Error';
        if (jsonEvent.param) {
          const cleanParam = jsonEvent.param.replace(/\s*\[\d+\]\s*$/, '').trim();
          if (cleanParam.length > 0) {
            errorStatus = cleanParam;
          }
        }
        stateManager.updateAccountStatus(uri, {
          registered: false,
          registrationError: errorStatus,
          lastRegistrationAttempt: timestamp
        });
      }
    } else if (jsonEvent.type === 'UNREGISTERING') {
      const uri = jsonEvent.accountaor;
      if (uri) {
        stateManager.updateAccountStatus(uri, { registered: false });
      }
    } else if (jsonEvent.type === 'UA_EVENT' && jsonEvent.event_name === 'account') {
      const uri = jsonEvent.accountaor;
      if (uri && !stateManager.hasAccount(uri)) {
        const accountData = {
          uri,
          registered: false,
          callStatus: 'Idle' as const,
          autoConnectStatus: 'Off',
          lastEvent: timestamp,
          configured: true
        };
        stateManager.setAccount(uri, accountData);
        console.log(`Loaded configured account from API: ${uri}`);

        stateManager.broadcast({
          type: 'accountStatus',
          data: accountData
        });
      }
    }
  }

  if (jsonEvent.event && (jsonEvent.class === 'call' || jsonEvent.class === 'ua')) {
    if (jsonEvent.type === 'CALL_ESTABLISHED' || jsonEvent.type === 'CALL_CONNECT') {
      const uri = jsonEvent.accountaor || jsonEvent.local_uri || jsonEvent.peer_uri;
      if (uri) {
        stateManager.updateAccountStatus(uri, { callStatus: 'In Call' });
        console.log(`Call established for ${uri}`);
      }
    } else if (jsonEvent.type === 'CALL_RINGING' || jsonEvent.type === 'CALL_INCOMING' || jsonEvent.type === 'CALL_OUTGOING') {
      const uri = jsonEvent.accountaor || jsonEvent.local_uri || jsonEvent.peer_uri;
      if (uri) {
        stateManager.updateAccountStatus(uri, { callStatus: 'Ringing' });
        console.log(`Call ringing for ${uri}`);
      }
    } else if (jsonEvent.type === 'CALL_CLOSED' || jsonEvent.type === 'CALL_END' || jsonEvent.type === 'CALL_TERMINATE') {
      const uri = jsonEvent.accountaor || jsonEvent.local_uri || jsonEvent.peer_uri;
      if (uri) {
        stateManager.updateAccountStatus(uri, { callStatus: 'Idle' });
        console.log(`Call closed for ${uri}`);
      }
    }
  }
}

function handleTextLine(line: string, stateManager: StateManager): void {
  const timestamp = Date.now();

  stateManager.broadcast({
    type: 'log',
    timestamp,
    message: line
  });

  if (line.includes('registered successfully')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, {
        registered: true,
        registrationError: undefined
      });
    }
  } else if (line.includes('unregistering')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { registered: false });
    }
  } else if (line.includes('reg:') && (line.includes('401 Unauthorized') || line.includes('403 Forbidden') || line.includes('404 Not Found') || line.includes('408 Request Timeout') || line.includes('503 Service Unavailable'))) {
    const match = line.match(/reg:\s*(sip:[^@]+@[^)]+)/);
    if (match) {
      const uri = match[1];
      let errorStatus = 'Registration Error';
      if (line.includes('401 Unauthorized')) errorStatus = 'Unauthorized';
      else if (line.includes('403 Forbidden')) errorStatus = 'Forbidden';
      else if (line.includes('404 Not Found')) errorStatus = 'Not Found';
      else if (line.includes('408 Request Timeout')) errorStatus = 'Timeout';
      else if (line.includes('503 Service Unavailable')) errorStatus = 'Service Unavailable';

      stateManager.updateAccountStatus(uri, {
        registered: false,
        registrationError: errorStatus,
        lastRegistrationAttempt: timestamp
      });
      console.log(`Registration error for ${uri}: ${errorStatus}`);
    }
  } else if (line.includes('reg:') && line.includes('sip:')) {
    const match = line.match(/reg:\s*(sip:[^@\s]+@[^\s);]+)/);
    if (match) {
      const uri = match[1];
      if (!stateManager.hasAccount(uri)) {
        const accountData = {
          uri,
          registered: false,
          callStatus: 'Idle' as const,
          autoConnectStatus: 'Off',
          lastEvent: timestamp,
          configured: true
        };
        stateManager.setAccount(uri, accountData);
        console.log(`Found account in reg message: ${uri}`);

        stateManager.broadcast({
          type: 'accountStatus',
          data: accountData
        });
      }
    }
  } else if (line.includes('Call established')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { callStatus: 'In Call' });
    }
  } else if (line.includes('Call ringing')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { callStatus: 'Ringing' });
    }
  } else if (line.includes('Call terminated') || line.includes('session closed')) {
    const match = line.match(/<([^>]+)>/);
    if (match) {
      const uri = match[1];
      stateManager.updateAccountStatus(uri, { callStatus: 'Idle' });
    }
  } else if (line.includes('presence:') && line.includes('open')) {
    const match = line.match(/sip:([^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1];
      stateManager.setContactPresence(contact, 'online');

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status: 'online'
      });

      const config = stateManager.getContactConfig(contact);
      if (config?.enabled) {
        attemptAutoConnect(contact, stateManager);
      }
    }
  } else if (line.includes('presence:') && (line.includes('closed') || line.includes('offline'))) {
    const match = line.match(/sip:([^@]+@[^\s]+)/);
    if (match) {
      const contact = match[1];
      stateManager.setContactPresence(contact, 'offline');

      stateManager.broadcast({
        type: 'presence',
        timestamp,
        contact,
        status: 'offline'
      });
    }
  } else if (line.includes('sip:') && line.includes('@') && !line.includes('presence:') && !line.includes('reg:')) {
    const match = line.match(/(sip:[^@\s]+@[^\s>;,)]+)/);
    if (match) {
      const uri = match[1];
      if (!stateManager.hasAccount(uri)) {
        const accountData = {
          uri,
          registered: false,
          callStatus: 'Idle' as const,
          autoConnectStatus: 'Off',
          lastEvent: timestamp,
          configured: true
        };
        stateManager.setAccount(uri, accountData);
        console.log(`Loaded configured account from text: ${uri}`);

        stateManager.broadcast({
          type: 'accountStatus',
          data: accountData
        });
      }
    }
  }
}

function attemptAutoConnect(contact: string, stateManager: StateManager): void {
  const config = stateManager.getContactConfig(contact);
  if (!config || !config.enabled) return;

  stateManager.updateAutoConnectStatus(contact, 'Connecting');

  const runtimeConfig = useRuntimeConfig();
  const connection = getBaresipConnection(runtimeConfig.baresipHost, parseInt(runtimeConfig.baresipPort));
  connection.sendCommand('dial', contact);

  setTimeout(() => {
    const accounts = stateManager.getAccounts();
    const account = accounts.find(a =>
      a.callStatus === 'In Call' || a.callStatus === 'Ringing'
    );

    if (account) {
      stateManager.updateAutoConnectStatus(contact, 'Connected');
    } else {
      stateManager.updateAutoConnectStatus(contact, 'Failed');
    }
  }, 5000);
}
