<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div
        v-if="show"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        @click.self="$emit('close')"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/60" @click="$emit('close')" />

        <!-- Modal -->
        <div class="relative bg-gray-800 rounded-xl shadow-2xl border border-gray-700 w-full max-w-md z-10">
          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <div>
              <h2 class="text-lg font-semibold text-white">Call</h2>
              <p class="text-xs text-gray-400 mt-0.5 font-mono">{{ accountName }}</p>
            </div>
            <button
              @click="$emit('close')"
              class="text-gray-400 hover:text-white transition p-1 rounded hover:bg-gray-700"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <!-- Tab Navigation -->
          <div class="flex border-b border-gray-700">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              @click="activeTab = tab.id"
              :class="[
                'flex-1 py-3 text-xs font-medium transition flex items-center justify-center gap-1.5',
                activeTab === tab.id
                  ? 'text-blue-400 border-b-2 border-blue-500 bg-gray-700/40'
                  : 'text-gray-400 hover:text-gray-300 hover:bg-gray-700/20'
              ]"
            >
              <span>{{ tab.label }}</span>
              <span v-if="tab.badge" class="px-1.5 py-0.5 rounded-full text-xs bg-gray-700 text-gray-300">{{ tab.badge }}</span>
            </button>
          </div>

          <!-- Tab: Manual Entry -->
          <div v-if="activeTab === 'manual'" class="p-6">
            <label class="block text-xs text-gray-400 uppercase tracking-wide mb-2">Number or SIP address</label>
            <input
              ref="manualInputRef"
              v-model="manualTarget"
              @keydown.enter="dialManual"
              type="text"
              :placeholder="inputPlaceholder"
              class="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
            />
            <p v-if="lastDialed" class="text-xs text-gray-500 mt-2">
              Last call: <span class="text-gray-400 font-mono">{{ lastDialedDisplay }}</span>
            </p>
            <button
              @click="dialManual"
              :disabled="!manualTarget.trim()"
              class="mt-4 w-full py-3 rounded-lg font-medium text-sm transition flex items-center justify-center gap-2"
              :class="manualTarget.trim() ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-gray-700 text-gray-500 cursor-not-allowed'"
            >
              <!-- Phone icon -->
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
              </svg>
              Call
            </button>
          </div>

          <!-- Tab: Contacts -->
          <div v-if="activeTab === 'contacts'" class="p-4 max-h-80 overflow-y-auto">
            <div v-if="contacts.length === 0" class="text-center py-8 text-gray-500 text-sm">
              No contacts configured
            </div>
            <div v-else class="space-y-1">
              <button
                v-for="contact in contacts"
                :key="contact.contact"
                @click="dialUri(contact.contact, getContactDisplayName(contact))"
                class="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-700 transition text-left group"
              >
                <!-- Presence dot -->
                <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="presenceColor(contact.presence)" />
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-white truncate">{{ getContactDisplayName(contact) }}</p>
                  <p class="text-xs text-gray-500 font-mono truncate">{{ contact.contact }}</p>
                </div>
                <!-- Phone icon on hover -->
                <svg class="w-4 h-4 text-green-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Tab: History -->
          <div v-if="activeTab === 'history'" class="p-4 max-h-80 overflow-y-auto">
            <div v-if="history.length === 0" class="text-center py-8 text-gray-500 text-sm">
              No calls recorded yet
            </div>
            <div v-else class="space-y-1">
              <button
                v-for="entry in history"
                :key="entry.uri"
                @click="dialUri(entry.uri, entry.displayName)"
                class="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-700 transition text-left group"
              >
                <!-- Direction icon -->
                <div class="flex-shrink-0">
                  <!-- Incoming -->
                  <svg v-if="entry.direction === 'incoming'" class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 17l-4 4m0 0l-4-4m4 4V3"/>
                  </svg>
                  <!-- Outgoing -->
                  <svg v-else class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7l4-4m0 0l4 4m-4-4v18"/>
                  </svg>
                </div>

                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-white truncate">{{ entry.displayName || extractUser(entry.uri) }}</p>
                  <p class="text-xs text-gray-500 font-mono truncate">{{ entry.uri }}</p>
                  <p class="text-xs text-gray-600 mt-0.5">{{ formatTime(entry.lastCall) }}</p>
                </div>

                <!-- Count badge -->
                <span v-if="entry.count > 1" class="flex-shrink-0 px-2 py-0.5 rounded-full text-xs bg-gray-700 text-gray-400">×{{ entry.count }}</span>

                <!-- Phone icon on hover -->
                <svg class="w-4 h-4 text-green-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                </svg>
              </button>
            </div>
          </div>

        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';

