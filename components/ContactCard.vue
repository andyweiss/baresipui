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

    <!-- Actions (bottom left) + Assigned Account and Last Seen -->
    <div class="flex items-center justify-between">
      <!-- Edit/Delete actions + Assigned Account (left) -->
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2">
          <button @click="emit('edit', contact.contact)" class="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition" title="Edit contact">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>
          <button @click="emit('delete', contact.contact)" class="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition" title="Delete contact">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </div>

        <div v-if="assignedToAccount">
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Assigned to Account</p>
          <p class="text-sm font-medium text-blue-400">
            {{ getAccountName(assignedToAccount) }}
          </p>
        </div>
      </div>

      <!-- Last Seen (right) -->
      <div v-if="contact.lastSeen" class="text-right ml-4">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Last Seen</p>
        <p class="text-xs text-gray-500">{{ formatTimestamp(contact.lastSeen) }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">

const props = defineProps<{
  contact: any;
  accounts: any[];
}>();

const emit = defineEmits<{
  edit: [uri: string];
  delete: [uri: string];
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
