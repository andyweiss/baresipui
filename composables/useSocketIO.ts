import { ref, onMounted, onUnmounted } from 'vue';
import { io, Socket } from 'socket.io-client';

export const useSocketIO = () => {
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
  const connected = ref(false);             // Socket.IO connection to UI server
  const baresipConnected = ref(false);      // TCP connection to Baresip
  const accounts = ref<any[]>([]);
  const contacts = ref<any[]>([]);
  const calls = ref<any[]>([]);

  const connect = () => {
    socket.value = io({
      path: '/socket.io/',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000
    });

    socket.value.on('connect', () => {
      connected.value = true;
    });

    socket.value.on('disconnect', () => {
      connected.value = false;
    });

    socket.value.on('reconnect', () => {
      // After reconnect, request fresh call/account state from baresip
      sendCommand('listcalls');
      sendCommand('uastat');
    });

    // Dedicated real-time call event handlers (no polling, immediate push from server)
    socket.value.on('callAdded', (call: any) => {
      const callIndex = calls.value.findIndex(c => c.callId === call.callId);
      if (callIndex >= 0) {
        calls.value = [...calls.value.slice(0, callIndex), call, ...calls.value.slice(callIndex + 1)];
      } else {
        calls.value = [...calls.value, call];
      }
    });

    socket.value.on('callUpdated', (call: any) => {
      const callIndex = calls.value.findIndex(c => c.callId === call.callId);
      if (callIndex >= 0) {
        calls.value = [...calls.value.slice(0, callIndex), call, ...calls.value.slice(callIndex + 1)];
      } else {
        calls.value = [...calls.value, call];
      }
    });

    socket.value.on('callRemoved', (data: any) => {
      const callId = data.callId || data;
      calls.value = calls.value.filter(c => c.callId !== callId);
    });

    socket.value.on('callsCleared', () => {
      calls.value = [];
    });

    socket.value.on('accountStatus', (acc: any) => {
      const idx = accounts.value.findIndex(a => a.uri === acc.uri);
      if (idx >= 0) {
        accounts.value[idx] = { ...accounts.value[idx], ...acc };
      } else {
        accounts.value.push(acc);
      }
      accounts.value.sort(accountSortFn);
    });

    socket.value.on('baresipStatus', (data: any) => {
      baresipConnected.value = data.connected;
      if (!data.connected) {
        calls.value = [];
      }
    });

    socket.value.on('baresipDisconnected', () => {
      calls.value = [];
      baresipConnected.value = false;
    });

    socket.value.on('init', (data: any) => {
      mergeAndSortAccounts(data.accounts || []);
      contacts.value = data.contacts || [];
      calls.value = data.calls || [];
      baresipConnected.value = data.baresipConnected ?? false;
      sendCommand('uastat');
    });

    socket.value.on('accountsUpdate', (data: any) => {
      mergeAndSortAccounts(data.accounts || []);
    });

    socket.value.on('presence', (data: any) => {
      const contact = contacts.value.find(c => c.contact === data.contact);
      if (contact) {
        contact.presence = data.status;
      }
    });

    socket.value.on('autoConnectStatus', (data: any) => {
      const contact = contacts.value.find(c => c.contact === data.contact);
      if (contact) {
        contact.status = data.status;
      }
    });

    socket.value.on('contactsUpdate', (data: any) => {
      contacts.value = data.contacts || [];
    });

    socket.value.on('error', (error: any) => {
      console.error('Socket.IO Error:', error);
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
    sendCommand,
    toggleAutoConnect
  };
};
