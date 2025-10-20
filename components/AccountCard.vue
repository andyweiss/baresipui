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
          {{ account.registered ? 'Registered' : 'Unregistered' }}
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

    <div class="flex gap-2 mt-4 pt-4 border-t border-gray-700">
      <button
        @click="$emit('register', account.uri)"
        class="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 transition"
      >
        Register
      </button>
      <button
        @click="$emit('call', account.uri)"
        class="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 transition"
      >
        Call
      </button>
      <button
        @click="$emit('hangup', account.uri)"
        class="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700 transition"
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

defineEmits(['register', 'call', 'hangup']);

const accountName = computed(() => {
  const match = props.account.uri?.match(/^sip:([^@]+)/);
  return match ? match[1] : props.account.uri;
});

const borderColor = computed(() => {
  if (props.account.callStatus === 'In Call') return 'border-green-500';
  if (props.account.callStatus === 'Ringing') return 'border-yellow-500';
  if (props.account.registered) return 'border-blue-500';
  return 'border-gray-300';
});

const statusColor = computed(() => {
  return props.account.registered
    ? 'bg-green-900 text-green-300'
    : 'bg-gray-700 text-gray-300';
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
