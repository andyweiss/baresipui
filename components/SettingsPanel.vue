<template>
  <div class="bg-gray-800 rounded-lg shadow-lg p-6">
    <!-- System Information -->
    <div class="mb-8">
      <h3 class="text-lg font-semibold text-white mb-4">System Information</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="p-4 bg-gray-700 rounded-lg">
          <p class="text-white font-medium">Baresip Info</p>
          <p class="text-sm text-gray-400">
            Version: {{ baresipInfo.version ?? '...' }}<br>
            Uptime: {{ baresipInfo.uptime ?? '...' }}<br>
            Started: {{ baresipInfo.started ?? '...' }}
          </p>
        </div>
        <div class="p-4 bg-gray-700 rounded-lg">
          <p class="text-white font-medium">UI Info</p>
          <p class="text-sm text-gray-400">
            Version: {{ uiVersion }}
          </p>
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
            </div>
          </div>
        </div>
      </div>
      <!-- Account Management Section -->
      <div class="border-b border-gray-700 pb-6">
        <h3 class="text-lg font-semibold text-white mb-4">Account Management</h3>
        <AccountsManager />
      </div>
      <TalktomeBridgeManager
        v-if="talktomeBridgeEnabled"
        :accounts="props.accounts"
        :global-status="props.talktomeBridgeGlobalStatus"
        :statuses="props.talktomeBridgeStatuses"
      />
      <!-- Contact Management Section -->
      <div class="border-b border-gray-700 pb-6">
        <h3 class="text-lg font-semibold text-white mb-4">Contact Management</h3>
        <ContactsManager />
      </div>
      <!-- Audio Codec Settings -->
      <div class="border-b border-gray-700 pb-6">
        <h3 class="text-lg font-semibold text-white mb-4">Audio Settings</h3>
        <div class="space-y-4">
          <div class="p-4 bg-gray-700 rounded-lg">
            <h4 class="text-white font-medium mb-2">Default Audio Codecs</h4>
            <p class="text-sm text-gray-400 mb-4">Configure default audio codec preferences</p>
            <div class="text-sm text-gray-500">
              This feature is available in a future update, please edit config files manually for now
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  Account,
  TalktomeBridgeGlobalStatus,
  TalktomeBridgeStatus,
} from '~/types';

const props = defineProps<{
  reloadConfig: () => void,
  sendCommand?: (cmd: string) => Promise<any>,
  accounts: Account[],
  talktomeBridgeGlobalStatus: TalktomeBridgeGlobalStatus | null,
  talktomeBridgeStatuses: TalktomeBridgeStatus[],
}>();

const baresipInfo = ref<{ version?: string; uptime?: string; started?: string }>({});

const uiVersion = ref<string>('loading...');
const runtimeConfig = useRuntimeConfig();
const talktomeBridgeEnabled = runtimeFlagEnabled(
  runtimeConfig.public.talktomeBridgeEnabled,
);

function runtimeFlagEnabled(value: unknown): boolean {
  return value === true ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

// Load version from /version.js at runtime
onMounted(async () => {
  try {
    const response = await fetch('/version.js');
    if (response.ok) {
      uiVersion.value = (await response.text()).trim() || 'unknown';
    } else {
      uiVersion.value = 'dev';
    }
  } catch (e) {
    uiVersion.value = 'dev';
  }
});

async function fetchBaresipInfo() {
  if (props.sendCommand) {
    try {
      const result = await props.sendCommand('sysinfo');
      baresipInfo.value = result ?? {};
    } catch (err) {
      baresipInfo.value = { version: 'Error', uptime: 'Error', started: 'Error' };
    }
  } else {
    baresipInfo.value = { version: 'unavailable', uptime: 'unavailable', started: 'unavailable' };
  }
}

onMounted(fetchBaresipInfo);
onActivated(fetchBaresipInfo);
defineExpose({ fetchBaresipInfo });


</script>
