<template>
  <div class="min-h-screen bg-gray-900 relative">
    <!-- Disconnection Overlay -->
    <div 
      v-if="!baresipConnected"
      class="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center backdrop-blur-sm"
    >
      <div class="bg-gray-800 rounded-lg p-8 shadow-2xl border border-red-500 max-w-md">
        <div class="flex items-center gap-4 mb-4">
          <div class="w-4 h-4 bg-red-500 rounded-full animate-pulse"></div>
          <h2 class="text-2xl font-bold text-white">Connection Lost</h2>
        </div>
        <p class="text-gray-300 mb-4">
          Connection to Baresip server has been lost. 
          Attempting to reconnect...
        </p>
        <div class="flex justify-center">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>
      </div>
    </div>

    <header class="bg-gray-800 shadow-lg">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div class="flex items-center justify-between">
          <h1 class="text-3xl font-bold text-white">Baresip Control Dashboard</h1>
          <div class="flex items-center gap-2">
            <div
              class="w-3 h-3 rounded-full"
              :class="baresipConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'"
            ></div>
            <span class="text-sm text-gray-300">
              {{ baresipConnected ? 'Connected' : 'Disconnected' }}
            </span>
          </div>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Tab Navigation -->
      <div class="mb-6 border-b border-gray-700">
        <nav class="flex items-center" aria-label="Tabs">
          <div class="flex space-x-8 flex-1">
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
          </div>
          
          <!-- Settings Tab (Right-aligned) -->
          <button
            @click="activeTab = 'settings'"
            :class="[
              activeTab === 'settings'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300',
              'whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition flex items-center gap-2'
            ]"
            title="Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
            </svg>
            <span class="hidden sm:inline">Settings</span>
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
            :calls="calls"
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
          src="/baresip-logs"
          class="w-full bg-gray-800 rounded-lg shadow-lg"
          style="height: calc(100vh - 300px); min-height: 600px;"
        ></iframe>
      </section>

      <!-- Settings Tab -->
      <section v-show="activeTab === 'settings'">
        <div class="bg-gray-800 rounded-lg shadow-lg p-6">
          <h2 class="text-2xl font-bold text-white mb-6">⚙️ Settings</h2>
          
          <div class="space-y-6">
            <!-- Configuration Section -->
            <div class="border-b border-gray-700 pb-6">
              <h3 class="text-lg font-semibold text-white mb-4">Configuration</h3>
              
              <div class="space-y-4">
                <div class="flex items-center justify-between p-4 bg-gray-700 rounded-lg hover:bg-gray-650 transition-colors">
                  <div>
                    <h4 class="text-white font-medium">Reload Configuration</h4>
                    <p class="text-sm text-gray-400">Reload config files without restarting</p>
                  </div>
                  <button 
                    @click="reloadConfig"
                    class="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 transition-colors"
                  >
                    Reload Config
                  </button>
                </div>
              </div>
            </div>

            <!-- Account Management Section -->
            <div class="border-b border-gray-700 pb-6">
              <h3 class="text-lg font-semibold text-white mb-4">Account Management</h3>
              
              <div class="space-y-4">
                <div class="p-4 bg-gray-700 rounded-lg">
                  <h4 class="text-white font-medium mb-2">Add New Account</h4>
                  <p class="text-sm text-gray-400 mb-4">Create a new SIP account</p>
                  <button class="px-4 py-2 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700 transition-colors">
                    Add Account
                  </button>
                </div>
              </div>
            </div>

            <!-- Audio Codec Settings -->
            <div class="border-b border-gray-700 pb-6">
              <h3 class="text-lg font-semibold text-white mb-4">Audio Settings</h3>
              
              <div class="space-y-4">
                <div class="p-4 bg-gray-700 rounded-lg">
                  <h4 class="text-white font-medium mb-2">Default Audio Codecs</h4>
                  <p class="text-sm text-gray-400 mb-4">Configure default audio codec preferences</p>
                  <div class="text-sm text-gray-500">
                    Coming soon...
                  </div>
                </div>
              </div>
            </div>

            <!-- System Information -->
            <div>
              <h3 class="text-lg font-semibold text-white mb-4">System Information</h3>
              
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="p-4 bg-gray-700 rounded-lg">
                  <p class="text-sm text-gray-400">Baresip Version</p>
                  <p class="text-white font-mono">v3.16.0</p>
                </div>
                <div class="p-4 bg-gray-700 rounded-lg">
                  <p class="text-sm text-gray-400">UI Version</p>
                  <p class="text-white font-mono">v1.0.0</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

// Use Socket.IO instead of WebSocket
const { connected, baresipConnected, accounts, contacts, calls, sendCommand, toggleAutoConnect } = useSocketIO();

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
    console.log(`[HANGUP] Attempting to hangup call for account: ${uri}`);
    
    // Find the account to get its call ID
    const account = accounts.value.find(a => a.uri === uri);
    if (!account) {
      console.error('[HANGUP] Account not found:', uri);
      return;
    }
    
    console.log(`[HANGUP] Account found - URI: ${uri}, Call ID: ${account.callId}, Status: ${account.callStatus}`);
    
    // Only hangup if we have a call ID to avoid hanging up wrong call
    if (!account.callId) {
      console.log('[HANGUP] No call ID found for this account, not executing hangup to avoid affecting other calls');
      return;
    }
    
    // First select the account with uafind to ensure we're operating on the correct account
    console.log(`[HANGUP] Step 1: Selecting account: ${uri}`);
    await sendCommand('uafind', uri);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Then use call ID for specific hangup
    console.log(`[HANGUP] Step 2: Hanging up call with ID: ${account.callId} for account: ${uri}`);
    const result = await sendCommand('hangup', account.callId);
    console.log('[HANGUP] Hangup result:', result);
    
  } catch (err) {
    console.error('[HANGUP] Hangup failed:', err);
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

const reloadConfig = async () => {
  try {
    const result = await sendCommand('conf_reload');
    console.log('Config reload result:', result);
    alert('Configuration reloaded successfully!');
  } catch (err) {
    console.error('Failed to reload config:', err);
    alert(`Failed to reload config: ${err.message || err}`);
  }
};
</script>
