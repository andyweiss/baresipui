<template>
  <div class="bg-gray-800 rounded-lg shadow-lg p-6 border-l-4 relative" :class="borderColor">
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

    <div class="grid grid-cols-2 gap-4 mb-4 relative">
      <div class="relative">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Call Status</p>
        <div class="flex items-center gap-2">
          <div>
            <p class="text-sm font-medium" :class="callStatusColor">{{ account.callStatus || 'Idle' }}</p>
          </div>
        </div>
      </div>
      
      <div class="relative">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Connected To</p>
        <p class="text-sm font-medium" :class="autoConnectDisplayColor">
          {{ getAutoConnectDisplayText() }}
        </p>
      </div>
      
      <!-- Connection line with arrows in the gap between columns -->
      <div v-if="showConnectionLine" 
           class="absolute top-[70%] flex items-center pointer-events-none" style="width: 5.5rem; left: calc(50% - 5.5rem);">
        <!-- Left arrow ◀ -->
        <svg class="w-2 h-2 text-green-400 flex-shrink-0" viewBox="0 0 10 10" fill="currentColor">
          <path d="M 0 5 L 10 0 L 10 10 Z"/>
        </svg>
        <!-- Connecting line -->
        <div class="flex-1 h-px bg-green-400"></div>
        <!-- Right arrow ▶  -->
        <svg class="w-2 h-2 text-green-400 flex-shrink-0" viewBox="0 0 10 10" fill="currentColor">
          <path d="M 10 5 L 0 0 L 0 10 Z"/>
        </svg>
      </div>
    </div>

    <div v-if="account.registrationError && !account.registered" class="mb-4 p-2 bg-red-900/30 border border-red-700 rounded">
      <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Registration Status</p>
      <p class="text-sm font-medium text-red-400">{{ account.registrationError }}</p>
    </div>

    <!-- Auto-Connect Contact Selection (only for registered accounts) -->
    <div v-if="account.registered" class="mt-4 flex gap-2 items-end">
      <div style="width: calc(50% + 2rem);">
        <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">
          Auto-Connect Contact
        </label>
        <div class="relative">
          <select
            v-model="localAutoConnectContact"
            @change="handleContactChange"
            class="w-full px-3 py-1.5 bg-gray-700 rounded text-sm text-white 
                   focus:outline-none appearance-none cursor-pointer transition-colors hover:bg-gray-650"
          >
            <option value="">Auto-Connect OFF</option>
            <option 
              v-for="contact in contacts" 
              :key="contact.contact" 
              :value="contact.contact"
            >
              {{ getContactDisplayName(contact) }}
            </option>
          </select>
          <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-400">
            <svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
              <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
            </svg>
          </div>
        </div>
      </div>
      
      <!-- Call and Hangup buttons -->
      <div class="flex gap-2">
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
    </div>


    <div class="mt-3 text-xs text-gray-500">
      Last update: {{ formatTimestamp(account.lastEvent) }}
    </div>

    <!-- Call Stats Button - Bottom Right -->
    <button 
      v-if="activeCall"
      @click="showCallStats = true"
      class="absolute bottom-3 right-3 bg-gray-600 hover:bg-gray-500 text-white rounded-full p-1.5 shadow transition-all hover:scale-110 z-10"
      title="Call statistics"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </button>

    <!-- Call Statistics Modal -->
    <CallStatisticsModal 
      v-if="activeCall"
      :show="showCallStats"
      :call="activeCall"
      @close="showCallStats = false"
    />
  </div>
</template>

<script setup lang="ts">

import { computed, ref, watch } from 'vue';
import type { CallInfo } from '~/types';

const props = defineProps({
  account: { type: Object, required: true },
  contacts: { type: Array, required: true },
  calls: { type: Array, required: true },
});

const emit = defineEmits(['call', 'hangup', 'assignContact']);

const showCallStats = ref(false);

// Local state for the select to prevent jumping back
const localAutoConnectContact = ref(props.account.autoConnectContact || '');

// Watch for external changes (from backend)
watch(() => props.account.autoConnectContact, (newValue) => {
  localAutoConnectContact.value = newValue || '';
}, { immediate: true });

const activeCall = computed(() => {
  if (!props.account?.uri) return undefined;
  const accountUri = String(props.account.uri).toLowerCase().trim();
  // 1. search by callId if available
  if (props.account.callId) {
    const byId = props.calls.find(call => call.callId === props.account.callId);
    if (byId && (byId.state === 'Established' || byId.state === 'Ringing')) return byId;
  }
  // 2. fallback: search by localUri
  const byUri = props.calls.find(call =>
    call.localUri && String(call.localUri).toLowerCase().trim() === accountUri &&
    (call.state === 'Established' || call.state === 'Ringing')
  );
  return byUri;
});


