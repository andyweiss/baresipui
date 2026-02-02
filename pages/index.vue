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
import { ref, watch, onMounted } from 'vue';
import SettingsPanel from '@/components/SettingsPanel.vue';
import { useSocketIO } from '@/composables/useSocketIO';

// Use Socket.IO instead of WebSocket
const { connected, accounts, contacts, calls, sendCommand, toggleAutoConnect } = useSocketIO();

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
  // AutoConnect-Zuweisung an Backend senden
  try {
    await fetch('/api/autoconnect/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountUri, contact: contactUri })
    });
    // Nach erfolgreicher Zuweisung: UI wird durch Socket-Event aktualisiert
  } catch (err: any) {
    alert('Fehler bei AutoConnect-Zuweisung: ' + (err?.message || err));
  }
};

const handleCall = async (accountUri: string) => {
  const input = prompt('Zielnummer oder SIP-Adresse wählen:', '');
  if (!input) return;
  let target = input.trim();
  // Wenn keine SIP-URI, dann Domain aus Account extrahieren
  if (!target.startsWith('sip:')) {
    const match = accountUri.match(/^sip:[^@]+@(.+)$/);
    const domain = match ? match[1] : '';
    if (domain) {
      target = `sip:${target}@${domain}`;
    }
  }
  try {
    await sendCommand('dial', { accountUri, target });
  } catch (err: any) {
    alert('Fehler beim Wählen: ' + (err?.message || err));
  }
};

const handleHangup = async (accountUri: string) => {
  try {
    await sendCommand('hangup', { accountUri });
  } catch (err: any) {
    alert('Fehler beim Auflegen: ' + (err?.message || err));
  }
};

const handleToggleAutoConnect = async (contact: string, enabled: boolean) => {
  // ...existing code...
};

const reloadConfig = async () => {
  // ...existing code...
};
</script>
