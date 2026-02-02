import { ref, onMounted, onUnmounted } from 'vue';
import { io, Socket } from 'socket.io-client';

export const useSocketIO = () => {
    // Robuste Sortierfunktion: numerisch nach SIP-Nummer, sonst lexikografisch
    function extractNumber(uri: string): number | null {
      if (!uri) return null;
      const match = uri.replace(/^sip:/, '').match(/(\d+)/);
      if (match) {
        const n = parseInt(match[1].replace(/^0+/, ''), 10);
        return isNaN(n) ? null : n;
      }
      return null;
    }
    function accountSortFn(a: any, b: any) {
      const nA = extractNumber(a.uri);
      const nB = extractNumber(b.uri);
      if (nA !== null && nB !== null) {
        if (nA !== nB) return nA - nB;
        return (a.uri || '').localeCompare(b.uri || '');
      } else if (nA !== null) {
        return -1;
      } else if (nB !== null) {
        return 1;
      }
      return (a.uri || '').localeCompare(b.uri || '');
    }

    // Accounts ergänzen/aktualisieren und sortieren
    function mergeAndSortAccounts(incoming: any[]) {
      for (const acc of incoming) {
        const idx = accounts.value.findIndex(a => a.uri === acc.uri);
        if (idx >= 0) {
          accounts.value[idx] = { ...accounts.value[idx], ...acc };
        } else {
          accounts.value.push(acc);
        }
      }
      accounts.value.sort(accountSortFn);
    }
  const socket = ref<Socket | null>(null);
  const connected = ref(false); // Socket.IO connection to UI server
  const baresipConnected = ref(false); // TCP connection to Baresip
  const accounts = ref<any[]>([]);
  const contacts = ref<any[]>([]);
  const calls = ref<any[]>([]);
  const logs = ref<any[]>([]);

  const connect = () => {
    console.log('🔌 Socket.IO: Connecting...');
    
    // Connect to Socket.IO on same port as Nuxt (3000)
    socket.value = io({
      path: '/socket.io/',
      transports: ['polling', 'websocket']
    });

    socket.value.on('connect', () => {
      connected.value = true;
    });

    socket.value.on('disconnect', () => {
      connected.value = false;
    });

    socket.value.on('init', (data: any) => {
      mergeAndSortAccounts(data.accounts || []);
      contacts.value = data.contacts || [];
      calls.value = data.calls || [];
      baresipConnected.value = data.baresipConnected ?? false;
      sendCommand('uastat');
    });

    socket.value.on('baresipStatus', (data: any) => {
      baresipConnected.value = data.connected;
    });

    socket.value.on('baresipDisconnected', () => {
      calls.value = [];
    });

    socket.value.on('message', (data: any) => {
      if (data.type === 'init') {
        mergeAndSortAccounts(data.accounts || []);
        contacts.value = data.contacts || [];
        calls.value = data.calls || [];
        baresipConnected.value = data.baresipConnected ?? false;
        sendCommand('uastat');
      } else if (data.type === 'accountStatus') {
          const idx = accounts.value.findIndex(a => a.uri === data.data.uri);
          if (idx >= 0) {
            accounts.value[idx] = { ...accounts.value[idx], ...data.data };
          } else {
            accounts.value.push(data.data);
          }
          accounts.value.sort(accountSortFn);
      } else if (data.type === 'accountsUpdate') {
        mergeAndSortAccounts(data.accounts || []);
      } else if (data.type === 'log') {
        // ...
        logs.value.push(data.log || data);
        if (logs.value.length > 1000) {
          logs.value.shift();
        }
      } else if (data.type === 'presence') {
        const contact = contacts.value.find(c => c.contact === data.contact);
        if (contact) {
          contact.presence = data.status;
        }
      } else if (data.type === 'autoConnectStatus') {
        const contact = contacts.value.find(c => c.contact === data.contact);
        if (contact) {
          contact.status = data.status;
        }
      } else if (data.type === 'contactsUpdate') {
        contacts.value = data.contacts || [];
      } else if (data.type === 'callAdded' || data.type === 'callUpdated') {
        const callIndex = calls.value.findIndex(c => c.callId === data.data.callId);
        if (callIndex >= 0) {
          // Update existing call - force reactivity
          calls.value = [
            ...calls.value.slice(0, callIndex),
            data.data,
            ...calls.value.slice(callIndex + 1)
          ];
        } else {
          // Add new call
          calls.value = [...calls.value, data.data];
        }
      } else if (data.type === 'callRemoved') {
        calls.value = calls.value.filter(c => c.callId !== data.data.callId);
      }
    });

    socket.value.on('error', (error: any) => {
      console.error('❌ Socket.IO: Error', error);
    });
  };

  const sendCommand = async (command: string, params?: string) => {
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, params })
      }).then(r => r.json());
      return response;
    } catch (err) {
      console.error('Error sending command:', err);
      throw err;
    }
  };

  const toggleAutoConnect = async (contact: string, enabled: boolean) => {
    try {
      const response = await fetch(`/api/autoconnect/${encodeURIComponent(contact)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      }).then(r => r.json());
      return response;
    } catch (err) {
      console.error('Error toggling auto-connect:', err);
      throw err;
    }
  };

  onMounted(() => {
    console.log('🚀 Socket.IO: Component mounted, connecting...');
    connect();
  });

  onUnmounted(() => {
    if (socket.value) {
      socket.value.disconnect();
    }
  });

  return {
    socket,
    connected,
    baresipConnected,
    accounts,
    contacts,
    calls,
    logs,
    sendCommand,
    toggleAutoConnect
  };
};
