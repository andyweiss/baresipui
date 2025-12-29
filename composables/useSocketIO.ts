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
      console.log('✅ Socket.IO: Connected successfully', socket.value?.id);
    });

    socket.value.on('disconnect', () => {
      connected.value = false;
      console.log('❌ Socket.IO: Disconnected');
    });

    socket.value.on('init', (data: any) => {
      console.log('📦 Socket.IO: Received init data', data);
      mergeAndSortAccounts(data.accounts || []);
      console.log('[DEBUG] Accounts nach init:', accounts.value.map(a => a.uri), 'Länge:', accounts.value.length);
      contacts.value = data.contacts || [];
      calls.value = data.calls || [];
      baresipConnected.value = data.baresipConnected ?? false;
    });

    socket.value.on('baresipStatus', (data: any) => {
      console.log('🔌 Socket.IO: Baresip status update', data);
      baresipConnected.value = data.connected;
    });

    socket.value.on('baresipDisconnected', () => {
      calls.value = [];
    });

    socket.value.on('message', (data: any) => {
      console.log('📨 Socket.IO: Received message', data);

      if (data.type === 'init') {
        mergeAndSortAccounts(data.accounts || []);
        console.log('[DEBUG] Accounts nach init (message):', accounts.value.map(a => a.uri), 'Länge:', accounts.value.length);
        contacts.value = data.contacts || [];
        calls.value = data.calls || [];
        baresipConnected.value = data.baresipConnected ?? false;
      } else if (data.type === 'accountStatus') {
        console.log('📊 Socket.IO: Account status update für:', data.data.uri);
        // Account-Liste stabil aktualisieren und sortieren
        const idx = accounts.value.findIndex(a => a.uri === data.data.uri);
        if (idx >= 0) {
          // Nur das Objekt aktualisieren
          accounts.value[idx] = { ...accounts.value[idx], ...data.data };
        } else {
          // Neuen Account ergänzen
          accounts.value.push(data.data);
        }
        // Nach jedem Update stabil sortieren
        accounts.value.sort(accountSortFn);
        console.log('[DEBUG] Accounts nach accountStatus:', accounts.value.map(a => a.uri), 'Länge:', accounts.value.length);
      } else if (data.type === 'accountsUpdate') {
        mergeAndSortAccounts(data.accounts || []);
        console.log('[DEBUG] Accounts nach accountsUpdate:', accounts.value.map(a => a.uri), 'Länge:', accounts.value.length);
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
        console.log('📞 Call event:', data.type, data.data);
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
        console.log('📞 Call removed:', data.data.callId);
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
