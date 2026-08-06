import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { io, Socket } from 'socket.io-client';
import type {
  AudioMeter,
  GpioState,
  TalktomeBridgeGlobalStatus,
  TalktomeBridgeStatus,
} from '~/types';
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
  const talktomeBridgeGlobalStatus = ref<TalktomeBridgeGlobalStatus | null>(null);
  const talktomeBridgeStatuses = ref<TalktomeBridgeStatus[]>([]);

  function setTalktomeBridgeStatus(status: TalktomeBridgeStatus) {
    const key = status.accountUri.toLowerCase().trim();
    const index = talktomeBridgeStatuses.value.findIndex(
      candidate => candidate.accountUri.toLowerCase().trim() === key
    );
    if (index >= 0) {
      talktomeBridgeStatuses.value = [
        ...talktomeBridgeStatuses.value.slice(0, index),
        status,
        ...talktomeBridgeStatuses.value.slice(index + 1),
      ];
    } else {
      talktomeBridgeStatuses.value = [...talktomeBridgeStatuses.value, status];
    }
  }

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
      talktomeBridgeGlobalStatus.value = data.talktomeBridge?.globalStatus ?? null;
      talktomeBridgeStatuses.value = data.talktomeBridge?.statuses ?? [];
      sendCommand('uastat');
    });

    socket.value.on('talktomeBridgeGlobalStatus', (status: TalktomeBridgeGlobalStatus) => {
      talktomeBridgeGlobalStatus.value = status;
    });

    socket.value.on('talktomeBridgeStatus', (status: TalktomeBridgeStatus) => {
      setTalktomeBridgeStatus(status);
    });

    socket.value.on(
      'talktomeBridgeStatusRemoved',
      (data: { accountUri: string } | string) => {
        const accountUri = typeof data === 'string' ? data : data.accountUri;
        const key = accountUri.toLowerCase().trim();
        talktomeBridgeStatuses.value = talktomeBridgeStatuses.value.filter(
          status => status.accountUri.toLowerCase().trim() !== key
        );
      }
    );

    socket.value.on('talktomeBridgeStatuses', (statuses: TalktomeBridgeStatus[]) => {
      talktomeBridgeStatuses.value = statuses;
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
    talktomeBridgeGlobalStatus,
    talktomeBridgeStatuses,
    sendCommand,
    toggleAutoConnect,
    toggleGpio
  };
};
