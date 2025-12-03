<template>
  <div class="bg-gray-800 rounded-lg shadow-lg p-6 border-l-4" :class="borderColor">
    <div class="flex items-start justify-between mb-4">
      <div class="flex-1">
        <h3 class="text-lg font-semibold text-white mb-1">{{ account.displayName || accountName }}</h3>
        <p class="text-sm text-gray-400 font-mono">{{ accountName }}</p>
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
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Auto-Connect Status</p>
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

    <!-- Auto-Connect Contact Selection (only for registered accounts) -->
    <div v-if="account.registered" class="mt-4 p-4 bg-gray-750 rounded-lg border border-gray-700">
      <label class="block text-xs font-medium text-gray-300 uppercase tracking-wide mb-2">
        Select Auto-Connect Contact
      </label>
      <div class="relative">
        <select
          :value="account.autoConnectContact || ''"
          @change="handleContactChange"
          @input="handleContactChange"
          class="w-full px-4 py-2.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white 
                 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                 appearance-none cursor-pointer transition-colors hover:bg-gray-650"
        >
          <option value="" class="bg-gray-800">🔴 Auto-Connect OFF</option>
          <option 
            v-for="contact in contacts" 
            :key="contact.contact" 
            :value="contact.contact"
            class="bg-gray-800"
            @click="console.log('Option clicked:', contact.contact)"
          >
            🟢 {{ getContactDisplayName(contact) }}
          </option>
        </select>
        <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-400">
          <svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
            <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
          </svg>
        </div>
      </div>
      <p v-if="account.autoConnectContact" class="mt-2 text-xs text-green-400">
        🟢 Auto-Connect ON: {{ getContactDisplayName(getContactByUri(account.autoConnectContact)) }}
      </p>
      <p v-else class="mt-2 text-xs text-gray-400">
        🔴 Auto-Connect OFF
      </p>
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
  contacts: any[];
}>();

const emit = defineEmits(['call', 'hangup', 'assignContact']);

const handleContactChange = (event: Event) => {
  const target = event.target as HTMLSelectElement;
  const contactUri = target.value;
  console.log('🔥 Contact changed:', contactUri, 'for account:', props.account.uri);
  console.log('🔥 Event type:', event.type);
  console.log('🔥 Emitting assignContact event...');
  emit('assignContact', props.account.uri, contactUri);
  console.log('🔥 Event emitted!');
};

const accountName = computed(() => {
  const match = props.account.uri?.match(/^sip:([^@]+)/);
  return match ? match[1] : props.account.uri;
});

const getContactDisplayName = (contact: any) => {
  if (!contact) return '';
  if (contact.name && contact.name !== contact.contact) {
    return contact.name;
  }
  const match = contact.contact.match(/sip:([^@]+)@/);
  return match ? match[1] : contact.contact;
};

const getContactByUri = (uri: string) => {
  return props.contacts.find(c => c.contact === uri);
};

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
