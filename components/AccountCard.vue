<template>
  <div class="bg-gray-800 rounded-lg shadow-lg py-6 pl-6 pr-[4.5rem] border-l-4 relative" :class="borderColor">
    <!-- VU Meters — vertical bars on right side (only visible during call) -->
    <div v-if="hasActiveCall && audioMeter" class="absolute top-3 right-3 bottom-12 flex flex-col items-center gap-0.5 z-10">
      <!-- TX group -->
      <div class="flex gap-0.5 flex-1 min-h-0">
        <div class="flex flex-col items-center gap-0.5 flex-1">
          <span class="text-[7px] text-gray-500 leading-none">L</span>
          <div class="flex-1 w-2"><VuMeterBar :level="audioMeter?.txL ?? -96" vertical :show-scale="hasActiveCall && !!audioMeter" /></div>
        </div>
        <div class="flex flex-col items-center gap-0.5 flex-1">
          <span class="text-[7px] text-gray-500 leading-none">R</span>
          <div class="flex-1 w-2"><VuMeterBar :level="audioMeter?.txR ?? -96" vertical :show-scale="hasActiveCall && !!audioMeter" /></div>
        </div>
        <!-- Scale labels (only during call) -->
        <div v-if="hasActiveCall && audioMeter" class="flex flex-col gap-0.5">
          <span class="text-[7px] leading-none invisible">·</span>
          <div class="flex-1 relative w-5">
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 95%; transform: translateY(50%)">-3</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 85%; transform: translateY(50%)">-9</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 70%; transform: translateY(50%)">-18</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 50%; transform: translateY(50%)">-30</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 30%; transform: translateY(50%)">-42</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 10%; transform: translateY(50%)">-54</span>
          </div>
        </div>
      </div>
      <!-- TX label centered under the two bars -->
      <div class="flex">
        <div class="w-2"></div><div class="w-0.5"></div><div class="w-2"></div>
        <div class="flex items-center justify-center" style="width: calc(0.5rem + 4px);">
        </div>
      </div>
      <span class="text-[8px] text-gray-500 uppercase leading-none" style="margin-right: auto; padding-left: 1px;">TX</span>
      <!-- RX group -->
      <div class="flex gap-0.5 flex-1 min-h-0">
        <div class="flex flex-col items-center gap-0.5 flex-1">
          <span class="text-[7px] text-gray-500 leading-none">L</span>
          <div class="flex-1 w-2"><VuMeterBar :level="audioMeter?.rxL ?? -96" vertical :show-scale="hasActiveCall && !!audioMeter" /></div>
        </div>
        <div class="flex flex-col items-center gap-0.5 flex-1">
          <span class="text-[7px] text-gray-500 leading-none">R</span>
          <div class="flex-1 w-2"><VuMeterBar :level="audioMeter?.rxR ?? -96" vertical :show-scale="hasActiveCall && !!audioMeter" /></div>
        </div>
        <!-- Scale labels (only during call) -->
        <div v-if="hasActiveCall && audioMeter" class="flex flex-col gap-0.5">
          <span class="text-[7px] leading-none invisible">·</span>
          <div class="flex-1 relative w-5">
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 95%; transform: translateY(50%)">-3</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 85%; transform: translateY(50%)">-9</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 70%; transform: translateY(50%)">-18</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 50%; transform: translateY(50%)">-30</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 30%; transform: translateY(50%)">-42</span>
            <span class="absolute left-0.5 text-[7px] text-gray-500 leading-none whitespace-nowrap" style="bottom: 10%; transform: translateY(50%)">-54</span>
          </div>
        </div>
      </div>
      <!-- RX label centered under the two bars -->
      <span class="text-[8px] text-gray-500 uppercase leading-none" style="margin-right: auto; padding-left: 1px;">RX</span>
    </div>

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

    <div class="grid grid-cols-2 gap-4 mb-1 relative">
      <div class="relative">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Call Status</p>
        <p class="text-sm font-medium"
           :class="activeCalls.length > 0 ? callStatusColorForCall(activeCalls[0]) : callStatusColor">
          {{ activeCalls.length > 0 ? extraCallStateLabel(activeCalls[0]) : (account.callStatus || 'Idle') }}
        </p>
      </div>

      <div class="relative">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Connected To</p>
        <p class="text-sm font-medium"
           :class="activeCalls.length > 0 ? callStatusColorForCall(activeCalls[0]) : autoConnectDisplayColor">
          {{ activeCalls.length > 0 ? getRemotePartyDisplayName(activeCalls[0]) : getAutoConnectDisplayText() }}
        </p>
      </div>

      <!-- Connection line with arrows in the gap between columns (first/primary call) -->
      <div v-if="showConnectionLine"
           class="absolute top-[70%] flex items-center pointer-events-none" style="width: 5.5rem; left: calc(50% - 5.5rem);">
        <svg class="w-2 h-2 text-green-400 flex-shrink-0" viewBox="0 0 10 10" fill="currentColor">
          <path d="M 0 5 L 10 0 L 10 10 Z"/>
        </svg>
        <div class="flex-1 h-px bg-green-400"></div>
        <svg class="w-2 h-2 text-green-400 flex-shrink-0" viewBox="0 0 10 10" fill="currentColor">
          <path d="M 10 5 L 0 0 L 0 10 Z"/>
        </svg>
      </div>
    </div>

    <!-- Extra calls (2nd, 3rd, …): same layout as primary, no labels, green -->
    <div
      v-for="call in activeCalls.slice(1)"
      :key="call.callId"
      class="grid grid-cols-2 gap-4 mt-2 relative"
    >
      <div>
        <p class="text-sm font-medium text-green-400">{{ extraCallStateLabel(call) }}</p>
      </div>

      <div>
        <p class="text-sm font-medium text-green-400">{{ getRemotePartyDisplayName(call) }}</p>
      </div>

      <!-- Connection line (green) between the two columns -->
      <div class="absolute top-1/2 -translate-y-1/2 flex items-center pointer-events-none" style="width: 5.5rem; left: calc(50% - 5.5rem);">
        <svg class="w-2 h-2 text-green-400 flex-shrink-0" viewBox="0 0 10 10" fill="currentColor">
          <path d="M 0 5 L 10 0 L 10 10 Z"/>
        </svg>
        <div class="flex-1 h-px bg-green-400"></div>
        <svg class="w-2 h-2 text-green-400 flex-shrink-0" viewBox="0 0 10 10" fill="currentColor">
          <path d="M 10 5 L 0 0 L 0 10 Z"/>
        </svg>
      </div>
    </div>

    <div class="mb-3"></div>

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
          @click="showDialModal = true"
          :disabled="!account.registered || hasActiveCall"
          :class="callButtonClass"
        >
          Call
        </button>
        <button
          @click="handleHangupClick"
          :disabled="!account.registered || !hasActiveCall"
          :class="hangupButtonClass"
        >
          Hangup
        </button>
      </div>
    </div>

    <div class="mt-3 text-xs text-gray-500">
      Last update: {{ formatTimestamp(account.lastEvent) }}
    </div>

    <!-- GPIO Button - Always visible -->
    <button 
      @click="showGpioModal = true"
      class="absolute bottom-3 right-12 bg-gray-600 hover:bg-gray-500 text-white rounded-full p-1.5 shadow transition-all hover:scale-110 z-10"
      title="GPIO Control"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <!-- left terminal dot -->
        <circle cx="4" cy="17" r="2" fill="currentColor" />
        <!-- right terminal dot -->
        <circle cx="20" cy="17" r="2" fill="currentColor" />
        <!-- switch lever (open position) -->
        <line x1="6" y1="17" x2="18" y2="7" />
        <!-- wire from right dot -->
        <line x1="18" y1="17" x2="20" y2="17" />
      </svg>
    </button>

    <!-- Call Stats Button - Bottom Right -->
    <button 
      @click="showCallStats = true"
      class="absolute bottom-3 right-3 bg-gray-600 hover:bg-gray-500 text-white rounded-full p-1.5 shadow transition-all hover:scale-110 z-10"
      title="Call statistics"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </button>

    <!-- Call Information Modal -->
    <CallInformationModal 
      :show="showCallStats"
      :call="activeCall"
      @close="showCallStats = false"
    />

    <!-- Dial Modal -->
    <DialModal
      :show="showDialModal"
      :account-uri="account.uri"
      :contacts="contacts"
      @close="showDialModal = false"
      @dial="handleDial"
    />

    <!-- GPIO Modal -->
    <GpioModal
      :show="showGpioModal"
      :account-uri="account.uri"
      :gpio-state="gpioState"
      @close="showGpioModal = false"
      @toggle-gpio="(idx: number, state: boolean) => emit('toggleGpio', account.uri, idx, state)"
    />

    <!-- Hangup Selection Modal (only shown when multiple active calls) -->
    <Teleport to="body">
      <div
        v-if="showHangupModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        @click.self="showHangupModal = false"
      >
        <div class="bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl border border-gray-700">
          <h3 class="text-base font-semibold text-white mb-1">Anruf beenden</h3>
          <p class="text-xs text-gray-400 mb-4">Wähle den Anruf, der beendet werden soll:</p>
          <div class="space-y-2">
            <button
              v-for="call in activeCalls"
              :key="call.callId"
              @click="handleHangupCall(call)"
              class="w-full text-left px-4 py-3 bg-gray-700 hover:bg-red-900/60 border border-gray-600 hover:border-red-700 rounded-lg transition flex items-center justify-between group"
            >
              <div>
                <p class="text-sm font-medium text-white">{{ getRemotePartyDisplayName(call) }}</p>
                <p class="text-xs text-gray-400 mt-0.5">
                  {{ call.direction === 'incoming' ? 'Eingehend' : 'Ausgehend' }} · {{ extraCallStateLabel(call) }}
                </p>
              </div>
              <span class="text-xs font-medium text-red-400 group-hover:text-red-300">Beenden</span>
            </button>
          </div>
          <button
            @click="showHangupModal = false"
            class="mt-4 w-full px-4 py-2 bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600 transition text-sm"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">

