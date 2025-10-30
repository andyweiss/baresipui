import { ref, onMounted, onUnmounted } from 'vue';

export const useWebSocket = () => {
  const ws = ref<WebSocket | null>(null);
  const connected = ref(false);
  const accounts = ref<any[]>([]);
  const contacts = ref<any[]>([]);
  const logs = ref<any[]>([]);

  // Lade Accounts sofort beim ersten Aufruf
  console.log('🏁 FRONTEND DEBUG: useWebSocket composable called');

  const loadAccountsFromAPI = async () => {
    try {
      console.log('🔄 FRONTEND DEBUG: Loading accounts from REST API as fallback...');
      
      const response1 = await fetch('/api/accounts');
      const accountsData = await response1.json();
      
      const response2 = await fetch('/api/contacts');
      const contactsData = await response2.json();
      
      accounts.value = accountsData || [];
      contacts.value = contactsData || [];
      
      console.log('✅ FRONTEND DEBUG: Loaded from API - Accounts:', accounts.value.length, 'Contacts:', contacts.value.length);
      console.log('📊 FRONTEND DEBUG: Accounts data:', accounts.value);
    } catch (error) {
      console.error('❌ FRONTEND DEBUG: Failed to load accounts from API:', error);
    }
  };
  
  // Immediate load für Client-side
  if (typeof window !== 'undefined') {
    console.log('🔄 FRONTEND DEBUG: Client-side detected, loading accounts immediately...');
    setTimeout(() => {
      loadAccountsFromAPI();
    }, 100);
  }

  const connect = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/_ws`;

    console.log('🔌 FRONTEND DEBUG: Connecting to WebSocket:', wsUrl);
    console.log('🔌 FRONTEND DEBUG: Current location:', window.location.href);
    console.log('🔌 FRONTEND DEBUG: Protocol:', protocol, 'Host:', host);
    
    try {
      ws.value = new WebSocket(wsUrl);
      console.log('🔌 FRONTEND DEBUG: WebSocket object created successfully');
    } catch (error) {
      console.error('❌ FRONTEND DEBUG: Failed to create WebSocket:', error);
      return;
    }

    ws.value.onopen = () => {
      connected.value = true;
      console.log('✅ FRONTEND DEBUG: WebSocket connected successfully');
    };

    ws.value.onmessage = (event) => {
      try {
        console.log('📨 FRONTEND DEBUG: Raw message received:', event.data);
        const data = JSON.parse(event.data);
        console.log('📦 FRONTEND DEBUG: Parsed message:', data);

        if (data.type === 'init') {
          console.log('🔄 FRONTEND DEBUG: Init message - accounts:', data.accounts?.length || 0, 'contacts:', data.contacts?.length || 0);
          accounts.value = data.accounts || [];
          contacts.value = data.contacts || [];
          console.log('✅ FRONTEND DEBUG: Accounts set to:', accounts.value);
        } else if (data.type === 'accountStatus') {
          console.log('📊 FRONTEND DEBUG: Account status update for:', data.data.uri);
          const index = accounts.value.findIndex(a => a.uri === data.data.uri);
          if (index >= 0) {
            console.log('🔄 FRONTEND DEBUG: Updating existing account at index', index);
            accounts.value[index] = data.data;
          } else {
            console.log('➕ FRONTEND DEBUG: Adding new account');
            accounts.value.push(data.data);
          }
          console.log('📊 FRONTEND DEBUG: Total accounts now:', accounts.value.length);
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
        console.error('❌ FRONTEND DEBUG: Error parsing WebSocket message:', err);
        console.error('📨 FRONTEND DEBUG: Original message was:', event.data);
      }
    };

    ws.value.onclose = (event) => {
      connected.value = false;
      console.log('🔌 FRONTEND DEBUG: WebSocket closed - Code:', event.code, 'Reason:', event.reason);
      setTimeout(() => {
        console.log('🔄 FRONTEND DEBUG: Attempting to reconnect...');
        connect();
      }, 3000);
    };

    ws.value.onerror = (error) => {
      console.error('❌ FRONTEND DEBUG: WebSocket error:', error);
      console.error('❌ FRONTEND DEBUG: WebSocket error details:', {
        type: error.type,
        target: error.target?.readyState,
        url: wsUrl
      });
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
    console.log('🚀 FRONTEND DEBUG: Component mounted, starting initialization...');
    connect();
    
    // Lade Accounts sofort über REST API
    loadAccountsFromAPI();
    
    // Als zusätzlicher Fallback nach 2 Sekunden
    setTimeout(() => {
      if (accounts.value.length === 0) {
        console.log('⚠️ FRONTEND DEBUG: Still no accounts, trying REST API again...');
        loadAccountsFromAPI();
      }
    }, 2000);
  });

  onUnmounted(() => {
    if (ws.value) {
      ws.value.close();
    }
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