interface Contact {
  contact: string;
  name: string;
  presence?: string;
}

interface HistoryEntry {
  uri: string;
  displayName?: string;
  direction: 'incoming' | 'outgoing';
  count: number;
  lastCall: number;
}

const props = defineProps<{
  show: boolean;
  accountUri: string;
  contacts: Contact[];
}>();

const emit = defineEmits<{
  close: [];
  dial: [target: string, displayName?: string];
}>();

const activeTab = ref<'manual' | 'contacts' | 'history'>('manual');
const manualInputRef = ref<HTMLInputElement | null>(null);
const manualTarget = ref('');
const history = ref<HistoryEntry[]>([]);

const accountName = computed(() => {
  const m = props.accountUri?.match(/^sip:([^@]+)/);
  return m ? m[1] : props.accountUri;
});

const lastDialed = computed(() => history.value[0] ?? null);
const lastDialedDisplay = computed(() => {
  if (!lastDialed.value) return '';
  return lastDialed.value.displayName || extractUser(lastDialed.value.uri);
});

// placeholder shows e.g. "2070707"
const inputPlaceholder = computed(() => {
  if (history.value.length > 0) return extractUser(history.value[0].uri);
  return 'e.g. 100';
});

const tabs = computed(() => [
  { id: 'manual', label: 'Manual' },
  { id: 'contacts', label: 'Contacts', badge: props.contacts.length || undefined },
  { id: 'history', label: 'History', badge: history.value.length || undefined },
]);

// Load history when modal opens / account changes
watch([() => props.show, () => props.accountUri], async ([isOpen]) => {
  if (!isOpen) return;
  await loadHistory();
  // Pre-fill with last dialed number only (strip sip: prefix and domain)
  if (history.value.length > 0) {
    manualTarget.value = extractUser(history.value[0].uri);
  } else {
    manualTarget.value = '';
  }
  await nextTick();
  manualInputRef.value?.focus();
  manualInputRef.value?.select();
}, { immediate: true });

async function loadHistory() {
  try {
    const res = await fetch(`/api/call-history?account=${encodeURIComponent(props.accountUri)}`);
    if (res.ok) {
      const data = await res.json();
      history.value = data.history ?? [];
    }
  } catch {
    history.value = [];
  }
}

function dialManual() {
  const raw = manualTarget.value.trim();
  if (!raw) return;
  emit('dial', raw);
}

function dialUri(uri: string, displayName?: string) {
  emit('dial', uri, displayName);
}

function getContactDisplayName(contact: Contact): string {
  if (contact.name && contact.name !== contact.contact) return contact.name;
  const m = contact.contact.match(/sip:([^@]+)@/);
  return m ? m[1] : contact.contact;
}

function extractUser(uri: string): string {
  const m = uri.match(/sip:([^@]+)@/);
  return m ? m[1] : uri;
}

function presenceColor(presence?: string): string {
  if (presence === 'online') return 'bg-blue-400';
  if (presence === 'busy') return 'bg-green-400';
  return 'bg-gray-500';
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
</script>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
.modal-fade-enter-active .relative,
.modal-fade-leave-active .relative {
  transition: transform 0.2s ease;
}
.modal-fade-enter-from .relative {
  transform: scale(0.95);
}
</style>
