import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { io, Socket } from 'socket.io-client';
import type { GpioState, AudioMeter } from '~/types';
import { accountSortFn } from '~/utils/account-sorting';

export const useSocketIO = () => {
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
  const gpioStates = ref<any[]>([]);
  const audioMeters = reactive<Record<string, AudioMeter>>({});

  // Jitter buffer drop rate: drops counted in a 10s rolling window
  const JBUF_WINDOW_MS = 10_000;
  const jbufDropWindow: { time: number; count: number }[] = [];
  const jbufDropRate = ref(0);

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
      gpioStates.value = data.gpioStates || [];
      // Populate audioMeters from init data
      if (data.audioMeters) {
        for (const m of data.audioMeters) {
          audioMeters[m.accountUri.toLowerCase()] = m;
        }
      }
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

    socket.value.on('gpioUpdate', (data: GpioState) => {
      const idx = gpioStates.value.findIndex(
        s => s.accountUri.toLowerCase() === data.accountUri.toLowerCase()
      );
      if (idx >= 0) {
        gpioStates.value[idx] = data;
      } else {
        gpioStates.value.push(data);
      }
      // Trigger reactivity
      gpioStates.value = [...gpioStates.value];
    });

    socket.value.on('audioMeter', (data: AudioMeter) => {
      audioMeters[data.accountUri.toLowerCase()] = data;
    });

    socket.value.on('jbufDrops', (data: { count: number }) => {
      const now = Date.now();
      jbufDropWindow.push({ time: now, count: data.count });
      // Evict entries older than the window
      while (jbufDropWindow.length && now - jbufDropWindow[0].time >= JBUF_WINDOW_MS) {
        jbufDropWindow.shift();
      }
      jbufDropRate.value = jbufDropWindow.reduce((s, e) => s + e.count, 0);
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

  const toggleGpio = async (accountUri: string, gpioIndex: number, state: boolean) => {
    try {
      const response = await fetch('/api/gpio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountUri, gpioIndex, state })
      }).then(r => r.json());
      return response;
    } catch (err) {
      console.error('Error toggling GPIO:', err);
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
    gpioStates,
    audioMeters,
    jbufDropRate,
    sendCommand,
    toggleAutoConnect,
    toggleGpio
  };
};
