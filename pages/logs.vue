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
          class="bg-black rounded p-4 h-[calc(100vh-280px)] overflow-y-auto font-mono text-sm"
        >
          <div v-if="logs.length === 0" class="text-gray-500 text-center py-8">
            Waiting for events...
          </div>
          <div
            v-for="(log, index) in logs"
            :key="index"
            class="py-1 border-b border-gray-800 hover:bg-gray-900"
          >
            <span class="text-gray-500 text-xs mr-3">{{ formatTime(log.timestamp) }}</span>
            <span v-html="highlightKeywords(log.message)"></span>
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
  return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false });
};

const highlightKeywords = (message: string) => {
  const keywords = {
    'CALL': 'text-green-400',
    'REGISTER': 'text-blue-400',
    'ONLINE': 'text-green-400',
    'ERROR': 'text-red-400',
    'FAILED': 'text-red-400',
    'established': 'text-green-400',
    'terminated': 'text-yellow-400',
    'ringing': 'text-yellow-400',
    'registered': 'text-blue-400'
  };

  let highlighted = message;

  for (const [keyword, color] of Object.entries(keywords)) {
    const regex = new RegExp(`(${keyword})`, 'gi');
    highlighted = highlighted.replace(regex, `<span class="${color} font-semibold">$1</span>`);
  }

  return `<span class="text-gray-300">${highlighted}</span>`;
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
