<template>
  <div class="bg-gray-800 rounded-lg shadow-lg p-6 border-l-4" :class="borderColor">
    <!-- Header with Name and Status Badge -->
    <div class="flex items-start justify-between mb-4">
      <div class="flex-1">
        <h4 class="text-lg font-bold text-white mb-1">{{ displayName }}</h4>
        <p class="text-xs text-gray-400 font-mono">{{ phoneNumber }}</p>
      </div>
      <div class="ml-4">
        <span
          class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium"
          :class="presenceStatusColor"
        >
          {{ presenceDisplay }}
        </span>
      </div>
    </div>

    <!-- Assigned Account and Last Seen -->
    <div v-if="assignedToAccount || contact.lastSeen" class="flex items-start justify-between">
      <!-- Assigned Account (left) -->
      <div v-if="assignedToAccount" class="flex-1">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Assigned to Account</p>
        <p class="text-sm font-medium text-blue-400">
          {{ getAccountName(assignedToAccount) }}
        </p>
      </div>

      <!-- Spacer wenn kein assigned account -->
      <div v-else class="flex-1"></div>

      <!-- Last Seen (right) -->
      <div v-if="contact.lastSeen" class="text-right ml-4">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Last Seen</p>
        <p class="text-xs text-gray-500">{{ formatTimestamp(contact.lastSeen) }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  contact: any;
  accounts: any[];
}>();

const displayName = computed(() => {
  if (props.contact.name && props.contact.name !== props.contact.contact) {
    return props.contact.name;
  }
  const match = props.contact.contact.match(/sip:([^@]+)@/);
  return match ? match[1] : props.contact.contact;
});

const phoneNumber = computed(() => {
  const match = props.contact.contact.match(/sip:([^@]+)@/);
  return match ? match[1] : '';
});

const assignedToAccount = computed(() => {
  // Find which account has this contact assigned
  const account = props.accounts.find(a => a.autoConnectContact === props.contact.contact);
  return account?.uri;
});

const getAccountName = (uri: string) => {
  const match = uri.match(/sip:([^@]+)@/);
  return match ? match[1] : uri;
};


const borderColor = computed(() => {
  const presence = props.contact.presence?.toLowerCase() || 'unknown';
  if (presence === 'online') return 'border-blue-500';
  if (presence === 'busy') return 'border-green-500';
  if (presence === 'away') return 'border-yellow-500';
  return 'border-gray-300';
});

const presenceStatusColor = computed(() => {
  const presence = props.contact.presence?.toLowerCase() || 'unknown';
  if (presence === 'online') return 'bg-blue-900 text-blue-300';
  if (presence === 'busy') return 'bg-green-900 text-green-300';
  if (presence === 'away') return 'bg-yellow-900 text-yellow-300';
  if (presence === 'offline') return 'bg-gray-700 text-gray-300';
  return 'bg-gray-700 text-gray-400'; // unknown
});

const presenceDisplay = computed(() => {
  const presence = props.contact.presence?.toLowerCase() || 'unknown';
  if (presence === 'busy') return 'CONNECTED';
  return (presence || 'unknown').toUpperCase();
});

const autoConnectColor = computed(() => {
  const status = props.contact.status || 'Off';
  if (status === 'Connected') return 'text-green-400';
  if (status === 'Connecting') return 'text-blue-400';
  if (status === 'Failed') return 'text-red-400';
  return 'text-gray-300';
});

const formatTimestamp = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} d ago`;
  if (hours > 0) return `${hours} h ago`;
  if (minutes > 0) return `${minutes} min ago`;
  return 'just now';
};
</script>
