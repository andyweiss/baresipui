<template>
  <div class="min-h-screen bg-gray-900 px-4 pt-4 pb-0">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-2xl font-bold text-white">Baresip Logs</h2>
      <div class="flex gap-2 items-center">
            <span v-if="!autoScroll && logs.length > 5000" class="text-xs text-yellow-400 mr-2">
              ⚠️ Buffer paused ({{ logs.length }} logs)
            </span>
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

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
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
              Source
            </label>
            <div class="relative">
              <select
                v-model="filterSource"
                class="w-full px-3 py-1.5 bg-gray-700 rounded text-sm text-white 
                       focus:outline-none appearance-none cursor-pointer transition-colors hover:bg-gray-600"
              >
                <option value="" class="bg-gray-800">All Sources</option>
                <option value="baresip" class="bg-gray-800">📦 Baresip</option>
                <option value="tcp-socket" class="bg-gray-800">🔌 TCP Socket</option>
                <option value="system" class="bg-gray-800">⚙️ System</option>
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
          style="height: calc(100vh - 180px); min-height: 500px;"
        >
          <div 
            v-for="(log, index) in filteredLogs" 
            :key="`${log.timestamp}-${log.source}-${index}`"
            :data-index="index" 
            class="px-4 py-2 border-l-4 hover:bg-gray-800 transition-colors"
            :class="logBorderColor(log.level || 'info')"
          >
            <div class="flex flex-wrap gap-2 items-baseline">
              <span class="text-gray-500 whitespace-nowrap text-xs font-mono">{{ formatTime(log.timestamp) }}</span>
              <span 
                class="font-bold whitespace-nowrap inline-block min-w-[3.5rem] text-xs px-1.5 py-0.5 rounded"
                :class="logLevelColor(log.level || 'info')"
              >
                {{ (log.level || 'info').toUpperCase() }}
              </span>
              <span 
                class="whitespace-nowrap text-xs font-medium px-2 py-0.5 rounded"
                :class="getSourceStyle(log.source).class"
              >
                {{ getSourceStyle(log.source).icon }} {{ log.source || 'unknown' }}
              </span>
              <span v-if="log.accountUri" class="text-purple-400 whitespace-nowrap text-xs bg-purple-900/30 px-2 py-0.5 rounded">{{ log.accountUri }}</span>
              <span class="text-gray-300 flex-1 break-words whitespace-pre-wrap text-xs leading-relaxed">{{ log.message || '' }}</span>
            </div>
          </div>
          
          <div v-if="filteredLogs.length === 0" class="flex items-center justify-center h-full text-gray-500">
            No logs to display
          </div>
        </div>
  </div>
</template>

<script setup lang="ts">
import { io } from 'socket.io-client';
import type { LogEntry } from '~/server/services/baresip-logger';

const logs = ref<LogEntry[]>([]);
const filterLevel = ref('');
const filterSource = ref('');
const filterAccount = ref('');
const searchQuery = ref('');
const autoScroll = ref(true);
const logsContainer = ref<HTMLElement>();
const accounts = ref<any[]>([]);
const socket = ref<any>(null);
const logUpdateTrigger = ref(0);

// Scroll-Position Management
let isScrolling = false;
let resizeObserver: ResizeObserver | null = null;
let previousScrollHeight = 0;

const scrollToBottom = () => {
  if (!logsContainer.value) return;
  
  isScrolling = true;
  requestAnimationFrame(() => {
    if (logsContainer.value) {
      logsContainer.value.scrollTop = logsContainer.value.scrollHeight;
      setTimeout(() => { isScrolling = false; }, 100);
    }
  });
};

const handleScroll = () => {
  if (!logsContainer.value || isScrolling) return;
  
  // Check if user has scrolled up
  const { scrollTop, scrollHeight, clientHeight } = logsContainer.value;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  
  // If more than 20px from bottom, disable auto-scroll immediately
  if (distanceFromBottom > 20 && autoScroll.value) {
    autoScroll.value = false;
  }
};

const handleNewLog = (logData: LogEntry) => {
  // Skip invalid log entries
  if (!logData || !logData.timestamp || !logData.message || logData.message.length < 2) {
    return;
  }
  
  logs.value.push(logData);
  
  // Limit buffer only when auto-scroll is ON
  // When user scrolls up (auto-scroll OFF), keep all logs
  if (autoScroll.value && logs.value.length > 5000) {
    logs.value.shift();
  }
  
  // Trigger Watch
  logUpdateTrigger.value++;
};

