<template>
  <section
    v-if="featureEnabled === true || (featureEnabled === null && fetchError)"
    class="space-y-5 border-b border-gray-700 pb-6"
    aria-labelledby="talktome-bridge-heading"
  >
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 id="talktome-bridge-heading" class="text-lg font-semibold text-white">
          TalkToMe Bridge
        </h3>
        <p class="mt-1 text-sm text-gray-400">
          Route configured SIP accounts to TalkToMe users, conferences, or feeds.
        </p>
      </div>
      <button
        type="button"
        :disabled="loading"
        class="inline-flex items-center justify-center rounded bg-gray-700 px-3 py-2 text-sm font-medium text-gray-200 transition hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Refresh TalkToMe bridge configuration and status"
        @click="loadConfig"
      >
        <svg
          class="mr-2 h-4 w-4"
          :class="{ 'animate-spin': loading }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v6h6M20 20v-6h-6M5.1 15a7 7 0 0011.8 2M18.9 9A7 7 0 007.1 7" />
        </svg>
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <div
      v-if="featureEnabled === true"
      class="grid grid-cols-1 gap-3 sm:grid-cols-3"
      aria-live="polite"
    >
      <div class="rounded-lg border border-gray-700 bg-gray-800/70 p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Phase</p>
        <div class="mt-2 flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full" :class="phaseDotClass(currentGlobalStatus?.phase)" />
          <span class="text-sm font-semibold text-white">
            {{ formatPhase(currentGlobalStatus?.phase) }}
          </span>
        </div>
      </div>
      <div class="rounded-lg border border-gray-700 bg-gray-800/70 p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Baresip</p>
        <p
          class="mt-2 text-sm font-semibold"
          :class="currentGlobalStatus?.baresipConnected ? 'text-green-400' : 'text-red-400'"
        >
          {{ currentGlobalStatus?.baresipConnected ? 'Reachable' : 'Unavailable' }}
        </p>
      </div>
      <div class="rounded-lg border border-gray-700 bg-gray-800/70 p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-gray-500">TalkToMe server</p>
        <p
          class="mt-2 text-sm font-semibold"
          :class="currentGlobalStatus?.serverReachable ? 'text-green-400' : 'text-red-400'"
        >
          {{ currentGlobalStatus?.serverReachable ? 'Reachable' : 'Unavailable' }}
        </p>
        <p
          v-if="currentGlobalStatus?.serverVersion || currentGlobalStatus?.testedVersion"
          class="mt-1 text-xs text-gray-400"
        >
          <span v-if="currentGlobalStatus?.serverVersion">
            v{{ currentGlobalStatus.serverVersion }}
          </span>
          <span v-if="currentGlobalStatus?.testedVersion">
            <span v-if="currentGlobalStatus?.serverVersion"> · </span>
            tested {{ currentGlobalStatus.testedVersion }}
          </span>
        </p>
      </div>
    </div>

    <div
      v-if="fetchError"
      role="alert"
      class="rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200"
    >
      <p class="font-medium">Could not load the TalkToMe bridge.</p>
      <p class="mt-1 break-words">{{ fetchError }}</p>
    </div>

    <div
      v-if="currentGlobalStatus?.lastError"
      role="alert"
      class="rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200"
    >
      <p class="font-medium">Bridge error</p>
      <p class="mt-1 break-words">{{ currentGlobalStatus.lastError }}</p>
    </div>

    <div
      v-if="currentGlobalStatus?.serverNewerThanTested"
      role="alert"
      class="rounded-lg border border-amber-700/70 bg-amber-900/30 px-4 py-3 text-sm text-amber-100"
    >
      <p class="font-medium">TalkToMe server is newer than this build was tested against</p>
      <p class="mt-1 break-words">
        Server reports
        {{ currentGlobalStatus.serverVersion || 'an unknown version' }};
        this bridge was tested against
        {{ currentGlobalStatus.testedVersion || 'an unknown version' }}.
        Bridge Plain-RTP may still work, but behavior can differ until we re-verify.
      </p>
    </div>

    <div
      v-if="featureEnabled === true"
      class="flex items-start gap-3 rounded-lg border border-yellow-700/70 bg-yellow-900/30 px-4 py-3 text-sm text-yellow-200"
    >
      <svg class="mt-0.5 h-5 w-5 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
      <p>
        Audio device changes made while enabling, disabling, or removing a mapping
        require a baresip restart before they fully take effect.
      </p>
    </div>

    <div
      v-if="actionError"
      role="alert"
      class="rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200"
    >
      {{ actionError }}
    </div>
    <div
      v-if="actionMessage"
      role="status"
      class="rounded-lg border border-green-700 bg-green-900/30 px-4 py-3 text-sm text-green-200"
    >
      {{ actionMessage }}
    </div>

    <div v-if="featureEnabled === true" class="space-y-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 class="font-medium text-white">SIP account mappings</h4>
          <p class="text-sm text-gray-400">
            {{ mappingEntries.length }} {{ mappingEntries.length === 1 ? 'mapping' : 'mappings' }}
          </p>
        </div>
        <button
          type="button"
          :disabled="availableAccounts.length === 0 || loading"
          class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          :title="availableAccounts.length === 0 ? 'Every configured SIP account already has a mapping' : undefined"
          @click="openAdd"
        >
          Add mapping
        </button>
      </div>

      <p
        v-if="configuredAccounts.length === 0"
        class="rounded-lg border border-gray-700 bg-gray-800/70 px-4 py-5 text-center text-sm text-gray-400"
      >
        No configured SIP accounts are available.
      </p>
      <p
        v-else-if="mappingEntries.length === 0"
        class="rounded-lg border border-gray-700 bg-gray-800/70 px-4 py-5 text-center text-sm text-gray-400"
      >
        No TalkToMe mappings configured.
      </p>

      <div v-else class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <article
          v-for="entry in mappingEntries"
          :key="entry.accountUri"
          class="rounded-lg border border-gray-700 bg-gray-800/70 p-4"
          :class="{ 'opacity-70': !entry.mapping.enabled }"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h5 class="truncate font-medium text-white">
                  {{ accountName(entry.accountUri) }}
                </h5>
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="phaseBadgeClass(runtimeStatusFor(entry.accountUri)?.phase)"
                >
                  {{ formatPhase(runtimeStatusFor(entry.accountUri)?.phase) }}
                </span>
              </div>
              <p class="mt-1 break-all font-mono text-xs text-gray-400">
                {{ entry.accountUri }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="text-xs text-gray-400">
                {{ entry.mapping.enabled ? 'Enabled' : 'Disabled' }}
              </span>
              <button
                type="button"
                role="switch"
                :aria-checked="entry.mapping.enabled"
                :aria-label="`${entry.mapping.enabled ? 'Disable' : 'Enable'} TalkToMe mapping for ${entry.accountUri}`"
                :disabled="busyAccount === entry.accountUri"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                :class="entry.mapping.enabled ? 'bg-green-600' : 'bg-gray-600'"
                @click="toggleMapping(entry.accountUri, entry.mapping)"
              >
                <span
                  class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                  :class="entry.mapping.enabled ? 'translate-x-6' : 'translate-x-1'"
                />
              </button>
            </div>
          </div>

          <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt class="text-xs uppercase tracking-wide text-gray-500">Endpoint</dt>
              <dd class="mt-1 text-gray-200">{{ endpointLabel(entry.mapping) }}</dd>
            </div>
            <div v-if="!isFeedMapping(entry.mapping)">
              <dt class="text-xs uppercase tracking-wide text-gray-500">Target</dt>
              <dd class="mt-1 text-gray-200">{{ targetLabel(entry.mapping.target) }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wide text-gray-500">Context key</dt>
              <dd class="mt-1 break-all font-mono text-xs text-gray-200">{{ entry.mapping.key }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wide text-gray-500">{{ isFeedMapping(entry.mapping) ? 'Feed mode' : 'PTT' }}</dt>
              <dd class="mt-1 text-gray-200">
                <template v-if="isFeedMapping(entry.mapping)">
                  Send-only, streams while the SIP call is up
                </template>
                <template v-else>
                  {{ entry.mapping.ptt.mode === 'audio-level' ? `${entry.mapping.ptt.thresholdDb} dB` : `External GPI ${entry.mapping.ptt.gpi}` }}
                  · {{ entry.mapping.ptt.holdMs }} ms
                </template>
              </dd>
            </div>
          </dl>

          <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
            <div class="rounded bg-gray-900/60 px-3 py-2">
              <p class="text-xs text-gray-500">Consumers</p>
              <p class="mt-0.5 text-sm font-medium text-white">
                {{ runtimeStatusFor(entry.accountUri)?.consumerCount ?? 0 }}
              </p>
            </div>
            <div class="rounded bg-gray-900/60 px-3 py-2">
              <p class="text-xs text-gray-500">{{ isFeedMapping(entry.mapping) ? 'TX stream' : 'PTT / Live' }}</p>
              <p
                class="mt-0.5 text-sm font-medium"
                :class="runtimeStatusFor(entry.accountUri)?.pttLive ? 'text-green-400' : 'text-gray-300'"
              >
                {{ runtimeStatusFor(entry.accountUri)?.pttLive ? (isFeedMapping(entry.mapping) ? 'Streaming' : 'Live') : 'Idle' }}
              </p>
            </div>
            <div v-if="!isFeedMapping(entry.mapping)" class="rounded bg-gray-900/60 px-3 py-2">
              <p class="text-xs text-gray-500">PTT lock</p>
              <p
                class="mt-0.5 text-sm font-medium"
                :class="runtimeStatusFor(entry.accountUri)?.pttLocked ? 'text-yellow-300' : 'text-gray-300'"
              >
                {{ runtimeStatusFor(entry.accountUri)?.pttLocked ? 'Locked' : 'Open' }}
              </p>
            </div>
            <div class="rounded bg-gray-900/60 px-3 py-2">
              <p class="text-xs text-gray-500">Events</p>
              <p class="mt-0.5 text-sm font-medium text-gray-200">
                {{ eventTransportLabel(runtimeStatusFor(entry.accountUri)?.eventTransport) }}
              </p>
            </div>
          </div>

          <div
            v-if="runtimeStatusFor(entry.accountUri)?.lastError"
            role="alert"
            class="mt-3 rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-200"
          >
            {{ runtimeStatusFor(entry.accountUri)?.lastError }}
          </div>

          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-700 pt-3">
            <p class="text-xs text-gray-500">
              {{ runtimeStatusFor(entry.accountUri) ? `${runtimeStatusFor(entry.accountUri)?.activeCallIds.length ?? 0} active calls` : 'Runtime status unavailable' }}
            </p>
            <div v-if="removeTarget === entry.accountUri" class="flex items-center gap-2">
              <span class="text-xs text-red-300">Remove mapping?</span>
              <button
                type="button"
                class="rounded px-2 py-1 text-xs text-gray-300 transition hover:bg-gray-700"
                @click="removeTarget = null"
              >
                Cancel
              </button>
              <button
                type="button"
                :disabled="busyAccount === entry.accountUri"
                class="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                @click="removeMapping(entry.accountUri)"
              >
                Remove
              </button>
            </div>
            <div v-else class="flex items-center gap-2">
              <button
                type="button"
                class="rounded px-3 py-1.5 text-xs font-medium text-blue-300 transition hover:bg-blue-900/30"
                @click="openEdit(entry.accountUri, entry.mapping)"
              >
                Edit
              </button>
              <button
                type="button"
                class="rounded px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-900/30"
                @click="removeTarget = entry.accountUri"
              >
                Remove
              </button>
            </div>
          </div>
        </article>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="modalOpen"
        class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="talktome-mapping-dialog-title"
        @click.self="closeModal"
        @keydown.esc="closeModal"
      >
        <div class="my-4 w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-800 shadow-2xl">
          <div class="flex items-center justify-between border-b border-gray-700 p-5">
            <div>
              <h3 id="talktome-mapping-dialog-title" class="font-semibold text-white">
                {{ editAccountUri ? 'Edit TalkToMe mapping' : 'Add TalkToMe mapping' }}
              </h3>
              <p class="mt-1 text-xs text-gray-400">No server credentials are shown or required here.</p>
            </div>
            <button
              type="button"
              class="rounded p-1 text-gray-400 transition hover:bg-gray-700 hover:text-white"
              aria-label="Close TalkToMe mapping form"
              @click="closeModal"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form class="space-y-5 p-5" novalidate @submit.prevent="saveMapping">
            <div
              v-if="modalError"
              id="talktome-form-error"
              role="alert"
              class="rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200"
            >
              {{ modalError }}
            </div>

            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label for="talktome-account" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                  SIP account
                </label>
                <select
                  id="talktome-account"
                  v-model="form.accountUri"
                  required
                  :disabled="Boolean(editAccountUri)"
                  class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="" disabled>Select a configured account</option>
                  <option v-for="account in availableAccounts" :key="account.uri" :value="account.uri">
                    {{ account.displayName || account.uri }}
                  </option>
                  <option v-if="editAccountUri" :value="editAccountUri">
                    {{ accountName(editAccountUri) }} — {{ editAccountUri }}
                  </option>
                </select>
              </div>

              <div>
                <label for="talktome-endpoint" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                  TalkToMe endpoint
                </label>
                <select
                  v-if="endpointOptions.length"
                  id="talktome-endpoint"
                  :value="endpointValue"
                  required
                  class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  @change="setEndpointFromValue(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="port in endpointOptions" :key="`${port.kind}:${port.id}`" :value="endpointOptionValue(port)">
                    {{ endpointOptionLabel(port) }}{{ port.enabled ? '' : ' — disabled' }}
                  </option>
                  <option
                    v-if="endpointFallbackValue && !selectedEndpointPort"
                    :value="endpointFallbackValue"
                  >
                    {{ endpointFallbackLabel }} — not reported by server
                  </option>
                </select>
                <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <select
                    id="talktome-endpoint"
                    v-model="form.endpointKind"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    @change="applyEndpointDefaults"
                  >
                    <option value="user">User endpoint</option>
                    <option value="feed">Feed endpoint</option>
                  </select>
                  <input
                    v-model.number="endpointId"
                    :aria-label="form.endpointKind === 'feed' ? 'TalkToMe feed ID' : 'TalkToMe user ID'"
                    type="number"
                    required
                    min="1"
                    step="1"
                    inputmode="numeric"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    @input="applyEndpointDefaults"
                  >
                </div>
                <p v-if="selectedEndpointPort && !selectedEndpointPort.enabled" class="mt-1 text-xs text-yellow-300">
                  This server endpoint is currently disabled.
                </p>
              </div>

              <div>
                <label for="talktome-context-key" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                  Context key
                </label>
                <input
                  id="talktome-context-key"
                  v-model.trim="form.key"
                  type="text"
                  required
                  maxlength="120"
                  autocomplete="off"
                  placeholder="Defaults to the user ID"
                  class="w-full rounded bg-gray-700 px-3 py-2 font-mono text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  @input="contextKeyTouched = true"
                >
                <p class="mt-1 text-xs text-gray-500">Letters, numbers, _, ., :, @, and - only.</p>
              </div>

              <div class="flex items-center justify-between rounded-lg border border-gray-700 px-3 py-2">
                <div>
                  <p class="text-sm font-medium text-white">Mapping enabled</p>
                  <p class="text-xs text-gray-500">Soft-disable without deleting settings.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  :aria-checked="form.enabled"
                  aria-label="Mapping enabled"
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                  :class="form.enabled ? 'bg-green-600' : 'bg-gray-600'"
                  @click="form.enabled = !form.enabled"
                >
                  <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                    :class="form.enabled ? 'translate-x-6' : 'translate-x-1'"
                  />
                </button>
              </div>
            </div>

            <div
              v-if="isFeedForm"
              class="rounded-lg border border-blue-700/60 bg-blue-900/20 px-4 py-3 text-sm text-blue-100"
            >
              Feeds are send-only; SIP audio streams into the selected feed while the call is up.
            </div>

            <fieldset v-if="!isFeedForm" class="rounded-lg border border-gray-700 p-4">
              <legend class="px-1 text-sm font-medium text-white">Conference or user target</legend>
              <div v-if="targetOptions.length">
                <label for="talktome-target" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                  Allowed target
                </label>
                <select
                  id="talktome-target"
                  :value="targetValue"
                  required
                  class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  @change="setTargetFromValue(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="target in targetOptions" :key="`${target.type}:${target.id}`" :value="`${target.type}:${target.id}`">
                    {{ target.name }} — {{ target.type }} {{ target.id }}
                  </option>
                </select>
              </div>
              <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label for="talktome-target-type" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    Target type
                  </label>
                  <select
                    id="talktome-target-type"
                    v-model="form.targetType"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="conference">Conference</option>
                    <option value="user">User</option>
                  </select>
                </div>
                <div>
                  <label for="talktome-target-id" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    Target ID
                  </label>
                  <input
                    id="talktome-target-id"
                    v-model.number="form.targetId"
                    type="number"
                    required
                    min="1"
                    step="1"
                    inputmode="numeric"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                </div>
              </div>
            </fieldset>

            <fieldset v-if="!isFeedForm" class="rounded-lg border border-gray-700 p-4">
              <legend class="px-1 text-sm font-medium text-white">Push-to-talk</legend>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label for="talktome-ptt-mode" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    Mode
                  </label>
                  <select
                    id="talktome-ptt-mode"
                    v-model="form.pttMode"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="audio-level">Audio level</option>
                    <option value="external">External GPI</option>
                  </select>
                </div>
                <div v-if="form.pttMode === 'audio-level'">
                  <label for="talktome-threshold" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    Threshold (dB)
                  </label>
                  <input
                    id="talktome-threshold"
                    v-model.number="form.thresholdDb"
                    type="number"
                    required
                    min="-120"
                    max="-10"
                    step="1"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                </div>
                <div v-else>
                  <label for="talktome-gpi" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    External GPI
                  </label>
                  <select
                    id="talktome-gpi"
                    v-model="form.gpi"
                    required
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option v-for="gpi in gpioOptions" :key="gpi" :value="gpi">GPI {{ gpi }}</option>
                  </select>
                </div>
                <div>
                  <label for="talktome-hold" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    Hold (ms)
                  </label>
                  <input
                    id="talktome-hold"
                    v-model.number="form.holdMs"
                    type="number"
                    required
                    min="0"
                    max="60000"
                    step="1"
                    inputmode="numeric"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                </div>
              </div>
            </fieldset>

            <fieldset class="rounded-lg border border-gray-700 p-4">
              <legend class="px-1 text-sm font-medium text-white">Tally outputs</legend>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label for="talktome-active-gpo" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    Active GPO (optional)
                  </label>
                  <select
                    id="talktome-active-gpo"
                    v-model="form.activeGpo"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">None</option>
                    <option
                      v-for="gpo in gpioOptions"
                      :key="gpo"
                      :value="gpo"
                      :disabled="Number(form.liveGpo) === gpo"
                    >
                      GPO {{ gpo }}
                    </option>
                  </select>
                </div>
                <div>
                  <label for="talktome-live-gpo" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                    Live GPO (optional)
                  </label>
                  <select
                    id="talktome-live-gpo"
                    v-model="form.liveGpo"
                    class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">None</option>
                    <option
                      v-for="gpo in gpioOptions"
                      :key="gpo"
                      :value="gpo"
                      :disabled="Number(form.activeGpo) === gpo"
                    >
                      GPO {{ gpo }}
                    </option>
                  </select>
                </div>
              </div>
              <p class="mt-2 text-xs text-gray-500">Active and live tally must use different outputs.</p>
            </fieldset>

            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label for="talktome-bitrate" class="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
                  Audio bitrate (bps)
                </label>
                <input
                  id="talktome-bitrate"
                  v-model.number="form.bitrateBps"
                  type="number"
                  required
                  min="6000"
                  max="510000"
                  step="1000"
                  inputmode="numeric"
                  class="w-full rounded bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
              </div>
              <div class="flex items-center justify-between rounded-lg border border-gray-700 px-3 py-2">
                <div>
                  <p class="text-sm font-medium text-white">Mix local callers</p>
                  <p class="text-xs text-gray-500">Include other local SIP callers in the mix.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  :aria-checked="form.mixLocalCallers"
                  aria-label="Mix local callers"
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                  :class="form.mixLocalCallers ? 'bg-green-600' : 'bg-gray-600'"
                  @click="form.mixLocalCallers = !form.mixLocalCallers"
                >
                  <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                    :class="form.mixLocalCallers ? 'translate-x-6' : 'translate-x-1'"
                  />
                </button>
              </div>
            </div>

            <div class="flex flex-col-reverse gap-3 border-t border-gray-700 pt-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                class="rounded bg-gray-700 px-4 py-2 text-sm text-gray-200 transition hover:bg-gray-600"
                @click="closeModal"
              >
                Cancel
              </button>
              <button
                type="submit"
                :disabled="saving"
                class="rounded bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {{ saving ? 'Saving…' : 'Save mapping' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import type {
  Account,
  TalktomeAccountMapping,
  TalktomeAccountMappingInput,
  TalktomeBridgeConfigResponse,
  TalktomeFeedAccountMapping,
  TalktomeBridgeGlobalStatus,
  TalktomeBridgeServerFeedPort,
  TalktomeBridgeServerUserPort,
  TalktomeBridgeStatus,
  TalktomeEndpointKind,
  TalktomePttMode,
  TalktomeTarget,
  TalktomeTargetType,
} from '~/types';

const props = defineProps<{
  accounts: Account[];
  globalStatus: TalktomeBridgeGlobalStatus | null;
  statuses: TalktomeBridgeStatus[];
}>();

type MappingEntry = {
  accountUri: string;
  mapping: TalktomeAccountMapping;
};

type MappingForm = {
  accountUri: string;
  enabled: boolean;
  key: string;
  endpointKind: TalktomeEndpointKind;
  talktomeUserId: number;
  talktomeFeedId: number;
  targetType: TalktomeTargetType;
  targetId: number;
  pttMode: TalktomePttMode;
  thresholdDb: number;
  holdMs: number;
  gpi: number;
  activeGpo: number | '';
  liveGpo: number | '';
  mixLocalCallers: boolean;
  bitrateBps: number;
};

type MutationResponse = {
  requiresRestart?: boolean;
  runtimeRefreshed?: boolean;
  runtimeError?: string;
};

const featureEnabled = ref<boolean | null>(null);
const mappings = ref<Record<string, TalktomeAccountMapping>>({});
const server = ref<TalktomeBridgeConfigResponse['server']>(null);
const apiGlobalStatus = ref<TalktomeBridgeGlobalStatus | null>(null);
const apiStatuses = ref<TalktomeBridgeStatus[]>([]);
const loading = ref(false);
const saving = ref(false);
const fetchError = ref('');
const actionError = ref('');
const actionMessage = ref('');
const busyAccount = ref<string | null>(null);
const removeTarget = ref<string | null>(null);
const modalOpen = ref(false);
const modalError = ref('');
const editAccountUri = ref<string | null>(null);
const contextKeyTouched = ref(false);
const gpioOptions = [1, 2, 3, 4, 5, 6] as const;

const form = reactive<MappingForm>({
  accountUri: '',
  enabled: true,
  key: '',
  endpointKind: 'user',
  talktomeUserId: 0,
  talktomeFeedId: 0,
  targetType: 'conference',
  targetId: 0,
  pttMode: 'audio-level',
  thresholdDb: -45,
  holdMs: 300,
  gpi: 1,
  activeGpo: '',
  liveGpo: '',
  mixLocalCallers: true,
  bitrateBps: 64_000,
});

const currentGlobalStatus = computed(
  () => props.globalStatus ?? apiGlobalStatus.value,
);

const userPorts = computed(() => server.value?.userPorts ?? []);
const feedPorts = computed(() => server.value?.feedPorts ?? []);
const endpointOptions = computed<Array<TalktomeBridgeServerUserPort | TalktomeBridgeServerFeedPort>>(
  () => [
    ...userPorts.value,
    ...feedPorts.value,
  ],
);

const configuredAccounts = computed(() =>
  props.accounts
    .filter(account => account.configured !== false && Boolean(account.uri))
    .slice()
    .sort((left, right) =>
      (left.displayName || left.uri).localeCompare(right.displayName || right.uri),
    ),
);

const availableAccounts = computed(() => {
  const mappedUris = new Set(
    Object.keys(mappings.value).map(accountUri => normalizeUri(accountUri)),
  );
  return configuredAccounts.value.filter(
    account => !mappedUris.has(normalizeUri(account.uri)),
  );
});

const mappingEntries = computed<MappingEntry[]>(() =>
  Object.entries(mappings.value)
    .map(([accountUri, mapping]) => ({ accountUri, mapping }))
    .sort((left, right) =>
      accountName(left.accountUri).localeCompare(accountName(right.accountUri)),
    ),
);

const isFeedForm = computed(() => form.endpointKind === 'feed');

const endpointValue = computed(() =>
  form.endpointKind === 'feed'
    ? `feed:${Number(form.talktomeFeedId) || ''}`
    : `user:${Number(form.talktomeUserId) || ''}`,
);

const endpointFallbackValue = computed(() => {
  if (form.endpointKind === 'feed' && Number(form.talktomeFeedId) > 0) {
    return `feed:${Number(form.talktomeFeedId)}`;
  }
  if (form.endpointKind === 'user' && Number(form.talktomeUserId) > 0) {
    return `user:${Number(form.talktomeUserId)}`;
  }
  return '';
});

const endpointFallbackLabel = computed(() =>
  form.endpointKind === 'feed'
    ? `Feed ${Number(form.talktomeFeedId) || ''}`
    : `User ${Number(form.talktomeUserId) || ''}`,
);

const endpointId = computed({
  get: () =>
    form.endpointKind === 'feed' ? form.talktomeFeedId : form.talktomeUserId,
  set: (value: number) => {
    if (form.endpointKind === 'feed') form.talktomeFeedId = Number(value);
    else form.talktomeUserId = Number(value);
  },
});

const selectedEndpointPort = computed(() =>
  endpointOptions.value.find(port =>
    port.kind === form.endpointKind &&
    (port.kind === 'feed'
      ? port.feedId === Number(form.talktomeFeedId)
      : port.userId === Number(form.talktomeUserId)),
  ),
);

const targetOptions = computed(
  () =>
    selectedEndpointPort.value?.kind === 'user'
      ? selectedEndpointPort.value.triggerTargets
      : [],
);

const targetValue = computed(
  () => `${form.targetType}:${form.targetId}`,
);

async function loadConfig() {
  loading.value = true;
  fetchError.value = '';
  try {
    const data = await $fetch<TalktomeBridgeConfigResponse>(
      '/api/talktome-bridge/config',
    );
    featureEnabled.value = data.enabled;
    if (!data.enabled) {
      mappings.value = {};
      server.value = null;
      apiGlobalStatus.value = data.globalStatus;
      apiStatuses.value = [];
      return;
    }
    mappings.value = data.mappings;
    server.value = data.server;
    apiGlobalStatus.value = data.globalStatus;
    apiStatuses.value = data.statuses;
  } catch (error) {
    fetchError.value = apiErrorMessage(error, 'Unable to load bridge configuration');
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  void loadConfig().then(() => {
    const account = availableAccounts.value[0];
    if (!account) return;
    const port = preferredEndpoint(endpointOptions.value);
    const target = preferredTarget(port);
    Object.assign(form, {
      accountUri: account.uri,
      enabled: true,
      key: port ? defaultEndpointKey(port) : '',
      endpointKind: port?.kind ?? 'user',
      talktomeUserId: port?.kind === 'user' ? port.userId : 0,
      talktomeFeedId: port?.kind === 'feed' ? port.feedId : 0,
      targetType: target?.type ?? 'conference',
      targetId: target?.id ?? 0,
      pttMode: port?.kind === 'user' ? port.trigger.mode : 'audio-level',
      thresholdDb: port?.kind === 'user' ? port.trigger.thresholdDb : -45,
      holdMs: 300,
      gpi: 1,
      activeGpo: '',
      liveGpo: '',
      mixLocalCallers: true,
      bitrateBps: 64_000,
    } satisfies MappingForm);
    contextKeyTouched.value = false;
    editAccountUri.value = null;
    modalError.value = '';
    modalOpen.value = true;
  });
}

function openEdit(accountUri: string, mapping: TalktomeAccountMapping) {
  Object.assign(form, {
    accountUri,
    enabled: mapping.enabled,
    key: mapping.key,
    endpointKind: mapping.endpointKind ?? 'user',
    talktomeUserId: mapping.talktomeUserId ?? 0,
    talktomeFeedId: mapping.talktomeFeedId ?? 0,
    targetType: mapping.target?.type ?? 'conference',
    targetId: mapping.target?.id ?? 0,
    pttMode: mapping.ptt.mode,
    thresholdDb: mapping.ptt.thresholdDb,
    holdMs: mapping.ptt.holdMs,
    gpi: mapping.ptt.gpi,
    activeGpo: mapping.tally.activeGpo ?? '',
    liveGpo: mapping.tally.liveGpo ?? '',
    mixLocalCallers: mapping.mixLocalCallers,
    bitrateBps: mapping.bitrateBps,
  } satisfies MappingForm);
  contextKeyTouched.value = true;
  editAccountUri.value = accountUri;
  modalError.value = '';
  modalOpen.value = true;
}

function closeModal() {
  if (saving.value) return;
  modalOpen.value = false;
  modalError.value = '';
}

function applyEndpointDefaults() {
  const port = selectedEndpointPort.value;
  if (!port) {
    if (!contextKeyTouched.value) {
      form.key =
        form.endpointKind === 'feed'
          ? form.talktomeFeedId
            ? `feed-${form.talktomeFeedId}`
            : ''
          : String(form.talktomeUserId || '');
    }
    return;
  }
  if (!contextKeyTouched.value) {
    form.key = defaultEndpointKey(port);
  }
  if (port.kind === 'feed') {
    form.endpointKind = 'feed';
    form.talktomeFeedId = port.feedId;
    return;
  }
  form.endpointKind = 'user';
  form.talktomeUserId = port.userId;
  form.pttMode = port.trigger.mode;
  form.thresholdDb = port.trigger.thresholdDb;
  const target = port.trigger.target ?? port.triggerTargets[0];
  if (target) {
    form.targetType = target.type;
    form.targetId = target.id;
  }
}

function setEndpointFromValue(value: string) {
  const [kind, rawId] = value.split(':');
  const id = Number(rawId);
  if ((kind !== 'user' && kind !== 'feed') || !Number.isSafeInteger(id) || id < 1) {
    return;
  }
  form.endpointKind = kind;
  if (kind === 'feed') form.talktomeFeedId = id;
  else form.talktomeUserId = id;
  applyEndpointDefaults();
}

function setTargetFromValue(value: string) {
  const [type, rawId] = value.split(':');
  if (type !== 'conference' && type !== 'user') return;
  form.targetType = type;
  form.targetId = Number(rawId);
}

async function saveMapping() {
  const validationError = validateForm();
  if (validationError) {
    modalError.value = validationError;
    return;
  }
  saving.value = true;
  modalError.value = '';
  actionError.value = '';
  actionMessage.value = '';
  try {
    const result = await putMapping(form.accountUri, formPayload());
    await loadConfig();
    modalOpen.value = false;
    reportMutationResult(result, 'Mapping saved.');
  } catch (error) {
    modalError.value = apiErrorMessage(error, 'Unable to save mapping');
  } finally {
    saving.value = false;
  }
}

async function toggleMapping(
  accountUri: string,
  mapping: TalktomeAccountMapping,
) {
  busyAccount.value = accountUri;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const result = await putMapping(accountUri, mappingPayload(mapping, !mapping.enabled));
    await loadConfig();
    reportMutationResult(
      result,
      `Mapping ${mapping.enabled ? 'disabled' : 'enabled'}.`,
    );
  } catch (error) {
    actionError.value = apiErrorMessage(error, 'Unable to update mapping');
  } finally {
    busyAccount.value = null;
  }
}

async function removeMapping(accountUri: string) {
  busyAccount.value = accountUri;
  actionError.value = '';
  actionMessage.value = '';
  try {
    const result = await $fetch<MutationResponse>(
      `/api/talktome-bridge/accounts/${encodeURIComponent(accountUri)}`,
      { method: 'DELETE' },
    );
    removeTarget.value = null;
    await loadConfig();
    reportMutationResult(result, 'Mapping removed.');
  } catch (error) {
    actionError.value = apiErrorMessage(error, 'Unable to remove mapping');
  } finally {
    busyAccount.value = null;
  }
}

function putMapping(
  accountUri: string,
  body: TalktomeAccountMappingInput,
): Promise<MutationResponse> {
  return $fetch<MutationResponse>(
    `/api/talktome-bridge/accounts/${encodeURIComponent(accountUri)}`,
    { method: 'PUT', body },
  );
}

function formPayload(): TalktomeAccountMappingInput {
  return {
    enabled: form.enabled,
    key: form.key.trim(),
    endpointKind: form.endpointKind,
    ...(form.endpointKind === 'feed'
      ? { talktomeFeedId: Number(form.talktomeFeedId), target: null }
      : {
          talktomeUserId: Number(form.talktomeUserId),
          target: {
            type: form.targetType,
            id: Number(form.targetId),
          },
        }),
    ptt: {
      mode: form.pttMode,
      thresholdDb: Number(form.thresholdDb),
      holdMs: Number(form.holdMs),
      gpi: Number(form.gpi),
    },
    tally: {
      ...(form.activeGpo !== '' ? { activeGpo: Number(form.activeGpo) } : {}),
      ...(form.liveGpo !== '' ? { liveGpo: Number(form.liveGpo) } : {}),
    },
    mixLocalCallers: form.mixLocalCallers,
    bitrateBps: Number(form.bitrateBps),
  };
}

function mappingPayload(
  mapping: TalktomeAccountMapping,
  enabled: boolean,
): TalktomeAccountMappingInput {
  return {
    enabled,
    key: mapping.key,
    endpointKind: mapping.endpointKind ?? 'user',
    ...(isFeedMapping(mapping)
      ? { talktomeFeedId: mapping.talktomeFeedId, target: null }
      : {
          talktomeUserId: mapping.talktomeUserId,
          target: mapping.target ? { ...mapping.target } : null,
        }),
    ptt: { ...mapping.ptt },
    tally: { ...mapping.tally },
    mixLocalCallers: mapping.mixLocalCallers,
    bitrateBps: mapping.bitrateBps,
  };
}

function validateForm(): string {
  if (!form.accountUri.trim()) return 'Select a configured SIP account.';
  if (form.endpointKind === 'feed') {
    if (
      !Number.isSafeInteger(Number(form.talktomeFeedId)) ||
      Number(form.talktomeFeedId) < 1
    ) {
      return 'TalkToMe feed endpoint must be a positive integer.';
    }
  } else if (
    !Number.isSafeInteger(Number(form.talktomeUserId)) ||
    Number(form.talktomeUserId) < 1
  ) {
    return 'TalkToMe user endpoint must be a positive integer.';
  }
  if (
    !form.key.trim() ||
    form.key.trim().length > 120 ||
    !/^[A-Za-z0-9_.:@-]+$/.test(form.key.trim())
  ) {
    return 'Context key must be 1–120 characters and contain only letters, numbers, _, ., :, @, or -.';
  }
  if (!isFeedForm.value) {
    if (!Number.isSafeInteger(Number(form.targetId)) || Number(form.targetId) < 1) {
      return 'Target ID must be a positive integer.';
    }
    const allowedTargets = targetOptions.value;
    if (
      allowedTargets.length &&
      !allowedTargets.some(
        target => target.type === form.targetType && target.id === Number(form.targetId),
      )
    ) {
      return 'Select a target allowed for this TalkToMe user endpoint.';
    }
  }
  if (
    !Number.isFinite(Number(form.thresholdDb)) ||
    Number(form.thresholdDb) < -120 ||
    Number(form.thresholdDb) > -10
  ) {
    return 'Audio threshold must be between -120 and -10 dB.';
  }
  if (
    !Number.isSafeInteger(Number(form.holdMs)) ||
    Number(form.holdMs) < 0 ||
    Number(form.holdMs) > 60_000
  ) {
    return 'PTT hold must be an integer between 0 and 60000 ms.';
  }
  if (!gpioOptions.includes(Number(form.gpi) as (typeof gpioOptions)[number])) {
    return 'External GPI must be between 1 and 6.';
  }
  const activeGpo = form.activeGpo === '' ? undefined : Number(form.activeGpo);
  const liveGpo = form.liveGpo === '' ? undefined : Number(form.liveGpo);
  if (
    (activeGpo !== undefined &&
      !gpioOptions.includes(activeGpo as (typeof gpioOptions)[number])) ||
    (liveGpo !== undefined &&
      !gpioOptions.includes(liveGpo as (typeof gpioOptions)[number]))
  ) {
    return 'Tally GPO values must be between 1 and 6.';
  }
  if (activeGpo !== undefined && activeGpo === liveGpo) {
    return 'Active and live tally cannot use the same GPO.';
  }
  if (
    !Number.isSafeInteger(Number(form.bitrateBps)) ||
    Number(form.bitrateBps) < 6_000 ||
    Number(form.bitrateBps) > 510_000
  ) {
    return 'Audio bitrate must be an integer between 6000 and 510000 bps.';
  }
  return '';
}

function runtimeStatusFor(accountUri: string): TalktomeBridgeStatus | undefined {
  const statuses = props.globalStatus !== null ? props.statuses : apiStatuses.value;
  const key = normalizeUri(accountUri);
  return statuses.find(status => normalizeUri(status.accountUri) === key);
}

function reportMutationResult(result: MutationResponse, successMessage: string) {
  if (result.runtimeError) {
    actionError.value = `${successMessage} Runtime refresh failed: ${result.runtimeError}`;
    return;
  }
  actionMessage.value = result.requiresRestart
    ? `${successMessage} Restart baresip to apply the audio device change.`
    : successMessage;
}

function accountName(accountUri: string): string {
  const key = normalizeUri(accountUri);
  return (
    configuredAccounts.value.find(account => normalizeUri(account.uri) === key)
      ?.displayName || accountUri
  );
}

function isFeedMapping(
  mapping: TalktomeAccountMapping,
): mapping is TalktomeFeedAccountMapping {
  return (mapping.endpointKind ?? 'user') === 'feed';
}

function endpointLabel(mapping: TalktomeAccountMapping): string {
  if (isFeedMapping(mapping)) {
    const feedId = mapping.talktomeFeedId ?? 0;
    const port = feedPorts.value.find(candidate => candidate.feedId === feedId);
    return port ? `${port.label} (feed ${feedId})` : `Feed ${feedId}`;
  }
  const userId = mapping.talktomeUserId ?? 0;
  const port = userPorts.value.find(candidate => candidate.userId === userId);
  return port ? `${port.label} (user ${userId})` : `User ${userId}`;
}

function targetLabel(target: TalktomeTarget | null): string {
  if (!target) return 'None';
  const portTarget = userPorts.value
    .flatMap(port => port.triggerTargets)
    .find(candidate => candidate.type === target.type && candidate.id === target.id);
  return portTarget
    ? `${portTarget.name} (${target.type} ${target.id})`
    : `${capitalize(target.type)} ${target.id}`;
}

function endpointOptionValue(
  port: TalktomeBridgeServerUserPort | TalktomeBridgeServerFeedPort,
): string {
  return port.kind === 'feed' ? `feed:${port.feedId}` : `user:${port.userId}`;
}

function endpointOptionLabel(
  port: TalktomeBridgeServerUserPort | TalktomeBridgeServerFeedPort,
): string {
  return port.kind === 'feed'
    ? `${port.label} (feed ${port.feedId})`
    : `${port.label} (user ${port.userId})`;
}

function defaultEndpointKey(
  port: TalktomeBridgeServerUserPort | TalktomeBridgeServerFeedPort,
): string {
  return port.kind === 'feed' ? `feed-${port.feedId}` : String(port.userId);
}

function preferredEndpoint(
  ports: Array<TalktomeBridgeServerUserPort | TalktomeBridgeServerFeedPort>,
): TalktomeBridgeServerUserPort | TalktomeBridgeServerFeedPort | undefined {
  return ports.find(port => port.enabled) ?? ports[0];
}

function preferredTarget(
  port: TalktomeBridgeServerUserPort | TalktomeBridgeServerFeedPort | undefined,
): TalktomeTarget | undefined {
  return port?.kind === 'user'
    ? port.trigger.target ?? port.triggerTargets[0]
    : undefined;
}

function phaseDotClass(phase?: string): string {
  if (phase === 'connected') return 'bg-green-500';
  if (phase === 'starting' || phase === 'stopping' || phase === 'waiting-baresip') {
    return 'bg-yellow-400';
  }
  if (phase === 'degraded') return 'bg-orange-400';
  if (phase === 'failed') return 'bg-red-500';
  return 'bg-gray-500';
}

function phaseBadgeClass(phase?: string): string {
  if (phase === 'connected') return 'bg-green-900/50 text-green-300';
  if (phase === 'starting' || phase === 'stopping') {
    return 'bg-yellow-900/50 text-yellow-300';
  }
  if (phase === 'degraded') return 'bg-orange-900/50 text-orange-300';
  if (phase === 'failed') return 'bg-red-900/50 text-red-300';
  return 'bg-gray-700 text-gray-300';
}

function formatPhase(phase?: string): string {
  if (!phase) return 'Unknown';
  return phase
    .split('-')
    .map(capitalize)
    .join(' ');
}

function eventTransportLabel(
  transport: TalktomeBridgeStatus['eventTransport'] | undefined,
): string {
  if (transport === 'sse') return 'SSE';
  if (transport === 'poll') return 'Polling';
  if (transport === 'disconnected') return 'Disconnected';
  return 'Unavailable';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeUri(value: string): string {
  return value.toLowerCase().trim();
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback;
  const candidate = error as {
    message?: string;
    status?: number;
    statusCode?: number;
    response?: {
      status?: number;
      _data?: {
        message?: string;
        statusMessage?: string;
        statusCode?: number;
      };
    };
    data?: {
      message?: string;
      statusMessage?: string;
      statusCode?: number;
      data?: { issues?: unknown };
      issues?: unknown;
    };
  };
  const message =
    candidate.data?.message ||
    candidate.data?.statusMessage ||
    candidate.response?._data?.message ||
    candidate.response?._data?.statusMessage ||
    candidate.message ||
    fallback;
  const statusCode =
    candidate.statusCode ??
    candidate.status ??
    candidate.data?.statusCode ??
    candidate.response?._data?.statusCode ??
    candidate.response?.status;
  if (statusCode === 409 && /\bcalls?\b/i.test(message)) {
    return 'Hang up all active calls for this SIP account before changing or removing its TalkToMe mapping, then try again.';
  }
  const rawIssues = candidate.data?.data?.issues ?? candidate.data?.issues;
  const issues = Array.isArray(rawIssues)
    ? rawIssues.filter((issue): issue is string => typeof issue === 'string')
    : [];
  return issues.length ? `${message}: ${issues.join('; ')}` : message;
}

onMounted(loadConfig);

watch(
  () => props.globalStatus?.serverReachable,
  (reachable, wasReachable) => {
    if (
      reachable &&
      !wasReachable &&
      featureEnabled.value === true &&
      server.value === null &&
      !loading.value
    ) {
      loadConfig();
    }
  },
);
</script>