import type { CallInfo, GpioState, AudioMeter } from '~/types';
import { createDefaultGpioState } from '~/types';

const props = defineProps({
  account: { type: Object, required: true },
  contacts: { type: Array, required: true },
  calls: { type: Array, required: true },
  gpioState: { type: Object as () => GpioState, default: () => createDefaultGpioState('') },
  audioMeter: { type: Object as () => AudioMeter | undefined, default: undefined },
});

const emit = defineEmits(['call', 'hangup', 'assignContact', 'toggleGpio']);

const showCallStats = ref(false);
const showDialModal = ref(false);
const showGpioModal = ref(false);
const showHangupModal = ref(false);

// Local state for the select to prevent jumping back
const localAutoConnectContact = ref(props.account.autoConnectContact || '');

// Watch for external changes (from backend)
watch(() => props.account.autoConnectContact, (newValue) => {
  localAutoConnectContact.value = newValue || '';
}, { immediate: true });

const activeCalls = computed(() => {
  const accountUri = String(props.account?.uri ?? '').toLowerCase().trim();
  if (!accountUri) return [];
  const calls = (props.calls as any[]).filter(call =>
    call.localUri && String(call.localUri).toLowerCase().trim() === accountUri &&
    call.state !== 'Closing' && call.state !== 'Closed'
  );
  // Primary call (account.callId) always first so row-1 matches getAutoConnectDisplayText()
  if (props.account.callId) {
    calls.sort((a: any, b: any) => {
      if (a.callId === props.account.callId) return -1;
      if (b.callId === props.account.callId) return 1;
      return 0;
    });
  }
  return calls;
});

