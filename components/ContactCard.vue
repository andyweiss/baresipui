<template>
  <div class="bg-gray-800 rounded-lg shadow-lg p-4 border-l-4" :class="borderColor">
    <div class="flex items-center justify-between">
      <div class="flex-1">
        <h4 class="text-sm font-semibold text-white">{{ contact.contact }}</h4>
        <div class="flex items-center gap-3 mt-2">
          <span class="text-xs font-medium" :class="presenceColor">
            {{ contact.presence || 'unknown' }}
          </span>
          <span class="text-xs text-gray-400">
            Auto-Connect: {{ contact.status || 'Off' }}
          </span>
        </div>
      </div>
      <div class="ml-3">
        <button
          @click="$emit('toggle', contact.contact, !contact.enabled)"
          class="px-3 py-1.5 text-xs font-medium rounded transition"
          :class="contact.enabled
            ? 'bg-green-600 text-white hover:bg-green-700'
            : 'bg-gray-600 text-gray-300 hover:bg-gray-500'"
        >
          {{ contact.enabled ? 'Enabled' : 'Disabled' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  contact: any;
}>();

defineEmits(['toggle']);

const borderColor = computed(() => {
  if (props.contact.status === 'Connected') return 'border-green-500';
  if (props.contact.status === 'Connecting') return 'border-blue-500';
  if (props.contact.status === 'Failed') return 'border-red-500';
  return 'border-gray-300';
});

const presenceColor = computed(() => {
  if (props.contact.presence === 'online') return 'text-green-400';
  if (props.contact.presence === 'offline') return 'text-gray-400';
  return 'text-gray-500';
});
</script>
