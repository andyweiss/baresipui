<template>
  <div 
    v-if="show"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
    @click.self.stop
  >
    <div class="bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4 border border-gray-700 relative">
      <!-- Header -->
      <div class="flex items-start justify-between mb-4">
        <button 
          class="absolute top-2 right-2 bg-gray-700 text-xs text-white px-2 py-1 rounded hover:bg-gray-600 z-20"
          @click.stop
        >DEBUG STICKY</button>
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
          <p class="text-sm font-medium text-white font-mono">{{ call && call.remoteUri ? formatUri(call.remoteUri) : '' }}</p>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">State</p>
            <p class="text-sm font-medium" :class="stateColor">{{ call && call.state ? call.state : '' }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Direction</p>
            <p class="text-sm font-medium text-white capitalize">{{ call && call.direction ? call.direction : '' }}</p>
          </div>
        </div>


        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">duration</p>
            <p class="text-sm font-medium text-white">{{ call ? formattedDuration : '' }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Active Audio Codec</p>
            <p class="text-sm font-medium text-white">
              <span v-if="call && typeof call.audioCodec === 'string'">{{ call.audioCodec }}</span>
              <span v-else-if="call && call.audioCodec && typeof call.audioCodec === 'object'">{{ formatCodecDisplay(call.audioCodec) }}</span>
              <span v-else class="text-gray-500 italic">No codec info</span>
            </p>
          </div>
        </div>



        <div>
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Started</p>
          <p class="text-sm font-medium text-white">{{ call && call.startTime ? formatDateTime(call.startTime) : '' }}</p>
        </div>

        <!-- Audio RX Statistics -->
        <div v-if="call && call.audioRxStats" class="bg-gray-900 rounded p-3">
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
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import type { CallInfo } from '~/types';

const formatCodecDisplay = (codec: any) => {
  if (!codec || typeof codec !== 'object') return '';
  const name = codec.codec || '';
  const rate = codec.sampleRate ? `${codec.sampleRate / 1000}kHz` : '';
  const channels = codec.channels === 2 ? 'stereo' : codec.channels === 1 ? 'mono' : codec.channels;
  let bitrate = '';
  if (codec.params && codec.params.maxaveragebitrate) {
    const num = Number(codec.params.maxaveragebitrate);
    if (!isNaN(num)) {
      if (num >= 1000000) bitrate = `${(num / 1000000).toFixed(1)}Mbit/s`;
      else if (num >= 1000) bitrate = `${(num / 1000).toFixed(0)}kbit/s`;
      else bitrate = `${num}bit/s`;
    }
  }
  return [name, rate, channels, bitrate].filter(Boolean).join(' ');
};

const props = defineProps<{
  show: boolean;
  call?: CallInfo;
}>();

defineEmits(['close']);

const currentTime = ref(Date.now());
let intervalId: ReturnType<typeof setInterval> | null = null;

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
  switch (props.call?.state) {
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
  const baseTime = props.call?.answerTime || props.call?.startTime;
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
