<template>
  <div 
    v-if="show" 
    class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
    @click.self="$emit('close')"
  >
    <div class="bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4 border border-gray-700">
      <!-- Header -->
      <div class="flex items-start justify-between mb-4">
        <h3 class="text-lg font-semibold text-white">Call Statistics</h3>
        <button 
          @click="$emit('close')"
          class="text-gray-400 hover:text-white transition"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Call Info Grid -->
      <div class="space-y-3">
        <div>
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Remote URI</p>
          <p class="text-sm font-medium text-white font-mono">{{ formatUri(call.remoteUri) }}</p>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">State</p>
            <p class="text-sm font-medium" :class="stateColor">{{ call.state }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Direction</p>
            <p class="text-sm font-medium text-white capitalize">{{ call.direction }}</p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">duration</p>
            <p class="text-sm font-medium text-white">{{ formattedDuration }}</p>
          </div>
          <div v-if="call.audioCodec">
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Audio Codec</p>
            <p class="text-sm font-medium text-white">{{ call.audioCodec }}</p>
          </div>
        </div>

        <div>
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Started</p>
          <p class="text-sm font-medium text-white">{{ formatDateTime(call.startTime) }}</p>
        </div>

        <!-- Audio RX Statistics -->
        <div v-if="call.audioRxStats" class="bg-gray-900 rounded p-3">
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-2">Audio RX (Incoming)</p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span class="text-gray-500">Packets:</span>
              <span class="text-white ml-1">{{ call.audioRxStats.packets }}</span>
            </div>
            <div>
              <span class="text-gray-500">Lost:</span>
              <span :class="call.audioRxStats.packetsLost > 0 ? 'text-red-400' : 'text-green-400'" class="ml-1">
                {{ call.audioRxStats.packetsLost }} ({{ packetLossPercent(call.audioRxStats) }}%)
              </span>
            </div>
            <div>
              <span class="text-gray-500">Jitter:</span>
              <span :class="jitterColor(call.audioRxStats.jitter)" class="ml-1">
                {{ call.audioRxStats.jitter.toFixed(1) }} ms
              </span>
            </div>
            <div>
              <span class="text-gray-500">RTT:</span>
              <span class="text-white ml-1">{{ call.audioRxStats.rtt !== undefined ? call.audioRxStats.rtt.toFixed(1) : 'N/A' }} ms</span>
            </div>
            <div>
              <span class="text-gray-500">Bitrate:</span>
              <span class="text-white ml-1">{{ formatBitrate(call.audioRxStats.bitrate) }}</span>
            </div>
          </div>
        </div>

        <!-- Audio TX Statistics -->
        <div v-if="call.audioTxStats" class="bg-gray-900 rounded p-3">
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-2">Audio TX (Outgoing)</p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span class="text-gray-500">Packets:</span>
              <span class="text-white ml-1">{{ call.audioTxStats.packets }}</span>
            </div>
            <div>
              <span class="text-gray-500">Lost:</span>
              <span :class="call.audioTxStats.packetsLost > 0 ? 'text-red-400' : 'text-green-400'" class="ml-1">
                {{ call.audioTxStats.packetsLost }} ({{ packetLossPercent(call.audioTxStats) }}%)
              </span>
            </div>
            <div>
              <span class="text-gray-500">Jitter:</span>
              <span :class="jitterColor(call.audioTxStats.jitter)" class="ml-1">
                {{ call.audioTxStats.jitter !== undefined ? call.audioTxStats.jitter.toFixed(1) : 'N/A' }} ms
              </span>
            </div>
            <div>
              <span class="text-gray-500">Bitrate:</span>
              <span class="text-white ml-1">{{ formatBitrate(call.audioTxStats.bitrate) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import type { CallInfo } from '~/types';

const props = defineProps<{
  show: boolean;
  call: CallInfo;
}>();

defineEmits(['close']);

const currentTime = ref(Date.now());
let intervalId: NodeJS.Timeout | null = null;

onMounted(() => {
  intervalId = setInterval(() => {
    currentTime.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (intervalId) {
    clearInterval(intervalId);
  }
});

const stateColor = computed(() => {
  switch (props.call.state) {
    case 'Established':
      return 'text-green-400';
    case 'Ringing':
      return 'text-orange-400';
    case 'Closing':
      return 'text-red-400';
    default:
      return 'text-gray-400';
  }
});

const formattedDuration = computed(() => {
  const baseTime = props.call.answerTime || props.call.startTime;
  if (!baseTime) return '0:00';
  
  const seconds = Math.floor((currentTime.value - baseTime) / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  
  return `${mins}:${secs.toString().padStart(2, '0')}`;
});

const formatUri = (uri: string) => {
  const match = uri.match(/^sip:([^@]+@[^>]+)/);
  return match ? match[1] : uri;
};

const formatTime = (timestamp: number) => {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleTimeString();
};

const packetLossPercent = (stats: { packets: number; packetsLost: number }) => {
  if (stats.packets === 0) return 0;
  return ((stats.packetsLost / (stats.packets + stats.packetsLost)) * 100).toFixed(2);
};

const jitterColor = (jitter: number) => {
  if (jitter < 30) return 'text-green-400';
  if (jitter < 50) return 'text-orange-400';
  return 'text-red-400';
};

const formatBitrate = (bitrate: number) => {
  if (bitrate >= 1000000) return `${(bitrate / 1000000).toFixed(1)} Mbit/s`;
  if (bitrate >= 1000) return `${(bitrate / 1000).toFixed(1)} kbit/s`;
  return `${bitrate} bit/s`;
};


const formatDateTime = (timestamp: number) => {
  if (!timestamp) return 'N/A';
  const d = new Date(timestamp);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
};
</script>
