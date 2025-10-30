<template>
  <div class="min-h-screen bg-gray-900">
    <header class="bg-gray-800 shadow-lg">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div class="flex items-center justify-between">
          <h1 class="text-3xl font-bold text-white">Baresip Control Dashboard</h1>
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-2">
              <div
                class="w-3 h-3 rounded-full"
                :class="connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'"
              ></div>
              <span class="text-sm text-gray-300">
                {{ connected ? 'Connected' : 'Disconnected' }}
              </span>
            </div>
            <NuxtLink
              to="/logs"
              class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition"
            >
              View Logs
            </NuxtLink>
          </div>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <section class="mb-8">
        <h2 class="text-2xl font-bold text-white mb-4">SIP Accounts</h2>
        <div v-if="accounts.length === 0" class="bg-gray-800 rounded-lg shadow-lg p-8 text-center">
          <p class="text-gray-400">No accounts registered yet</p>
        </div>
        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AccountCard
            v-for="account in accounts"
            :key="account.uri"
            :account="account"
            :contacts="contacts"
            @call="handleCall"
            @hangup="handleHangup"
            @assignContact="handleAssignContact"
          />
        </div>
      </section>

      <section>
        <h2 class="text-2xl font-bold text-white mb-4">Auto-Connect Contacts</h2>
        <div v-if="contacts.length === 0" class="bg-gray-800 rounded-lg shadow-lg p-8 text-center">
          <p class="text-gray-400">No contacts configured</p>
          <p class="text-sm text-gray-500 mt-2">Add contacts via API or configuration</p>
        </div>
        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ContactCard
            v-for="contact in contacts"
            :key="contact.contact"
            :contact="contact"
            :accounts="accounts"
          />
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
// Use Socket.IO instead of WebSocket
const { connected, accounts, contacts, sendCommand, toggleAutoConnect } = useSocketIO();

const handleAssignContact = async (accountUri: string, contactUri: string) => {
  console.log(`Assigning contact ${contactUri} to account ${accountUri}`);
  
  try {
    const response = await fetch('/api/autoconnect/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountUri, contact: contactUri })
    });
    
    const result = await response.json();
    console.log('Account assignment result:', result);
  } catch (err) {
    console.error('Failed to assign account:', err);
    alert(`Failed to assign account: ${err}`);
  }
};

const handleCall = async (uri: string) => {
  const target = prompt('Enter SIP URI to call:');
  
  if (target) {
    try {
      console.log(`Attempting to call: ${target} from account: ${uri}`);
      
      // First, select the account using uafind
      console.log(`Selecting account: ${uri}`);
      const findResult = await sendCommand('uafind', uri);
      console.log('Account selection result:', findResult);
      
      // Small delay to ensure account is selected
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Then dial from the selected account
      const result = await sendCommand('dial', target);
      console.log('Call result:', result);
      
    } catch (err) {
      console.error('Call failed:', err);
      alert(`Call failed: ${err.message || err}`);
    }
  }
};

const handleHangup = async (uri: string) => {
  try {
    console.log(`Attempting to hangup call for account: ${uri}`);
    
    // Use uafind to select the specific account first
    const findResult = await sendCommand('uafind', uri);
    console.log('Account find result:', findResult);
    
    // Small delay to ensure account is selected
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Then hangup
    const result = await sendCommand('hangup');
    console.log('Hangup result:', result);
    
  } catch (err) {
    console.error('Hangup failed:', err);
    alert(`Hangup failed: ${err.message || err}`);
  }
};

const handleToggleAutoConnect = async (contact: string, enabled: boolean) => {
  try {
    await toggleAutoConnect(contact, enabled);
  } catch (err) {
    console.error('Failed to toggle auto-connect:', err);
  }
};
</script>
