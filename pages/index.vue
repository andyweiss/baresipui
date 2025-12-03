<template>
  <div class="min-h-screen bg-gray-900">
    <header class="bg-gray-800 shadow-lg">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div class="flex items-center justify-between">
          <h1 class="text-3xl font-bold text-white">Baresip Control Dashboard</h1>
          <div class="flex items-center gap-2">
            <div
              class="w-3 h-3 rounded-full"
              :class="connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'"
            ></div>
            <span class="text-sm text-gray-300">
              {{ connected ? 'Connected' : 'Disconnected' }}
            </span>
          </div>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Tab Navigation -->
      <div class="mb-6 border-b border-gray-700">
        <nav class="flex space-x-8" aria-label="Tabs">
          <button
            @click="activeTab = 'accounts'"
            :class="[
              activeTab === 'accounts'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300',
              'whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition'
            ]"
          >
            Accounts
            <span class="ml-2 px-2 py-0.5 rounded-full text-xs bg-gray-700">{{ accounts.length }}</span>
          </button>
          <button
            @click="activeTab = 'contacts'"
            :class="[
              activeTab === 'contacts'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300',
              'whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition'
            ]"
          >
            Contacts
            <span class="ml-2 px-2 py-0.5 rounded-full text-xs bg-gray-700">{{ contacts.length }}</span>
          </button>
          <button
            @click="activeTab = 'logs'"
            :class="[
              activeTab === 'logs'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300',
              'whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition'
            ]"
          >
            Logs
          </button>
        </nav>
      </div>

      <!-- Accounts Tab -->
      <section v-show="activeTab === 'accounts'">
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

      <!-- Contacts Tab -->
      <section v-show="activeTab === 'contacts'">
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

      <!-- Logs Tab -->
      <section v-show="activeTab === 'logs'">
        <iframe
          src="/logs"
          class="w-full bg-gray-800 rounded-lg shadow-lg"
          style="height: calc(100vh - 300px); min-height: 600px;"
        ></iframe>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

// Use Socket.IO instead of WebSocket
const { connected, accounts, contacts, sendCommand, toggleAutoConnect } = useSocketIO();

// Active tab state
const activeTab = ref('accounts');

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
    
    // Find the account to get its call ID
    const account = accounts.value.find(a => a.uri === uri);
    if (!account) {
      console.error('Account not found:', uri);
      return;
    }
    
    if (account.callId) {
      // Use call ID for specific hangup
      console.log(`Hanging up call with ID: ${account.callId}`);
      const result = await sendCommand('hangup', account.callId);
      console.log('Hangup result:', result);
    } else {
      // Fallback to account-based hangup
      console.log('No call ID found, using uafind + hangup');
      const findResult = await sendCommand('uafind', uri);
      console.log('Account find result:', findResult);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const result = await sendCommand('hangup');
      console.log('Hangup result:', result);
    }
    
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
