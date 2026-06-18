<template>
  <div class="space-y-4">
    <!-- Pending restart banner -->
    <div v-if="pendingRestart" class="flex items-center gap-2 px-4 py-2.5 bg-yellow-900/40 border border-yellow-700 rounded-lg text-yellow-300 text-sm">
      <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
      </svg>
      Contact changes will take effect after restart
    </div>

    <!-- Header -->
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium text-gray-300">Contacts</h3>
      <button @click="openAdd" class="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded transition">
        + Add
      </button>
    </div>

    <div v-if="loading" class="text-sm text-gray-500 py-4 text-center">Loading contacts…</div>
    <div v-else-if="entries.length === 0" class="text-sm text-gray-500 py-4 text-center">No contacts configured</div>

    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-xs text-gray-400 uppercase tracking-wide border-b border-gray-700">
            <th class="pb-2 text-left font-medium">Name</th>
            <th class="pb-2 text-left font-medium">SIP URI</th>
            <th class="pb-2 text-left font-medium">Presence</th>
            <th class="pb-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700/50">
          <tr v-for="entry in entries" :key="entry.uri" class="group">
            <td class="py-2.5 pr-4 text-white font-medium">{{ entry.name }}</td>
            <td class="py-2.5 pr-4 font-mono text-gray-400 text-xs">{{ entry.uri.replace('sip:', '') }}</td>
            <td class="py-2.5 pr-4">
              <span class="px-2 py-0.5 rounded-full text-xs" :class="entry.presence === 'p2p' ? 'bg-blue-900/50 text-blue-300' : 'bg-gray-700 text-gray-400'">
                {{ entry.presence }}
              </span>
            </td>
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
      <div v-if="modalOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4" style="background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)">
        <div class="bg-gray-800 rounded-xl shadow-2xl border border-gray-700 w-full max-w-md">
          <div class="flex items-center justify-between p-5 border-b border-gray-700">
            <h3 class="text-base font-semibold text-white">{{ editEntry ? 'Edit contact' : 'Add contact' }}</h3>
            <button @click="closeModal" class="text-gray-400 hover:text-white transition">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>

          <form @submit.prevent="save" class="p-5 space-y-4">
            <div>
              <label class="block text-xs text-gray-400 uppercase tracking-wide mb-1">Name</label>
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
          <h3 class="text-base font-semibold text-white">Delete contact?</h3>
          <p class="text-sm text-gray-400"><span class="text-white font-medium">{{ deleteTarget.name }}</span> will be permanently removed from the contacts file.</p>
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
import type { ContactFileEntry } from '~/types';

const entries = ref<ContactFileEntry[]>([]);
const loading = ref(true);
const saving = ref(false);
const pendingRestart = ref(false);
const modalOpen = ref(false);
const editEntry = ref<ContactFileEntry | null>(null);
const deleteTarget = ref<ContactFileEntry | null>(null);
const errorMsg = ref('');
const uriError = ref('');

const form = reactive({ name: '', uri: '' });

async function load() {
  loading.value = true;
  try {
    entries.value = await $fetch<ContactFileEntry[]>('/api/contacts/config');
  } catch {
    // ignore
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  editEntry.value = null;
  form.name = '';
  form.uri = '';
  errorMsg.value = '';
  uriError.value = '';
  modalOpen.value = true;
}

function openEdit(entry: ContactFileEntry) {
  editEntry.value = entry;
  form.name = entry.name;
  form.uri = entry.uri.replace('sip:', '');
  errorMsg.value = '';
  uriError.value = '';
  modalOpen.value = true;
}

function closeModal() { modalOpen.value = false; }
function confirmDelete(entry: ContactFileEntry) { deleteTarget.value = entry; }

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
    if (editEntry.value) {
      await $fetch(`/api/contacts/${encodeURIComponent(editEntry.value.uri)}`, {
        method: 'PUT',
        body: { name: form.name, uri: fullUri }
      });
    } else {
      await $fetch('/api/contacts', { method: 'POST', body: { name: form.name, uri: fullUri } });
    }
    pendingRestart.value = true;
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
    await $fetch(`/api/contacts/${encodeURIComponent(deleteTarget.value.uri)}`, { method: 'DELETE' });
    pendingRestart.value = true;
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
