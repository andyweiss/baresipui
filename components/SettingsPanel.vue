<template>
    <div v-if="debugResponse" class="bg-yellow-100 text-black p-2 mb-2 rounded text-xs">
      <strong>Debug:</strong> {{ debugResponse }}
    </div>
  <div class="bg-gray-800 rounded-lg shadow-lg p-6">
    <h2 class="text-2xl font-bold text-white mb-6">⚙️ Settings</h2>
    <!-- System Information (jetzt zuoberst) -->
    <div class="mb-8">
      <h3 class="text-lg font-semibold text-white mb-4">System Information</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="p-4 bg-gray-700 rounded-lg">
          <p class="text-sm text-gray-400">Baresip Version</p>
          <p class="text-white font-mono">{{ baresipVersion }}</p>
        </div>
        <div class="p-4 bg-gray-700 rounded-lg">
          <p class="text-sm text-gray-400">UI Version</p>
          <p class="text-white font-mono">v1.0.0</p>
        </div>
      </div>
    </div>
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
            <div class="flex gap-2">
              <button 
                @click="reloadConfig"
                class="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                Reload Config
              </button>
              <button
                @click="sendTestCommand"
                class="px-4 py-2 bg-yellow-600 text-white rounded text-sm font-medium hover:bg-yellow-700 transition-colors"
              >
                Test
              </button>
            </div>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineProps, ref, onMounted } from 'vue';
const props = defineProps<{ reloadConfig: () => void, sendCommand?: (cmd: string) => Promise<any> }>();

const baresipVersion = ref('...');
const debugResponse = ref('');

async function fetchBaresipVersion() {
  if (props.sendCommand) {
    try {
      const result = await props.sendCommand('about');
      debugResponse.value = JSON.stringify(result);
      // Version direkt aus Backend übernehmen
      baresipVersion.value = result.version ?? 'unbekannt';
    } catch (err) {
      baresipVersion.value = 'Fehler';
      debugResponse.value = String(err);
    }
  } else {
    baresipVersion.value = 'nicht verfügbar';
    debugResponse.value = 'sendCommand nicht verfügbar';
  }
}

onMounted(fetchBaresipVersion);

async function sendTestCommand() {
  if (props.sendCommand) {
    try {
      await props.sendCommand('about');
    } catch (err) {
      alert('Fehler beim Senden des Kommandos: ' + (err?.message || err));
    }
  } else {
    alert('sendCommand nicht verfügbar!');
  }
}
</script>
