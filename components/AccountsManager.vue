<template>
  <div class="space-y-4">
    <!-- Pending restart banner -->
    <div v-if="pendingRestart" class="flex items-center gap-2 px-4 py-2.5 bg-yellow-900/40 border border-yellow-700 rounded-lg text-yellow-300 text-sm">
      <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
      </svg>
      Account changes will take effect after restart
    </div>

    <!-- Header -->
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium text-gray-300">Accounts</h3>
      <button @click="openAdd" class="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded transition">
        + Add
      </button>
    </div>

    <div v-if="loading" class="text-sm text-gray-500 py-4 text-center">Loading accounts…</div>
    <div v-else-if="entries.length === 0" class="text-sm text-gray-500 py-4 text-center">No accounts configured</div>

    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-xs text-gray-400 uppercase tracking-wide border-b border-gray-700">
            <th class="pb-2 text-left font-medium w-10">On</th>
            <th class="pb-2 text-left font-medium">Name</th>
            <th class="pb-2 text-left font-medium">SIP URI</th>
            <th class="pb-2 text-left font-medium hidden md:table-cell">Audio In</th>
            <th class="pb-2 text-left font-medium hidden md:table-cell">Audio Out</th>
            <th class="pb-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700/50">
          <tr v-for="entry in entries" :key="entry.uri" class="group" :class="!entry.enabled ? 'opacity-50' : ''">
            <td class="py-2.5 pr-3">
              <button @click="toggle(entry)" :disabled="toggling === entry.uri"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50"
                :class="entry.enabled ? 'bg-green-600' : 'bg-gray-600'">
                <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                  :class="entry.enabled ? 'translate-x-6' : 'translate-x-1'"/>
              </button>
            </td>
            <td class="py-2.5 pr-4 text-white font-medium">{{ entry.name }}</td>
            <td class="py-2.5 pr-4 font-mono text-gray-400 text-xs">{{ entry.uri.replace('sip:', '') }}</td>
            <td class="py-2.5 pr-4 text-gray-400 text-xs hidden md:table-cell">{{ entry.audio_source }}</td>
            <td class="py-2.5 pr-4 text-gray-400 text-xs hidden md:table-cell">{{ entry.audio_player }}</td>
            <td class="py-2.5 text-right">
              <div class="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button @click="openEdit(entry)" class="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition" title="Edit">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                  </svg>
                </button>
                <button @click="confirmDelete(entry)" class="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition" title="Delete">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                  </svg>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Add/Edit Modal -->
    <Teleport to="body">
      <div v-if="modalOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto" style="background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)">
        <div class="bg-gray-800 rounded-xl shadow-2xl border border-gray-700 w-full max-w-lg my-4">
          <div class="flex items-center justify-between p-5 border-b border-gray-700">
            <h3 class="text-base font-semibold text-white">{{ editEntry ? 'Edit account' : 'Add account' }}</h3>
            <button @click="closeModal" class="text-gray-400 hover:text-white transition">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>

          <form @submit.prevent="save" class="p-5 space-y-4">
            <!-- Name + URI -->
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">Display Name</label>
                <input v-model="form.name" type="text" required placeholder="e.g. Studio 1"
                  class="w-full px-3 py-2 bg-gray-700 rounded text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"/>
              </div>
              <div>
                <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">SIP URI</label>
                <div class="flex">
                  <span class="px-3 py-2 bg-gray-600 rounded-l text-sm text-gray-400 border-r border-gray-500 select-none">sip:</span>
                  <input v-model="form.uri" type="text" required placeholder="user@domain"
                    class="flex-1 px-3 py-2 bg-gray-700 rounded-r text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                </div>
                <p v-if="uriError" class="mt-1 text-xs text-red-400">{{ uriError }}</p>
              </div>
            </div>

            <!-- Password -->
            <div>
              <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">Password</label>
              <input v-model="form.auth_pass" type="password" placeholder="Leave empty to keep existing password"
                class="w-full px-3 py-2 bg-gray-700 rounded text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"/>
            </div>

            <!-- Audio In + Out -->
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">Audio In</label>
                <select v-model="form.audio_source" class="w-full px-3 py-2 bg-gray-700 rounded text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="">— select —</option>
                  <option v-for="iface in audioInputs" :key="iface" :value="`alsa,${iface}`">{{ iface }}</option>
                  <option v-if="form.audio_source && !audioInputs.includes(form.audio_source.replace('alsa,',''))" :value="form.audio_source">{{ form.audio_source }} (manual)</option>
                </select>
              </div>
              <div>
                <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">Audio Out</label>
                <select v-model="form.audio_player" class="w-full px-3 py-2 bg-gray-700 rounded text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="">— select —</option>
                  <option v-for="iface in audioOutputs" :key="iface" :value="`alsa,${iface}`">{{ iface }}</option>
                  <option v-if="form.audio_player && !audioOutputs.includes(form.audio_player.replace('alsa,',''))" :value="form.audio_player">{{ form.audio_player }} (manual)</option>
                </select>
              </div>
            </div>

            <!-- Answermode + Enabled -->
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">Answer Mode</label>
                <select v-model="form.answermode" class="w-full px-3 py-2 bg-gray-700 rounded text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="auto">Auto</option>
                  <option value="manual">Manual</option>
                  <option value="early">Early</option>
                </select>
              </div>
              <div class="flex items-center gap-3 pt-5">
                <label class="text-xs text-gray-400 uppercase tracking-wide">Enabled</label>
                <button type="button" @click="form.enabled = !form.enabled"
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none"
                  :class="form.enabled ? 'bg-green-600' : 'bg-gray-600'">
                  <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                    :class="form.enabled ? 'translate-x-6' : 'translate-x-1'"/>
                </button>
              </div>
            </div>

            <div v-if="errorMsg" class="px-3 py-2 bg-red-900/40 border border-red-700 rounded text-red-300 text-xs">{{ errorMsg }}</div>

            <div class="flex gap-3 pt-2">
              <button type="button" @click="closeModal" class="flex-1 px-4 py-2 text-sm text-gray-300 bg-gray-700 hover:bg-gray-600 rounded transition">Cancel</button>
              <button type="submit" :disabled="saving" class="flex-1 px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition">
                {{ saving ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- Delete confirmation -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="fixed inset-0 z-50 flex items-center justify-center p-4" style="background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)">
        <div class="bg-gray-800 rounded-xl shadow-2xl border border-gray-700 w-full max-w-sm p-6 space-y-4">
          <h3 class="text-base font-semibold text-white">Delete account?</h3>
          <p class="text-sm text-gray-400"><span class="text-white font-medium">{{ deleteTarget.name }}</span> will be permanently deleted. Active connections will be terminated.</p>
          <div class="flex gap-3">
            <button @click="deleteTarget = null" class="flex-1 px-4 py-2 text-sm text-gray-300 bg-gray-700 hover:bg-gray-600 rounded transition">Cancel</button>
            <button @click="deleteConfirmed" :disabled="saving" class="flex-1 px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded transition">
              {{ saving ? 'Deleting…' : 'Delete' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import type { AccountFileEntry } from '~/types';

defineProps<{ pendingRestart?: boolean }>();

const SENTINEL_PASSWORD = '********';

const entries = ref<AccountFileEntry[]>([]);
const audioInputs = ref<string[]>([]);
const audioOutputs = ref<string[]>([]);
const loading = ref(true);
const saving = ref(false);
const toggling = ref<string | null>(null);
const modalOpen = ref(false);
const editEntry = ref<AccountFileEntry | null>(null);
const deleteTarget = ref<AccountFileEntry | null>(null);
const errorMsg = ref('');
const uriError = ref('');

// transport, regint, inreq_allowed are preserved from file but not shown in UI
const form = reactive({
  name: '',
  uri: '',
  auth_pass: '',
  transport: 'udp' as 'udp' | 'tcp' | 'tls',
  answermode: 'auto' as 'manual' | 'early' | 'auto',
  regint: 360,
  audio_source: '',
  audio_player: '',
  pubint: 0,
  inreq_allowed: true,
  enabled: true
});

async function load() {
  loading.value = true;
  try {
    const [accountData, ifaceData] = await Promise.all([
      $fetch<AccountFileEntry[]>('/api/accounts/config'),
      $fetch<{ inputs: string[]; outputs: string[] }>('/api/audio-interfaces')
    ]);
    entries.value = accountData;
    audioInputs.value = ifaceData.inputs;
    audioOutputs.value = ifaceData.outputs;
  } catch {
    // ignore
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  editEntry.value = null;
  Object.assign(form, {
    name: '', uri: '', auth_pass: '',
    transport: 'udp', answermode: 'auto', regint: 360,
    audio_source: '', audio_player: '', pubint: 0,
    inreq_allowed: true, enabled: true
  });
  errorMsg.value = '';
  uriError.value = '';
  modalOpen.value = true;
}

function openEdit(entry: AccountFileEntry) {
  editEntry.value = entry;
  Object.assign(form, {
    name: entry.name,
    uri: entry.uri.replace('sip:', ''),
    auth_pass: SENTINEL_PASSWORD,
    transport: entry.transport,
    answermode: entry.answermode,
    regint: entry.regint,
    audio_source: entry.audio_source,
    audio_player: entry.audio_player,
    pubint: entry.pubint,
    inreq_allowed: entry.inreq_allowed,
    enabled: entry.enabled
  });
  errorMsg.value = '';
  uriError.value = '';
  modalOpen.value = true;
}

function closeModal() { modalOpen.value = false; }
function confirmDelete(entry: AccountFileEntry) { deleteTarget.value = entry; }

async function toggle(entry: AccountFileEntry) {
  toggling.value = entry.uri;
  try {
    const res = await $fetch<{ enabled: boolean; entries: AccountFileEntry[] }>(
      `/api/accounts/${encodeURIComponent(entry.uri)}/toggle`, { method: 'POST' }
    );
    entries.value = res.entries;
  } catch (err: any) {
    alert(err?.data?.message || err?.message || 'Error');
  } finally {
    toggling.value = null;
  }
}

async function save() {
  uriError.value = '';
  errorMsg.value = '';
  if (!form.uri.trim()) {
    uriError.value = 'URI is required';
    return;
  }
  const fullUri = `sip:${form.uri.trim()}`;
  saving.value = true;
  try {
    const payload = {
      ...form,
      uri: fullUri,
      auth_pass: (form.auth_pass === SENTINEL_PASSWORD || form.auth_pass === '') ? null : form.auth_pass
    };
    if (editEntry.value) {
      await $fetch(`/api/accounts/${encodeURIComponent(editEntry.value.uri)}`, { method: 'PUT', body: payload });
    } else {
      await $fetch('/api/accounts', { method: 'POST', body: payload });
    }
    modalOpen.value = false;
    await load();
  } catch (err: any) {
    errorMsg.value = err?.data?.message || err?.message || 'Error saving';
  } finally {
    saving.value = false;
  }
}

async function deleteConfirmed() {
  if (!deleteTarget.value) return;
  saving.value = true;
  try {
    await $fetch(`/api/accounts/${encodeURIComponent(deleteTarget.value.uri)}`, { method: 'DELETE' });
    deleteTarget.value = null;
    await load();
  } catch (err: any) {
    alert(err?.data?.message || err?.message || 'Error deleting');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