const activeCall = computed(() => {
  if (!props.account?.uri) return undefined;
  const accountUri = String(props.account.uri).toLowerCase().trim();
  // 1. search by callId — don't filter by state, account.callStatus is authoritative
  if (props.account.callId) {
    const byId = (props.calls as any[]).find(call => call.callId === props.account.callId);
    if (byId) return byId;
  }
  // 2. fallback: search by localUri for any non-closed call
  const byUri = (props.calls as any[]).find(call =>
    call.localUri && String(call.localUri).toLowerCase().trim() === accountUri &&
    call.state !== 'Closing' && call.state !== 'Closed'
  );
  return byUri;
});


// button and modal visibility according to active call
const hasActiveCall = computed(() => {
  return activeCalls.value.length > 0;
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
  
  // During ringing, name is not yet reliable — caller handles display separately
  if (call.state === 'Ringing') {
    return call.direction === 'incoming' ? 'Incoming...' : 'Calling...';
  }
  
  // Check if remoteUri matches a known contact → use contact display name
  if (call.remoteUri) {
    const uri = call.remoteUri.replace(/^sip:/, '').toLowerCase();
    const contact = props.contacts.find((c: any) => {
      const contactUri = String(c.contact || '').replace(/^sip:/, '').toLowerCase();
      return contactUri === uri || contactUri === uri.split('@')[0];
    });
    if (contact) return getContactDisplayName(contact);
  }
  
  // For outgoing calls not in contacts: always show the dialed number from remoteUri
  if (call.direction === 'outgoing' && call.remoteUri) {
    const stripped = call.remoteUri.replace(/^sip:/, '');
    const userMatch = stripped.match(/^([^@]+)@/);
    return userMatch ? userMatch[1] : stripped;
  }
  
  // Incoming: use display name from baresip
  if (call.peerName && call.peerName !== 'Unknown') {
    return call.peerName.replace(/^sip:/, '');
  }
  
  // Last resort: SIP username from remoteUri
  if (call.remoteUri) {
    const stripped = call.remoteUri.replace(/^sip:/, '');
    const userMatch = stripped.match(/^([^@]+)@/);
    if (userMatch) return userMatch[1];
    return stripped;
  }
  
  return '';
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
  if (!props.account.registered) {
    return `${baseClass} bg-green-600 text-white opacity-40 cursor-not-allowed`;
  }
  if (hasActiveCall.value) {
    return `${baseClass} bg-green-600 text-white opacity-40 cursor-not-allowed`;
  }
  return `${baseClass} bg-green-600 text-white hover:bg-green-700`;
});