// Computed: Gefilterte Logs
const filteredLogs = computed(() => {
  let filtered = logs.value;

  if (filterLevel.value) {
    filtered = filtered.filter(log => (log.level || '').toLowerCase() === filterLevel.value.toLowerCase());
  }

  if (filterSource.value) {
    filtered = filtered.filter(log => (log.source || '').toLowerCase().includes(filterSource.value.toLowerCase()));
  }

  if (filterAccount.value) {
    // Extract the number from the account URI (e.g. "12345" from "sip:12345@example.com")
    const accountMatch = filterAccount.value.match(/(\d+)/);
    if (accountMatch) {
      const accountNumber = accountMatch[1];
      // Search for the number in the entire message
      filtered = filtered.filter(log => 
        (log.message || '').includes(accountNumber) ||
        (log.accountUri || '').includes(accountNumber) ||
        (log.source || '').includes(accountNumber)
      );
    } else {
      // Fallback: exact match
      filtered = filtered.filter(log => (log.accountUri || '') === filterAccount.value);
    }
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

onMounted(async () => {
  // Connect to Socket.IO for real-time logs
  socket.value = io({
    path: '/socket.io/',
    transports: ['websocket', 'polling']
  });

  socket.value.on('connect', () => {
    // Subscribe to logs room to receive live log updates
    socket.value.emit('subscribeLogs');
  });

  socket.value.on('connect_error', (_error: any) => {
    // connection error
  });

  socket.value.on('disconnect', (_reason: string) => {
    // disconnected
  });

  // Listen for historical logs (sent on subscribeLogs)
  socket.value.on('logHistory', (data: any) => {
    const entries = data.logs || [];
    for (const entry of entries) {
      handleNewLog(entry);
    }
  });

  // Listen for batched log events (live updates)
  socket.value.on('logBatch', (data: any) => {
    const entries = data.logs || [];
    for (const entry of entries) {
      handleNewLog(entry);
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

  // Load accounts from API
  try {
    const accountsResponse = await $fetch('/api/accounts');
    if (accountsResponse && Array.isArray(accountsResponse)) {
      accounts.value = accountsResponse;
    }
  } catch (error) {
    // Failed to load accounts
  }

  // Load initial logs
  try {
    const response = await $fetch('/api/baresip-logs', {
      query: { limit: 100 }
    });
    if (response.success && response.logs) {
      logs.value = response.logs;
      if (autoScroll.value) {
        nextTick(() => scrollToBottom());
      }
    }
  } catch (error) {
    // Silent error handling
  }

  // Add scroll event listener
  if (logsContainer.value) {
    logsContainer.value.addEventListener('scroll', handleScroll, { passive: true });
    
    // Setup ResizeObserver for automatic scroll adjustment
    previousScrollHeight = logsContainer.value.scrollHeight;
    
    resizeObserver = new ResizeObserver(() => {
      if (!logsContainer.value || autoScroll.value || isScrolling) return;
      
      // When auto-scroll is OFF: adjust scrollTop to keep visible position stable
      const newScrollHeight = logsContainer.value.scrollHeight;
      const heightDiff = newScrollHeight - previousScrollHeight;
      
      if (heightDiff > 0) {
        logsContainer.value.scrollTop += heightDiff;
      }
      
      previousScrollHeight = newScrollHeight;
    });
    
    resizeObserver.observe(logsContainer.value);
  }
});

onUnmounted(() => {
  if (socket.value) {
    socket.value.disconnect();
  }
  
  // Remove scroll event listener
  if (logsContainer.value) {
    logsContainer.value.removeEventListener('scroll', handleScroll);
  }
  
  // Disconnect ResizeObserver
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});

// Watch: only for auto-scroll (when ON)
watch(
  () => [filteredLogs.value.length, logUpdateTrigger.value],
  async () => {
    if (autoScroll.value && !isScrolling) {
      await nextTick();
      scrollToBottom();
    }
  }
);

const formatTime = (timestamp: number): string => {
  if (!timestamp || isNaN(timestamp)) {
    return '--:--:--,---';
  }
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return '--:--:--,---';
  }
  return date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
};

const logLevelColor = (level: string): string => {
  switch (level) {
    case 'debug': return 'bg-blue-600/80 text-blue-100';
    case 'info': return 'bg-green-600/80 text-green-100';
    case 'warn': return 'bg-yellow-600/80 text-yellow-100';
    case 'error': return 'bg-red-600/80 text-red-100';
    default: return 'bg-gray-600/80 text-gray-100';
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

const getSourceStyle = (source: string): { icon: string; class: string } => {
  if (!source) return { icon: '❓', class: 'bg-gray-700 text-gray-300' };
  
  // Baresip Container Logs
  if (source === 'baresip' || source.startsWith('baresip')) {
    return { icon: '📦', class: 'bg-blue-900/50 text-blue-300' };
  }
  
  // TCP Socket Events
  if (source === 'tcp-socket' || source.includes('socket')) {
    return { icon: '🔌', class: 'bg-purple-900/50 text-purple-300' };
  }
  
  // System/Internal Logs
  if (source === 'system' || source === 'internal') {
    return { icon: '⚙️', class: 'bg-orange-900/50 text-orange-300' };
  }
  
  // Default for other sources (e.g. specific modules)
  return { icon: '📝', class: 'bg-gray-700 text-gray-300' };
};

const toggleAutoScroll = () => {
  autoScroll.value = !autoScroll.value;
  if (autoScroll.value) {
    // When auto-scroll is re-enabled, trim buffer to 5000
    if (logs.value.length > 5000) {
      logs.value = logs.value.slice(-5000);
    }
    nextTick(() => scrollToBottom());
  }
};

const clearLogs = async () => {
  try {
    await $fetch('/api/logs/clear', { method: 'POST' });
    logs.value = [];
  } catch (error) {
    // Silent error handling
  }
};
</script>

