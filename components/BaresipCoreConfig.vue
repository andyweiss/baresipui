<template>
  <div class="space-y-4">
    <!-- Pending restart / out-of-sync banner -->
    <div v-if="pendingRestart" class="flex items-center gap-2 px-4 py-2.5 bg-yellow-900/40 border border-yellow-700 rounded-lg text-yellow-300 text-sm">
      <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
      </svg>
      <span class="flex-1">The config file was written but baresip has not reloaded it yet.</span>
      <button @click="applyToBaresip" :disabled="reloading"
        class="px-3 py-1 text-xs font-medium bg-yellow-700 hover:bg-yellow-600 text-white rounded transition disabled:opacity-50">
        {{ reloading ? 'Reloading…' : 'Reload now' }}
      </button>
    </div>

    <!-- Header -->
    <div class="flex items-start justify-between gap-4">
      <div>
        <h3 class="text-sm font-medium text-gray-300">Baresip Core Config</h3>
        <p class="text-xs text-gray-500 mt-0.5">
          Edits are written straight into
          <span class="font-mono text-gray-400">{{ filePath || '…' }}</span>, which stays the source of truth.
        </p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button @click="load" :disabled="loading || saving"
          class="px-3 py-1.5 text-xs font-medium bg-gray-700 hover:bg-gray-600 text-white rounded transition disabled:opacity-50">
          Reload from file
        </button>
        <button @click="save" :disabled="!canSave"
          class="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded transition disabled:opacity-50">
          {{ saving ? 'Saving…' : `Save${dirtyKeys.length ? ` (${dirtyKeys.length})` : ''}` }}
        </button>
      </div>
    </div>

    <div v-if="errorMsg" class="px-4 py-2.5 bg-red-900/40 border border-red-700 rounded-lg text-red-300 text-sm">
      {{ errorMsg }}
    </div>
    <div v-else-if="notice" class="px-4 py-2.5 bg-blue-900/30 border border-blue-800 rounded-lg text-blue-300 text-sm">
      {{ notice }}
    </div>

    <div v-if="loading" class="text-sm text-gray-500 py-4 text-center">Loading config…</div>

    <div v-else-if="!fileExists" class="text-sm text-gray-500 py-4 text-center">
      No config file at <span class="font-mono">{{ filePath }}</span>. Nothing can be edited until baresip creates it.
    </div>

    <template v-else>
      <div v-for="group in groups" :key="group.name" class="pt-2">
        <h4 class="text-xs text-gray-400 uppercase tracking-wide mb-3 pb-1 border-b border-gray-700">{{ group.name }}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
          <div v-for="key in group.keys" :key="key">
            <label class="flex items-center gap-2 text-xs text-gray-400 mb-1" :for="`cfg-${key}`">
              <span>{{ fields[key].label }}</span>
              <span v-if="!entryOf(key).present"
                class="px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 text-[10px] uppercase tracking-wide">not in file</span>
              <span v-else-if="!entryOf(key).enabled"
                class="px-1.5 py-0.5 rounded bg-yellow-900/60 text-yellow-300 text-[10px] uppercase tracking-wide"># commented</span>
            </label>

            <!-- yes/no -->
            <select v-if="fields[key].type.kind === 'bool'" :id="`cfg-${key}`" v-model="draft[key]"
              :disabled="!entryOf(key).present" :class="controlClass(key)">
              <option value="yes">yes</option>
              <option value="no">no</option>
              <option v-if="isUnlistedValue(key)" :value="draft[key]">{{ draft[key] }} (from file)</option>
            </select>

            <!-- fixed choices -->
            <select v-else-if="fields[key].type.kind === 'enum'" :id="`cfg-${key}`" v-model="draft[key]"
              :disabled="!entryOf(key).present" :class="controlClass(key)">
              <option v-for="option in enumValues(key)" :key="option" :value="option">{{ option }}</option>
              <option v-if="isUnlistedValue(key)" :value="draft[key]">{{ draft[key] }} (from file)</option>
            </select>

            <!-- numbers -->
            <input v-else-if="fields[key].type.kind === 'int'" :id="`cfg-${key}`" v-model="draft[key]"
              type="number" step="1" :min="intBounds(key).min" :max="intBounds(key).max"
              :disabled="!entryOf(key).present" :class="controlClass(key)"/>

            <input v-else-if="fields[key].type.kind === 'float'" :id="`cfg-${key}`" v-model="draft[key]"
              type="number" step="any" :disabled="!entryOf(key).present" :class="controlClass(key)"/>

            <!-- free text (ranges, device strings) -->
            <input v-else :id="`cfg-${key}`" v-model="draft[key]" type="text"
              :list="fields[key].devices ? `alsa-${fields[key].devices}s` : undefined"
              :placeholder="fields[key].type.kind === 'range' ? 'low-high' : ''"
              :disabled="!entryOf(key).present" :class="controlClass(key)"/>

            <p v-if="fieldErrors[key]" class="mt-1 text-xs text-red-400">{{ fieldErrors[key] }}</p>
            <p v-else-if="!entryOf(key).present" class="mt-1 text-xs text-gray-500">
              Add a <span class="font-mono">{{ key }}</span> line to the config file to edit it here.
            </p>
            <p v-else-if="!entryOf(key).enabled" class="mt-1 text-xs text-yellow-500/80">
              Commented out in the file — saving will activate this line.
            </p>
            <p v-else-if="fields[key].help" class="mt-1 text-xs text-gray-500">{{ fields[key].help }}</p>
          </div>
        </div>
      </div>

      <datalist id="alsa-inputs">
        <option v-for="iface in audioInputs" :key="iface" :value="`alsa,${iface}`"/>
      </datalist>
      <datalist id="alsa-outputs">
        <option v-for="iface in audioOutputs" :key="iface" :value="`alsa,${iface}`"/>
      </datalist>
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  BARESIP_CONFIG_FIELDS,
  BARESIP_CONFIG_GROUPS,
  BARESIP_CONFIG_KEYS,
  validateBaresipConfigValue,
  type BaresipConfigEntries,
  type BaresipConfigEntry,
  type BaresipConfigKey,
} from '~/types';

