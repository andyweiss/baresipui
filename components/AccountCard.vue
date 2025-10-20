<template>
  <div class="bg-gray-800 rounded-lg shadow-lg p-6 border-l-4" :class="borderColor">
    <div class="flex items-start justify-between mb-4">
      <div class="flex-1">
        <h3 class="text-lg font-semibold text-white mb-1">{{ accountName }}</h3>
        <p class="text-sm text-gray-400 font-mono break-all">{{ account.uri }}</p>
      </div>
      <div class="ml-4">
        <span
          class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium"
          :class="statusColor"
        >
          {{ getStatusText() }}
        </span>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4 mb-4">
      <div>
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Call Status</p>
        <p class="text-sm font-medium" :class="callStatusColor">{{ account.callStatus || 'Idle' }}</p>
      </div>
      <div>
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Auto-Connect</p>
        <p class="text-sm font-medium" :class="autoConnectColor">
          {{ account.autoConnectStatus || 'Off' }}
        </p>
      </div>
    </div>

    <div v-if="account.registrationError && !account.registered" class="mb-4 p-2 bg-red-900/30 border border-red-700 rounded">
      <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Registration Status</p>
      <p class="text-sm font-medium text-red-400">{{ account.registrationError }}</p>
    </div>

    <div class="flex gap-2 mt-4 pt-4 border-t border-gray-700">
      <button
        @click="$emit('call', account.uri)"
        :disabled="!account.registered"
        :class="callButtonClass"
      >
        Call
      </button>
      <button
        @click="$emit('hangup', account.uri)"
        :disabled="!account.registered"
        :class="hangupButtonClass"
      >
        Hangup
      </button>
    </div>

    <div class="mt-3 text-xs text-gray-500">
      Last update: {{ formatTimestamp(account.lastEvent) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  account: any;
}>();

defineEmits(['call', 'hangup']);

const accountName = computed(() => {
  const match = props.account.uri?.match(/^sip:([^@]+)/);
  return match ? match[1] : props.account.uri;
});

const borderColor = computed(() => {
  if (props.account.callStatus === 'In Call') return 'border-green-500';
  if (props.account.callStatus === 'Ringing') return 'border-yellow-500';
  if (props.account.registered) return 'border-blue-500';
  if (props.account.configured) return 'border-yellow-400';
  return 'border-gray-300';
});

const statusColor = computed(() => {
  if (props.account.registered) {
    return 'bg-green-900 text-green-300';
  } else if (props.account.configured) {
    return 'bg-yellow-900 text-yellow-300';
  } else {
    return 'bg-gray-700 text-gray-300';
  }
});

const getStatusText = () => {
  if (props.account.registered) {
    return 'Registered';
  } else if (props.account.configured) {
    return 'Configured';
  } else {
    return 'Unregistered';
  }
};

const callButtonClass = computed(() => {
  const baseClass = 'px-3 py-1.5 text-xs font-medium rounded transition';
  if (props.account.registered) {
    return `${baseClass} bg-green-600 text-white hover:bg-green-700`;
  } else {
    return `${baseClass} bg-gray-600 text-gray-400 cursor-not-allowed`;
  }
});

const hangupButtonClass = computed(() => {
  const baseClass = 'px-3 py-1.5 text-xs font-medium rounded transition';
  if (props.account.registered) {
    return `${baseClass} bg-red-600 text-white hover:bg-red-700`;
  } else {
    return `${baseClass} bg-gray-600 text-gray-400 cursor-not-allowed`;
  }
});

const callStatusColor = computed(() => {
  const status = props.account.callStatus || 'Idle';
  if (status === 'In Call') return 'text-green-400';
  if (status === 'Ringing') return 'text-yellow-400';
  return 'text-gray-300';
});

const autoConnectColor = computed(() => {
  const status = props.account.autoConnectStatus || 'Off';
  if (status === 'Connected') return 'text-green-400';
  if (status === 'Connecting') return 'text-blue-400';
  if (status === 'Failed') return 'text-red-400';
  return 'text-gray-300';
});

const formatTimestamp = (timestamp: number) => {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleTimeString();
};
</script>
