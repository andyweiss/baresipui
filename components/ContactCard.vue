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
          {{ (contact.presence || 'unknown').toUpperCase() }}
        </span>
      </div>
    </div>

    <!-- Assigned Account -->
    <div v-if="assignedToAccount">
      <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Assigned to Account</p>
      <p class="text-sm font-medium text-blue-400">
        {{ getAccountName(assignedToAccount) }}
      </p>
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
  if (presence === 'online') return 'border-green-500';
  if (presence === 'busy') return 'border-red-500';
  if (presence === 'away') return 'border-yellow-500';
  return 'border-gray-300';
});

const presenceStatusColor = computed(() => {
  const presence = props.contact.presence?.toLowerCase() || 'unknown';
  if (presence === 'online') return 'bg-green-900 text-green-300';
  if (presence === 'busy') return 'bg-red-900 text-red-300';
  if (presence === 'away') return 'bg-yellow-900 text-yellow-300';
  if (presence === 'offline') return 'bg-gray-700 text-gray-300';
  return 'bg-gray-700 text-gray-400'; // unknown
});

const autoConnectColor = computed(() => {
  const status = props.contact.status || 'Off';
  if (status === 'Connected') return 'text-green-400';
  if (status === 'Connecting') return 'text-blue-400';
  if (status === 'Failed') return 'text-red-400';
  return 'text-gray-300';
});
</script>
