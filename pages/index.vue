<template>
  <div class="min-h-screen bg-gray-900">
    <!-- Disconnected Overlay -->
    <Transition name="overlay-fade">
      <div
        v-if="!connected"
        class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-900/80 backdrop-blur-sm"
      >
        <div class="flex flex-col items-center gap-6 select-none">
          <!-- Warning Icon -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="w-40 h-40 text-red-500 drop-shadow-[0_0_32px_rgba(239,68,68,0.6)]"
          >
            <path
              fill-rule="evenodd"
              d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z"
              clip-rule="evenodd"
            />
          </svg>
          <div class="text-center">
            <p class="text-2xl font-bold text-red-400 tracking-wide">connection lost</p>
            <p class="text-gray-400 mt-2 text-sm">Reconnecting to the server&hellip;</p>
          </div>
        </div>
      </div>
    </Transition>

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
        <SettingsPanel ref="settingsPanelRef" :reloadConfig="reloadConfig" :sendCommand="sendCommand" />
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { useSocketIO } from '@/composables/useSocketIO';

// Use Socket.IO instead of WebSocket
const { connected, accounts, contacts, calls, sendCommand } = useSocketIO();

// Track already-recorded call IDs to avoid duplicates
const recordedCallIds = new Set<string>();

// Watch for incoming calls becoming established → save to history
watch(calls, (newCalls) => {
  for (const call of newCalls) {
    if (
      call.direction === 'incoming' &&
      call.state === 'Established' &&
      call.callId &&
      !recordedCallIds.has(call.callId)
    ) {
      recordedCallIds.add(call.callId);
      fetch('/api/call-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountUri: call.localUri,
          remoteUri: call.remoteUri,
          direction: 'incoming',
          displayName: call.peerName,
        }),
      }).catch(() => {});
    }
  }
}, { deep: true });

// Active tab state
const activeTab = ref('accounts');
const settingsPanelRef = ref();

// On tab change: fetch baresip info for settings, and uastat + calls for accounts
watch(activeTab, (newTab) => {
  if (newTab === 'settings' && settingsPanelRef.value?.fetchBaresipInfo) {
    settingsPanelRef.value.fetchBaresipInfo();
  }
  if (newTab === 'accounts' && typeof sendCommand === 'function') {
    sendCommand('uastat');
  }
});

const handleAssignContact = async (accountUri: string, contactUri: string) => {
  // Send AutoConnect assignment to backend
  try {
    await fetch('/api/autoconnect/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountUri, contact: contactUri })
    });
    // After successful assignment: UI will be updated by socket event
  } catch (err: any) {
    alert('Error assigning AutoConnect: ' + (err?.message || err));
  }
};

const handleCall = async (accountUri: string, target: string, displayName?: string) => {
  let sipTarget = target.trim();
  // If not a SIP URI, extract domain from account and build one
  if (!sipTarget.startsWith('sip:')) {
    const match = accountUri.match(/^sip:[^@]+@(.+)$/);
    const domain = match ? match[1] : '';
    if (domain) {
      sipTarget = `sip:${sipTarget}@${domain}`;
    }
  }
  try {
    await sendCommand('dial', { accountUri, target: sipTarget });
    // Persist to call history
    await fetch('/api/call-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountUri, remoteUri: sipTarget, direction: 'outgoing', displayName }),
    });
  } catch (err: any) {
    alert('Error dialing: ' + (err?.message || err));
  }
};

const pendingHangups = new Set<string>();

const handleHangup = async (accountUri: string) => {
  // Guard against rapid double-clicks: skip if hangup already in flight for this account
  if (pendingHangups.has(accountUri)) return;
  pendingHangups.add(accountUri);
  try {
    await sendCommand('hangup', { accountUri });
  } catch (err: any) {
    alert('Error hanging up: ' + (err?.message || err));
  } finally {
    pendingHangups.delete(accountUri);
  }
};

const reloadConfig = async () => {
  try {
    await sendCommand('regall');
  } catch (err: any) {
    alert('Error reloading config: ' + (err?.message || err));
  }
};
</script>

<style scoped>
.overlay-fade-enter-active,
.overlay-fade-leave-active {
  transition: opacity 0.3s ease;
}
.overlay-fade-enter-from,
.overlay-fade-leave-to {
  opacity: 0;
}
</style>