const hangupButtonClass = computed(() => {
  const baseClass = 'px-3 py-1.5 text-xs font-medium rounded transition';
  if (!props.account.registered || !hasActiveCall.value) {
    return `${baseClass} bg-red-600 text-white opacity-40 cursor-not-allowed`;
  }
  return `${baseClass} bg-red-600 text-white hover:bg-red-700`;
});

const callStatusColor = computed(() => {
  const status = props.account.callStatus || 'Idle';
  if (status === 'In Call') return 'text-green-400';
  if (status === 'Idle') return props.account.registered ? 'text-blue-400' : 'text-gray-400';
  if (status === 'Ringing') return 'text-orange-400';
  // All other statuses (errors/call end reasons) = red
  return 'text-red-400';
});

const getAutoConnectDisplayText = () => {
  const callStatus = props.account.callStatus;
  const isInCall = callStatus === 'In Call' || callStatus === 'Ringing';

  // Active call: use account.callStatus as authority (call.state can lag behind)
  if (isInCall && activeCall.value) {
    // Ringing phase: direction-based text
    if (callStatus === 'Ringing') {
      return activeCall.value.direction === 'incoming' ? 'Incoming...' : 'Calling...';
    }
    // Established: skip call.state check, go straight to remote party resolution
    const call = activeCall.value as CallInfo;
    if (call.remoteUri) {
      const uri = call.remoteUri.replace(/^sip:/, '').toLowerCase();
      const contact = props.contacts.find((c: any) => {
        const contactUri = String(c.contact || '').replace(/^sip:/, '').toLowerCase();
        return contactUri === uri || contactUri === uri.split('@')[0];
      });
      if (contact) return getContactDisplayName(contact as any);
      const stripped = call.remoteUri.replace(/^sip:/, '');
      const userMatch = stripped.match(/^([^@]+)@/);
      return userMatch ? userMatch[1] : stripped;
    }
    if (call.peerName && call.peerName !== 'Unknown') return call.peerName.replace(/^sip:/, '');
    return '';
  }
  // In call but activeCall not yet in array — never show contact name, show generic status
  if (isInCall) {
    return callStatus === 'Ringing' ? 'Calling...' : 'In Call';
  }

  // Idle with auto-connect: show contact name + presence state
  if (localAutoConnectContact.value) {
    const contact = getContactByUri(localAutoConnectContact.value);
    if (!contact) return '';
    const name = getContactDisplayName(contact);
    const presenceMap: Record<string, string> = { online: 'Online', busy: 'Busy', open: 'Online' };
    const presenceLabel = presenceMap[contact.presence] ?? 'Offline';
    return `${name} (${presenceLabel})`;
  }

  return '';
};

const autoConnectDisplayColor = computed(() => {
  // Orange during ringing
  if (props.account.callStatus === 'Ringing') return 'text-orange-400';

  // Green for any active call (auto-connect or manual)
  if (props.account.callStatus === 'In Call') return 'text-green-400';

  // When auto-connect is configured and idle: use contact presence color
  if (localAutoConnectContact.value) {
    const contact = getContactByUri(localAutoConnectContact.value);
    if (contact) {
      if (contact.presence === 'busy') return 'text-green-400';
      if (contact.presence === 'online') return 'text-blue-400';
      return 'text-gray-400';
    }
  }

  return 'text-gray-400';
});

const showConnectionLine = computed(() => {
  if (activeCalls.value.length > 0) {
    return activeCalls.value[0].state === 'Established';
  }
  return props.account.callStatus === 'In Call';
});

const formatTimestamp = (timestamp: number) => {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleTimeString();
};

const extraCallStateLabel = (call: CallInfo): string => {
  if (call.state === 'Established') return 'In Call';
  if (call.state === 'Ringing') return call.direction === 'incoming' ? 'Incoming...' : 'Ringing...';
  return call.state ?? 'In Call';
};

const callStatusColorForCall = (call: CallInfo): string => {
  if (call.state === 'Established') return 'text-green-400';
  if (call.state === 'Ringing') return 'text-orange-400';
  return 'text-red-400';
};

const handleHangupClick = () => {
  if (activeCalls.value.length > 1) {
    showHangupModal.value = true;
  } else {
    emit('hangup', props.account.uri);
  }
};

const handleHangupCall = (call: CallInfo) => {
  showHangupModal.value = false;
  emit('hangup', props.account.uri, call.callId);
};

const handleDial = (target: string, displayName?: string) => {
  showDialModal.value = false;
  emit('call', props.account.uri, target, displayName);
};
</script>
