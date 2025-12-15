<template>
  <div class="min-h-screen bg-gray-900">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="bg-gray-800 rounded-lg shadow-lg p-6">
        <div class="flex items-center justify-between mb-6">
          <h2 class="text-2xl font-bold text-white">Baresip Logs</h2>
          <div class="flex gap-2">
            <button 
              @click="toggleAutoScroll" 
              :class="[
                'px-4 py-2 rounded text-sm font-medium transition-colors',
                autoScroll 
                  ? 'bg-green-600 text-white hover:bg-green-700' 
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              ]"
            >
              {{ autoScroll ? '✓ Auto-scroll' : 'Auto-scroll' }}
            </button>
            <button 
              @click="clearLogs" 
              class="px-4 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div>
            <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">
              Log Level
            </label>
            <div class="relative">
              <select
                v-model="filterLevel"
                class="w-full px-3 py-1.5 bg-gray-700 rounded text-sm text-white 
                       focus:outline-none appearance-none cursor-pointer transition-colors hover:bg-gray-600"
              >
                <option value="" class="bg-gray-800">All Levels</option>
                <option value="debug" class="bg-gray-800">Debug</option>
                <option value="info" class="bg-gray-800">Info</option>
                <option value="warn" class="bg-gray-800">Warnings</option>
                <option value="error" class="bg-gray-800">Errors</option>
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-400">
                <svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                  <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
                </svg>
              </div>
            </div>
          </div>

          <div>
            <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">
              Account Filter
            </label>
            <div class="relative">
              <select
                v-model="filterAccount"
                class="w-full px-3 py-1.5 bg-gray-700 rounded text-sm text-white 
                       focus:outline-none appearance-none cursor-pointer transition-colors hover:bg-gray-600"
              >
                <option value="" class="bg-gray-800">All Accounts</option>
                <option 
                  v-for="account in accounts" 
                  :key="account.uri" 
                  :value="account.uri"
                  class="bg-gray-800"
                >
                  {{ account.displayName || account.uri }}
                </option>
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-400">
                <svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                  <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
                </svg>
              </div>
            </div>
          </div>

          <div>
            <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">
              Search
            </label>
            <input 
              v-model="searchQuery" 
              type="text" 
              placeholder="Search logs..."
              class="w-full px-3 py-1.5 bg-gray-700 rounded text-sm text-white placeholder-gray-400
                     focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
            />
          </div>
        </div>

        <div 
          ref="logsContainer" 
          class="bg-gray-900 rounded border border-gray-700 overflow-y-auto font-mono text-xs"
          style="height: calc(100vh - 400px); min-height: 400px;"
        >
          <div 
            v-for="(log, index) in filteredLogs" 
            :key="`${log.timestamp}-${index}`" 
            class="px-4 py-1 border-l-2 hover:bg-gray-800 transition-colors"
            :class="logBorderColor(log.level || 'info')"
          >
            <span class="text-gray-500 mr-3">{{ formatTime(log.timestamp) }}</span>
            <span 
              class="font-semibold mr-3 inline-block w-12"
              :class="logLevelColor(log.level || 'info')"
            >
              {{ (log.level || 'info').toUpperCase() }}
            </span>
            <span class="text-blue-400 mr-3">{{ log.source || 'unknown' }}</span>
            <span v-if="log.accountUri" class="text-purple-400 mr-3 text-xs">{{ log.accountUri }}</span>
            <span class="text-gray-300">{{ log.message || '' }}</span>
          </div>
          
          <div v-if="filteredLogs.length === 0" class="flex items-center justify-center h-full text-gray-500">
            No logs to display
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { io } from 'socket.io-client';
import type { LogEntry } from '~/server/services/baresip-logger';

const logs = ref<LogEntry[]>([]);
const filterLevel = ref('');
const filterAccount = ref('');
const searchQuery = ref('');
const autoScroll = ref(true);
const logsContainer = ref<HTMLElement>();
const accounts = ref<any[]>([]);
const socket = ref<any>(null);