// button and modal visibility according to active call
const hasActiveCall = computed(() => {
  return !!activeCall.value;
});



const handleContactChange = async (event: Event) => {
  const target = event.target as HTMLSelectElement;
  const contactUri = target.value;
  
  try {
    // Send to backend
    const response = await fetch('/api/autoconnect/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        account: props.account.uri, 
        contact: contactUri === '' ? null : contactUri 
      })
    });
    
    if (response.ok) {
      // Update local state after successful backend response
      localAutoConnectContact.value = contactUri;
      emit('assignContact', props.account.uri, contactUri);
    } else {
      // Revert on error
      localAutoConnectContact.value = props.account.autoConnectContact || '';
      console.error('Failed to update autoconnect:', response.statusText);
    }
  } catch (error) {
    // Revert on error
    localAutoConnectContact.value = props.account.autoConnectContact || '';
    console.error('Error updating autoconnect:', error);
  }
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

const getRemotePartyDisplayName = (call: CallInfo): string => {
  if (!call) return '';
  
  // Extract username from remoteUri or peerName
  let displayValue = call.remoteUri || call.peerName;
  
  if (!displayValue) return 'Unknown';
  
  // Remove sip: prefix if present
  displayValue = displayValue.replace(/^sip:/, '');
  
  // Extract only the username part (before @)
  const userMatch = displayValue.match(/^([^@]+)@/);
  if (userMatch) {
    return userMatch[1];
  }
  
  // If no @ found, return as-is
  return displayValue;
};

const getContactByUri = (uri: string) => {
  return props.contacts.find(c => c.contact === uri);
};

const borderColor = computed(() => {
  const status = props.account.callStatus || 'Idle';
  if (status === 'In Call') return 'border-green-500'; // Connected = green
  if (status === 'Ringing') return 'border-orange-500';
  if (status === 'Idle') {
    return props.account.registered ? 'border-blue-500' : 'border-gray-500'; // Idle: blue if registered, else gray
  }
  return 'border-gray-500';
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
  if (status === 'In Call') return 'text-green-400'; // In Call = green
  if (status === 'Idle') return props.account.registered ? 'text-blue-400' : 'text-gray-400'; // Idle: blue if registered, else gray
  if (status === 'Ringing') return 'text-orange-400';
  return 'text-gray-400';
});

const getRightStatusText = () => {
  // If auto-connect is active and we have an active call → "Connected"
  if (localAutoConnectContact.value && activeCall.value) {
    return 'Connected';
  }
  // If no auto-connect but we have an active call → show remote party number
  if (!localAutoConnectContact.value && activeCall.value) {
    return getRemotePartyDisplayName(activeCall.value);
  }
  // If auto-connect is active but no call → show contact info
  if (localAutoConnectContact.value) {
    const contact = getContactByUri(localAutoConnectContact.value);
    if (!contact) return 'Off';
    const displayName = getContactDisplayName(contact);
    const presence = contact.presence || 'unknown';
    if (presence === 'busy') return `${displayName} (busy)`;
    if (presence === 'online') return `${displayName} (online)`;
    return displayName;
  }
  // No auto-connect, no active call
  return 'Off';
};

const getAutoConnectDisplayText = () => {
  if (!localAutoConnectContact.value) {
    // Show remote number if in active call without auto-connect
    if (activeCall.value) {
      return getRemotePartyDisplayName(activeCall.value);
    }
    return ''; // Empty instead of "Off"
  }
  const contact = getContactByUri(localAutoConnectContact.value);
  if (!contact) return '';
  return getContactDisplayName(contact);
};

const autoConnectDisplayColor = computed(() => {
  // Orange during ringing phase
  if (props.account.callStatus === 'Ringing') {
    return 'text-orange-400';
  }
  
  // Green when showing remote number (no auto-connect + active call)
  if (!localAutoConnectContact.value && activeCall.value && props.account.callStatus === 'In Call') {
    return 'text-green-400';
  }
  
  // When auto-connect is active, use contact presence colors
  if (localAutoConnectContact.value) {
    const contact = getContactByUri(localAutoConnectContact.value);
    if (contact) {
      if (contact.presence === 'busy') return 'text-green-400'; // Connected
      if (contact.presence === 'online') return 'text-blue-400'; // Online
      return 'text-gray-400'; // Offline
    }
  }
  
  // Gray for all other states
  return 'text-gray-400';
});

const showConnectionLine = computed(() => {
  // Show line when account is In Call AND the configured contact is busy
  if (props.account.callStatus !== 'In Call') return false;
  if (!localAutoConnectContact.value) return false;
  
  const contact = getContactByUri(localAutoConnectContact.value);
  if (!contact) return false;
  
  return contact.presence === 'busy';
});

const formatTimestamp = (timestamp: number) => {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleTimeString();
};
</script>
