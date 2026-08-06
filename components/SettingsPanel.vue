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
          <div class="flex items-center justify-between p-4 bg-gray-700 rounded-lg hover:bg-gray-650 transition-colors">
            <div>
              <h4 class="text-white font-medium">Restart All Calls</h4>
              <p class="text-sm text-gray-400">Hang up all active calls and redial outgoing connections</p>
            </div>
            <button
              @click="props.restartAllCalls?.()"
              :disabled="props.isRestartingCalls"
              class="px-4 py-2 bg-orange-600 text-white rounded text-sm font-medium hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <svg v-if="props.isRestartingCalls" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 5.373 0 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ props.isRestartingCalls ? 'Restarting...' : 'Restart Calls' }}
            </button>
          </div>
          <div class="p-4 bg-gray-700 rounded-lg space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <h4 class="text-white font-medium">Auto-Restart on High Jitter</h4>
                <p class="text-sm text-gray-400">Automatically restart calls when jitter buffer drops exceed the threshold</p>
              </div>
              <button
                @click="emit('update:autoRestartOnJbuf', !props.autoRestartOnJbuf)"
                :class="props.autoRestartOnJbuf ? 'bg-orange-600' : 'bg-gray-600'"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none"
              >
                <span
                  :class="props.autoRestartOnJbuf ? 'translate-x-6' : 'translate-x-1'"
                  class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                />
              </button>
            </div>
            <div class="space-y-2">
              <div class="flex justify-between text-sm">
                <span class="text-gray-400">Threshold</span>
                <span class="text-white font-medium">{{ props.jbufThreshold }} drops / 10s</span>
              </div>
              <input
                type="range"
                :value="props.jbufThreshold"
                @input="emit('update:jbufThreshold', Number(($event.target as HTMLInputElement).value))"
                min="5" max="100" step="5"
                class="w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-orange-500"
                :disabled="!props.autoRestartOnJbuf"
              />
              <div class="flex justify-between text-xs text-gray-500">
                <span>5</span><span>100</span>
              </div>
            </div>
            <div class="flex items-center gap-2 text-sm">
              <span class="text-gray-400">Current rate:</span>
              <span
                :class="{
                  'text-green-400': (props.jbufDropRate ?? 0) === 0,
                  'text-yellow-400': (props.jbufDropRate ?? 0) > 0 && (props.jbufDropRate ?? 0) < (props.jbufThreshold ?? 20),
                  'text-red-400': (props.jbufDropRate ?? 0) >= (props.jbufThreshold ?? 20),
                }"
                class="font-medium"
              >{{ props.jbufDropRate ?? 0 }} drops / 10s</span>
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
  restartAllCalls?: () => Promise<void>,
  isRestartingCalls?: boolean,
  autoRestartOnJbuf?: boolean,
  jbufThreshold?: number,
  jbufDropRate?: number,
  accounts: Account[],
  talktomeBridgeGlobalStatus: TalktomeBridgeGlobalStatus | null,
  talktomeBridgeStatuses: TalktomeBridgeStatus[],
}>();

const emit = defineEmits<{
  'update:autoRestartOnJbuf': [value: boolean],
  'update:jbufThreshold': [value: number],
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