onMounted(async () => {
  // Connect to Socket.IO for real-time logs
  socket.value = io({
    path: '/socket.io/',
    transports: ['polling', 'websocket']
  });

  // Listen for 'log' event (emitted directly)
  socket.value.on('log', (data: LogEntry) => {
    console.log('📝 Received log event:', data);
    logs.value.push(data);
    
    // Limit buffer to 1000 entries
    if (logs.value.length > 1000) {
      logs.value.shift();
    }

    // Auto-scroll to bottom
    if (autoScroll.value) {
      nextTick(() => scrollToBottom());
    }
  });

  // Also listen for 'message' event (backward compatibility)
  socket.value.on('message', (data: any) => {
    console.log('📨 Received message event:', data);
    if (data.type === 'log' && data.data) {
      console.log('✅ Adding log to array:', data.data);
      logs.value.push(data.data);
      console.log('📊 Total logs now:', logs.value.length);
      
      if (logs.value.length > 1000) {
        logs.value.shift();
      }

      if (autoScroll.value) {
        nextTick(() => scrollToBottom());
      }
    }
  });

  socket.value.on('logsCleared', () => {
    logs.value = [];
  });

  socket.value.on('init', (data: any) => {
    accounts.value = data.accounts || [];
  });

  socket.value.on('accountUpdate', (data: any) => {
    const index = accounts.value.findIndex(a => a.uri === data.uri);
    if (index >= 0) {
      accounts.value[index] = data;
    } else {
      accounts.value.push(data);
    }
  });

  // Load initial logs
  try {
    const response = await $fetch('/api/baresip-logs', {
      query: { limit: 100 }
    });
    console.log('📥 Initial logs loaded:', response);
    if (response.success && response.logs) {
      logs.value = response.logs;
      console.log('📊 Set initial logs count:', logs.value.length);
      nextTick(() => scrollToBottom());
    }
  } catch (error) {
    console.error('Failed to load logs:', error);
  }
});

onUnmounted(() => {
  if (socket.value) {
    socket.value.disconnect();
  }
});

const filteredLogs = computed(() => {
  let filtered = logs.value;

  if (filterLevel.value) {
    filtered = filtered.filter(log => (log.level || '').toLowerCase() === filterLevel.value.toLowerCase());
  }

  if (filterAccount.value) {
    filtered = filtered.filter(log => (log.accountUri || '') === filterAccount.value);
  }

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    filtered = filtered.filter(log =>
      (log.message || '').toLowerCase().includes(query) ||
      (log.source || '').toLowerCase().includes(query) ||
      (log.accountUri || '').toLowerCase().includes(query)
    );
  }

  return filtered;
});

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
};

const logLevelColor = (level: string): string => {
  switch (level) {
    case 'debug': return 'text-blue-400';
    case 'info': return 'text-green-400';
    case 'warn': return 'text-yellow-400';
    case 'error': return 'text-red-400';
    default: return 'text-gray-400';
  }
};

const logBorderColor = (level: string): string => {
  switch (level) {
    case 'debug': return 'border-blue-500';
    case 'info': return 'border-green-500';
    case 'warn': return 'border-yellow-500';
    case 'error': return 'border-red-500';
    default: return 'border-gray-600';
  }
};

const scrollToBottom = () => {
  if (logsContainer.value) {
    logsContainer.value.scrollTop = logsContainer.value.scrollHeight;
  }
};

const toggleAutoScroll = () => {
  autoScroll.value = !autoScroll.value;
  if (autoScroll.value) {
    scrollToBottom();
  }
};

const clearLogs = async () => {
  try {
    await $fetch('/api/logs/clear', { method: 'POST' });
    logs.value = [];
  } catch (error) {
    console.error('Failed to clear logs:', error);
  }
};
</script>

