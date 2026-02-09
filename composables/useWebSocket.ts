import { ref, onMounted, onUnmounted } from 'vue';

export const useWebSocket = () => {
  const ws = ref<WebSocket | null>(null);
  const connected = ref(false);
  const accounts = ref<any[]>([]);
  const contacts = ref<any[]>([]);
  const logs = ref<any[]>([]);

  const loadAccountsFromAPI = async () => {
    try {
      const response1 = await fetch('/api/accounts');
      const accountsData = await response1.json();
      
      const response2 = await fetch('/api/contacts');
      const contactsData = await response2.json();
      
      accounts.value = accountsData || [];
      contacts.value = contactsData || [];
    } catch (error) {
      console.error('Failed to load accounts from API:', error);
    }
  };
  
  // Immediate load for client-side
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      loadAccountsFromAPI();
    }, 100);
  }

  const connect = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/_ws`;
    
    try {
      ws.value = new WebSocket(wsUrl);
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      return;
    }

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
        } else if (data.type === 'contactsUpdate') {
          contacts.value = data.contacts || [];
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.value.onclose = (event) => {
      connected.value = false;
      console.log('WebSocket closed - Code:', event.code);
      setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.value.onerror = (error) => {
      console.error('WebSocket error:', error);
      connected.value = false;
    };
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
    loadAccountsFromAPI();
    
    // Fallback after 2 seconds if no accounts loaded
    setTimeout(() => {
      if (accounts.value.length === 0) {
        loadAccountsFromAPI();
      }
    }, 2000);
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
