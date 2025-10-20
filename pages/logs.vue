<template>
  <div class="min-h-screen bg-gray-900">
    <header class="bg-gray-800 shadow-lg">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            <NuxtLink
              to="/"
              class="px-4 py-2 bg-gray-700 text-white text-sm font-medium rounded hover:bg-gray-600 transition"
            >
              ← Back
            </NuxtLink>
            <h1 class="text-2xl font-bold text-white">Live Event Stream</h1>
          </div>
          <div class="flex items-center gap-4">
            <button
              @click="autoScroll = !autoScroll"
              class="px-4 py-2 text-sm font-medium rounded transition"
              :class="autoScroll
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-gray-700 text-white hover:bg-gray-600'"
            >
              Auto-Scroll: {{ autoScroll ? 'ON' : 'OFF' }}
            </button>
            <button
              @click="clearLogs"
              class="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded hover:bg-red-700 transition"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <div class="bg-gray-800 rounded-lg shadow-lg p-6">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2">
            <div
              class="w-3 h-3 rounded-full"
              :class="connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'"
            ></div>
            <span class="text-sm text-gray-400">
              {{ connected ? 'Connected' : 'Disconnected' }} • {{ logs.length }} events
            </span>
          </div>
        </div>

        <div
          ref="logContainer"
          class="bg-gray-900 rounded p-4 h-[calc(100vh-280px)] overflow-y-auto space-y-2"
        >
          <div v-if="logs.length === 0" class="text-gray-500 text-center py-8">
            Waiting for events...
          </div>
          <div
            v-for="(log, index) in logs"
            :key="index"
            class="p-3 bg-gray-800 rounded-lg border-l-4 hover:bg-gray-750 transition"
            :class="getLogBorderColor(log.message)"
          >
            <div class="flex items-start gap-3">
              <div class="flex-shrink-0 mt-0.5">
                <div class="w-2 h-2 rounded-full" :class="getLogDotColor(log.message)"></div>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs text-gray-400">{{ formatTime(log.timestamp) }}</span>
                  <span v-if="getLogType(log.message)" class="text-xs px-2 py-0.5 rounded font-medium" :class="getLogTypeClass(log.message)">
                    {{ getLogType(log.message) }}
                  </span>
                </div>
                <div class="text-sm text-gray-200 break-words">
                  {{ formatLogMessage(log.message) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

const { connected, logs } = useWebSocket();

const logContainer = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: true,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

const getLogType = (message: string) => {
  if (/call.*established|incoming call/i.test(message)) return 'CALL';
  if (/register/i.test(message)) return 'REGISTER';
  if (/error|failed/i.test(message)) return 'ERROR';
  if (/terminated|hangup/i.test(message)) return 'ENDED';
  if (/ringing/i.test(message)) return 'RINGING';
  if (/online/i.test(message)) return 'ONLINE';
  return '';
};

const getLogTypeClass = (message: string) => {
  const type = getLogType(message);
  const classes = {
    'CALL': 'bg-green-900 text-green-300',
    'REGISTER': 'bg-blue-900 text-blue-300',
    'ERROR': 'bg-red-900 text-red-300',
    'ENDED': 'bg-yellow-900 text-yellow-300',
    'RINGING': 'bg-yellow-900 text-yellow-300',
    'ONLINE': 'bg-green-900 text-green-300'
  };
  return classes[type] || 'bg-gray-700 text-gray-300';
};

const getLogBorderColor = (message: string) => {
  if (/call.*established|incoming call/i.test(message)) return 'border-green-500';
  if (/register/i.test(message)) return 'border-blue-500';
  if (/error|failed/i.test(message)) return 'border-red-500';
  if (/terminated|hangup/i.test(message)) return 'border-yellow-500';
  if (/ringing/i.test(message)) return 'border-yellow-500';
  if (/online/i.test(message)) return 'border-green-500';
  return 'border-gray-700';
};

const getLogDotColor = (message: string) => {
  if (/call.*established|incoming call/i.test(message)) return 'bg-green-500';
  if (/register/i.test(message)) return 'bg-blue-500';
  if (/error|failed/i.test(message)) return 'bg-red-500';
  if (/terminated|hangup/i.test(message)) return 'border-yellow-500';
  if (/ringing/i.test(message)) return 'bg-yellow-500';
  if (/online/i.test(message)) return 'bg-green-500';
  return 'bg-gray-500';
};

const formatLogMessage = (message: string) => {
  return message
    .replace(/\[.*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const clearLogs = () => {
  logs.value = [];
};

watch(
  () => logs.value.length,
  async () => {
    if (autoScroll.value) {
      await nextTick();
      if (logContainer.value) {
        logContainer.value.scrollTop = logContainer.value.scrollHeight;
      }
    }
  }
);
</script>
