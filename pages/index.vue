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
            @register="handleRegister"
            @call="handleCall"
            @hangup="handleHangup"
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
            @toggle="handleToggleAutoConnect"
          />
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
const { connected, accounts, contacts, sendCommand, toggleAutoConnect } = useWebSocket();

const handleRegister = async (uri: string) => {
  try {
    await sendCommand(`/ua ${uri} register`);
  } catch (err) {
    console.error('Failed to register:', err);
  }
};

const handleCall = async (uri: string) => {
  const target = prompt('Enter SIP URI to call:');
  if (target) {
    try {
      await sendCommand(`/dial ${target}`);
    } catch (err) {
      console.error('Failed to call:', err);
    }
  }
};

const handleHangup = async (uri: string) => {
  try {
    await sendCommand('/hangup');
  } catch (err) {
    console.error('Failed to hangup:', err);
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
