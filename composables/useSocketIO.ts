import { ref, onMounted, onUnmounted } from 'vue';
import { io, Socket } from 'socket.io-client';

export const useSocketIO = () => {
  const socket = ref<Socket | null>(null);
  const connected = ref(false);
  const accounts = ref<any[]>([]);
  const contacts = ref<any[]>([]);
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
      accounts.value = data.accounts || [];
      contacts.value = data.contacts || [];
    });

    socket.value.on('message', (data: any) => {
      console.log('📨 Socket.IO: Received message', data);

      if (data.type === 'init') {
        accounts.value = data.accounts || [];
        contacts.value = data.contacts || [];
      } else if (data.type === 'accountStatus') {
        const index = accounts.value.findIndex(a => a.uri === data.data.uri);
        if (index >= 0) {
          accounts.value[index] = { ...accounts.value[index], ...data.data };
        } else {
          accounts.value.push(data.data);
        }
      } else if (data.type === 'log') {
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
      console.log('👋 Socket.IO: Disconnecting...');
      socket.value.disconnect();
    }
  });

  return {
    socket,
    connected,
    accounts,
    contacts,
    logs,
    sendCommand,
    toggleAutoConnect
  };
};
