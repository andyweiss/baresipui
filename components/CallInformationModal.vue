<template>
  <div 
    v-if="show"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
    @click.self.stop
  >
    <div class="bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4 border border-gray-700 relative">
      <!-- Header -->
      <div class="flex items-start justify-between mb-4">
        
        <h3 class="text-lg font-semibold text-white">Call Information</h3>
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
          <p class="text-sm font-medium text-white font-mono">{{ getRemotePartyDisplayName(call) }}</p>
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
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Duration</p>
            <p class="text-sm font-medium text-white">{{ call ? formattedDuration : '' }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Started</p>
            <p class="text-sm font-medium text-white">{{ call && call.startTime ? formatDateTime(call.startTime) : '' }}</p>
          </div>
        </div>

        <!-- Audio Codecs Grid -->
        <div class="grid grid-cols-2 gap-4">
          <!-- RX Codec (Receiving from remote) -->
          <div class="relative group">
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1 flex items-center gap-1">
              RX Codec
              <span v-if="call && call.rxCodecs && call.rxCodecs.length > 1" class="text-blue-400 cursor-help">ⓘ</span>
            </p>
            <p class="text-sm font-medium text-white">
              <span v-if="call && call.rxAudioCodec">{{ formatCodecDisplay(call.rxAudioCodec) }}</span>
              <span v-else-if="call && call.audioCodec">{{ formatCodecDisplay(call.audioCodec) }}</span>
              <span v-else class="text-gray-500 italic text-xs">No info</span>
            </p>
            
            <!-- Tooltip for all offered codecs from remote -->
            <div v-if="call && call.rxCodecs && call.rxCodecs.length > 1" 
                 class="absolute bottom-full left-0 mb-2 hidden group-hover:block z-10 w-64">
              <div class="bg-gray-900 border border-gray-700 rounded p-2 shadow-xl text-xs">
                <p class="text-gray-400 font-semibold mb-1">Remote Offered Codecs:</p>
                <div class="space-y-1 max-h-32 overflow-y-auto">
                  <div v-for="(codec, idx) in call.rxCodecs" :key="idx" 
                       :class="isActiveCodec(codec, call.rxAudioCodec) ? 'text-green-400 font-semibold' : 'text-gray-300'">
                    {{ formatCodecDisplay(codec) }}
                    <span v-if="isActiveCodec(codec, call.rxAudioCodec)" class="text-green-500">← active</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- TX Codec (Sending to remote) -->
          <div class="relative group">
            <p class="text-xs text-gray-400 uppercase tracking-wide mb-1 flex items-center gap-1">
              TX Codec
              <span v-if="call && call.txCodecs && call.txCodecs.length > 1" class="text-blue-400 cursor-help">ⓘ</span>
            </p>
            <p class="text-sm font-medium text-white">
              <span v-if="call && call.txAudioCodec">{{ formatCodecDisplay(call.txAudioCodec) }}</span>
              <span v-else-if="call && call.audioCodec">{{ formatCodecDisplay(call.audioCodec) }}</span>
              <span v-else class="text-gray-500 italic text-xs">No info</span>
            </p>
            
            <!-- Tooltip for all offered codecs to remote -->
            <div v-if="call && call.txCodecs && call.txCodecs.length > 1" 
                 class="absolute bottom-full right-0 mb-2 hidden group-hover:block z-10 w-64">
              <div class="bg-gray-900 border border-gray-700 rounded p-2 shadow-xl text-xs">
                <p class="text-gray-400 font-semibold mb-1">Local Offered Codecs:</p>
                <div class="space-y-1 max-h-32 overflow-y-auto">
                  <div v-for="(codec, idx) in call.txCodecs" :key="idx" 
                       :class="isActiveCodec(codec, call.txAudioCodec) ? 'text-green-400 font-semibold' : 'text-gray-300'">
                    {{ formatCodecDisplay(codec) }}
                    <span v-if="isActiveCodec(codec, call.txAudioCodec)" class="text-green-500">← active</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Audio RX Statistics -->
        <div v-if="call && call.audioRxStats" class="bg-gray-900 rounded p-3 mb-2">
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-2">Audio RX (Incoming)</p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span class="text-gray-500">RTP Packets:</span>
              <span class="text-white ml-1">{{ call.audioRxStats.packets }}</span>
            </div>
            <div>
              <span class="text-gray-500">Packet Loss:</span>
              <span :class="call.audioRxStats.packetsLost > 0 ? 'text-red-400' : 'text-green-400'" class="ml-1">
                {{ call.audioRxStats.packetsLost }} ({{ packetLossPercent(call.audioRxStats) }}%)
              </span>
            </div>
            <div>
              <span class="text-gray-500">Bitrate:</span>
              <span class="text-white ml-1">{{ call.audioRxStats.bitrate_kbps ?? 0 }} kbit/s</span>
            </div>
            <div>
              <span class="text-gray-500">Jitter:</span>
              <span :class="jitterColor(call.audioRxStats.jitter)" class="ml-1">{{ call.audioRxStats.jitter?.toFixed(1) ?? '0.0' }} ms</span>
            </div>
            <div v-if="call.audioRxStats.rtt !== undefined && call.audioRxStats.rtt !== null">
              <span class="text-gray-500">RTT:</span>
              <span :class="call.audioRxStats.rtt > 150 ? 'text-red-400' : call.audioRxStats.rtt > 80 ? 'text-orange-400' : 'text-green-400'" class="ml-1">{{ call.audioRxStats.rtt?.toFixed(1) ?? '0.0' }} ms</span>
            </div>
            <div>
              <span class="text-gray-500">RX Errors:</span>
              <span :class="call.audioRxStats.rtp_rx_errors > 0 ? 'text-orange-400' : 'text-green-400'" class="ml-1">
                {{ call.audioRxStats.rtp_rx_errors ?? 0 }}
              </span>
            </div>
            <div>
              <span class="text-gray-500">Dropout:</span>
              <span :class="call.audioRxStats.dropout ? 'text-red-400' : 'text-green-400'" class="ml-1">
                {{ call.audioRxStats.dropout ? '⚠ YES' : '✓ No' }} <span v-if="call.audioRxStats.dropout_total" class="text-gray-500">({{ call.audioRxStats.dropout_total }})</span>
              </span>
            </div>
          </div>
        </div>

        <!-- Audio TX Statistics -->
        <div v-if="call && call.audioTxStats" class="bg-gray-900 rounded p-3">
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-2">Audio TX (Outgoing)</p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span class="text-gray-500">RTP Packets:</span>
              <span class="text-white ml-1">{{ call.audioTxStats.packets }}</span>
            </div>
            <div>
              <span class="text-gray-500">Packet Loss:</span>
              <span :class="call.audioTxStats.packetsLost > 0 ? 'text-red-400' : 'text-green-400'" class="ml-1">
                {{ call.audioTxStats.packetsLost }} ({{ packetLossPercent(call.audioTxStats) }}%)
              </span>
            </div>
            <div>
              <span class="text-gray-500">Bitrate:</span>
              <span class="text-white ml-1">{{ call.audioTxStats.bitrate_kbps ?? 0 }} kbit/s</span>
            </div>
            <div>
              <span class="text-gray-500">Jitter:</span>
              <span :class="jitterColor(call.audioTxStats.jitter)" class="ml-1">{{ call.audioTxStats.jitter?.toFixed(1) ?? '0.0' }} ms</span>
            </div>
            <div v-if="call.audioTxStats.rtp_tx_errors !== undefined">
              <span class="text-gray-500">TX Errors:</span>
              <span :class="call.audioTxStats.rtp_tx_errors > 0 ? 'text-orange-400' : 'text-green-400'" class="ml-1">
                {{ call.audioTxStats.rtp_tx_errors ?? 0 }}
              </span>
            </div>
            <div v-if="call.audioTxStats.rtcp_packets !== undefined">
              <span class="text-gray-500">RTCP Pkts:</span>
              <span class="text-white ml-1">{{ call.audioTxStats.rtcp_packets }}</span>
            </div>
            <div v-if="call.audioRxStats && call.audioRxStats.rtcp_packets !== undefined">
              <span class="text-gray-500">RTCP RX Pkts:</span>
              <span class="text-white ml-1">{{ call.audioRxStats.rtcp_packets }}</span>
            </div>
          </div>
        </div>

        <!-- Jitter Buffer Statistics -->
        <div v-if="call && call.jitterBuffer" class="bg-gray-900 rounded p-3 mt-2">
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-2">Jitter Buffer</p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span class="text-gray-500">Current:</span>
              <span class="text-white ml-1">{{ call.jitterBuffer.current }} ms</span>
            </div>
            <div>
              <span class="text-gray-500">Range:</span>
              <span class="text-white ml-1">{{ call.jitterBuffer.min }}-{{ call.jitterBuffer.max }} ms</span>
            </div>
            <div v-if="call.jitterBuffer.packets !== undefined">
              <span class="text-gray-500">Packets:</span>
              <span class="text-white ml-1">{{ call.jitterBuffer.packets }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
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

const isActiveCodec = (codec: any, activeCodec: any) => {
  if (!codec || !activeCodec) return false;
  return codec.codec === activeCodec.codec && 
         codec.sampleRate === activeCodec.sampleRate && 
         codec.channels === activeCodec.channels;
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
  let totalSeconds = Math.floor((currentTime.value - baseTime) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  totalSeconds %= 86400;
  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds %= 3600;
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  let result = '';
  if (days > 0) {
    result += `${days}d `;
  }
  if (hours > 0 || days > 0) {
    result += `${hours}:`;
  }
  result += `${mins}:${secs.toString().padStart(2, '0')}`;
  return result;
});

const getRemotePartyDisplayName = (call: CallInfo | undefined): string => {
  if (!call) return '';
  
  // Check contacts first
  // (contacts not available in modal, fall through)
  
  // For outgoing calls: always use remoteUri (dialed number), not peerName
  if (call.direction === 'outgoing' && call.remoteUri) {
    const stripped = call.remoteUri.replace(/^sip:/, '');
    const userMatch = stripped.match(/^([^@]+)@/);
    return userMatch ? userMatch[1] : stripped;
  }
  
  // Incoming: prefer peerName
  let displayValue = call.peerName || call.remoteUri;
  if (!displayValue) return 'Unknown';
  displayValue = displayValue.replace(/^sip:/, '');
  const userMatch = displayValue.match(/^([^@]+)@/);
  if (userMatch) return userMatch[1];
  return displayValue;
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

const formatDateTime = (timestamp: number) => {
  if (!timestamp) return 'N/A';
  const d = new Date(timestamp);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
};
</script>