const props = defineProps<{
  pendingRestart?: boolean,
}>();

interface ConfigResponse {
  path: string
  exists: boolean
  entries: BaresipConfigEntries
  changed?: boolean
  reloaded?: boolean
  reloadError?: string
  message?: string
}

const ABSENT: BaresipConfigEntry = { value: null, enabled: false, present: false };

const fields = BARESIP_CONFIG_FIELDS;
const groups = BARESIP_CONFIG_GROUPS
  .map(name => ({ name, keys: BARESIP_CONFIG_KEYS.filter(key => fields[key].group === name) }))
  .filter(group => group.keys.length > 0);

const entries = ref<BaresipConfigEntries | null>(null);
const draft = reactive({} as Record<BaresipConfigKey, string>);
const filePath = ref('');
const fileExists = ref(true);
const audioInputs = ref<string[]>([]);
const audioOutputs = ref<string[]>([]);
const loading = ref(true);
const saving = ref(false);
const reloading = ref(false);
const errorMsg = ref('');
const notice = ref('');

function entryOf(key: BaresipConfigKey): BaresipConfigEntry {
  return entries.value?.[key] ?? ABSENT;
}

function enumValues(key: BaresipConfigKey): readonly string[] {
  const type = fields[key].type;
  return type.kind === 'enum' ? type.values : [];
}

function intBounds(key: BaresipConfigKey): { min?: number; max?: number } {
  const type = fields[key].type;
  return type.kind === 'int' ? { min: type.min, max: type.max } : {};
}

