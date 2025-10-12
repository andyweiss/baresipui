import { ref, onMounted, onUnmounted } from 'vue';

export const useWebSocket = () => {
  const ws = ref<WebSocket | null>(null);
  const connected = ref(false);
  const accounts = ref<any[]>([]);
  const contacts = ref<any[]>([]);
  const logs = ref<any[]>([]);

  const config = useRuntimeConfig();

  const connect = () => {
    const wsUrl = config.public.wsUrl;
    ws.value = new WebSocket(wsUrl);

    ws.value.onopen = () => {
      connected.value = true;
      console.log('WebSocket connected');
    };

    ws.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'init') {
          accounts.value = data.accounts || [];
          contacts.value = data.contacts || [];
        } else if (data.type === 'accountStatus') {
          const index = accounts.value.findIndex(a => a.uri === data.data.uri);
          if (index >= 0) {
            accounts.value[index] = data.data;
          } else {
            accounts.value.push(data.data);
          }
        } else if (data.type === 'log') {
          logs.value.push(data);
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
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.value.onclose = () => {
      connected.value = false;
      console.log('WebSocket disconnected');
      setTimeout(connect, 3000);
    };

    ws.value.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  };

  const sendCommand = async (command: string) => {
    const apiUrl = config.public.apiUrl;
    try {
      const response = await fetch(`${apiUrl}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      return await response.json();
    } catch (err) {
      console.error('Error sending command:', err);
      throw err;
    }
  };

  const toggleAutoConnect = async (contact: string, enabled: boolean) => {
    const apiUrl = config.public.apiUrl;
    try {
      const response = await fetch(`${apiUrl}/autoconnect/${encodeURIComponent(contact)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      return await response.json();
    } catch (err) {
      console.error('Error toggling auto-connect:', err);
      throw err;
    }
  };

  onMounted(() => {
    connect();
  });

  onUnmounted(() => {
    if (ws.value) {
      ws.value.close();
    }
  });

  return {
    connected,
    accounts,
    contacts,
    logs,
    sendCommand,
    toggleAutoConnect
  };
};