/** True when the file holds a value the dropdown does not offer — it is still shown. */
function isUnlistedValue(key: BaresipConfigKey): boolean {
  const value = draft[key];
  if (!value) return false;
  const type = fields[key].type;
  if (type.kind === 'bool') return value !== 'yes' && value !== 'no';
  if (type.kind === 'enum') return !type.values.includes(value);
  return false;
}

function controlClass(key: BaresipConfigKey): string {
  return [
    'w-full px-3 py-2 bg-gray-700 rounded text-sm text-white focus:outline-none focus:ring-1',
    'disabled:opacity-40 disabled:cursor-not-allowed',
    fieldErrors.value[key] ? 'ring-1 ring-red-500 focus:ring-red-500' : 'focus:ring-blue-500',
  ].join(' ');
}

const dirtyKeys = computed(() =>
  BARESIP_CONFIG_KEYS.filter((key) => {
    const entry = entryOf(key);
    return entry.present && draft[key] !== entry.value;
  }),
);

const fieldErrors = computed(() => {
  const errors = {} as Partial<Record<BaresipConfigKey, string>>;
  for (const key of dirtyKeys.value) {
    const problem = validateBaresipConfigValue(key, draft[key] ?? '');
    if (problem) errors[key] = problem;
  }
  return errors;
});

const canSave = computed(() =>
  !loading.value && !saving.value && dirtyKeys.value.length > 0 &&
  Object.keys(fieldErrors.value).length === 0,
);

/** Replaces all local state with what the server just read from the file. */
function applyState(response: ConfigResponse) {
  entries.value = response.entries;
  filePath.value = response.path;
  fileExists.value = response.exists;
  for (const key of BARESIP_CONFIG_KEYS) {
    draft[key] = response.entries?.[key]?.value ?? '';
  }
}

async function load() {
  loading.value = true;
  errorMsg.value = '';
  notice.value = '';
  try {
    const [config, ifaces] = await Promise.all([
      $fetch<ConfigResponse>('/api/config/core'),
      $fetch<{ inputs: string[]; outputs: string[] }>('/api/audio-interfaces').catch(() => null),
    ]);
    applyState(config);
    audioInputs.value = ifaces?.inputs ?? [];
    audioOutputs.value = ifaces?.outputs ?? [];
  } catch (err: any) {
    errorMsg.value = err?.data?.message || err?.message || 'Could not read the config file';
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  errorMsg.value = '';
  notice.value = '';
  try {
    const payload: Partial<Record<BaresipConfigKey, string>> = {};
    for (const key of dirtyKeys.value) payload[key] = draft[key];

    const response = await $fetch<ConfigResponse>('/api/config/core', { method: 'PUT', body: payload });
    applyState(response);

    if (!response.changed) {
      notice.value = 'The file already contained these values — nothing was written.';
    } else if (response.reloaded) {
      notice.value = 'Saved and reloaded by baresip.';
    } else {
      notice.value = `Saved to the config file, but baresip did not reload: ${response.reloadError || 'reload failed'}`;
    }
  } catch (err: any) {
    errorMsg.value = err?.data?.message || err?.message || 'Error saving config';
    // The write may have partly happened; resync from the file either way.
    await load();
  } finally {
    saving.value = false;
  }
}

async function applyToBaresip() {
  reloading.value = true;
  errorMsg.value = '';
  notice.value = '';
  try {
    const response = await $fetch<ConfigResponse>('/api/config/reload', { method: 'POST' });
    applyState(response);
    notice.value = response.reloaded
      ? 'baresip reloaded the config file.'
      : `Reload failed: ${response.message || 'unknown error'}`;
  } catch (err: any) {
    errorMsg.value = err?.data?.message || err?.message || 'Reload failed';
  } finally {
    reloading.value = false;
  }
}

// A restart flag flipping off means baresip picked the file up elsewhere;
// re-read so the form never drifts from disk.
watch(() => props.pendingRestart, (pending, wasPending) => {
  if (wasPending && !pending) load();
});

onMounted(load);
onActivated(() => { if (!saving.value && dirtyKeys.value.length === 0) load(); });
</script>
