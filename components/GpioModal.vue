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
        <div class="relative bg-gray-800 rounded-xl shadow-2xl border border-gray-700 w-full max-w-sm z-10">
          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <div>
              <h2 class="text-lg font-semibold text-white">GPIO</h2>
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

          <!-- GPIO Grid -->
          <div class="p-6">
            <div class="grid grid-cols-2 gap-6">
              <!-- Outgoing GPIOs -->
              <div>
                <h3 class="text-xs text-gray-400 uppercase tracking-wide mb-3">Outgoing</h3>
                <div class="space-y-2">
                  <button
                    v-for="i in 6"
                    :key="'out-' + i"
                    @click="toggleOut(i)"
                    :disabled="toggling[i]"
                    class="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors"
                    :class="gpioState.gpioOut[i - 1]
                      ? 'bg-green-900/40 hover:bg-green-900/60'
                      : 'bg-gray-700/50 hover:bg-gray-700'"
                  >
                    <!-- LED indicator -->
                    <div
                      class="w-3 h-3 rounded-full flex-shrink-0 transition-colors"
                      :class="gpioState.gpioOut[i - 1]
                        ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]'
                        : 'bg-gray-600'"
                    />
                    <span class="text-sm font-mono" :class="gpioState.gpioOut[i - 1] ? 'text-green-300' : 'text-gray-400'">
                      GPIO {{ i }}
                    </span>
                    <span class="ml-auto text-xs" :class="gpioState.gpioOut[i - 1] ? 'text-green-400' : 'text-gray-500'">
                      {{ gpioState.gpioOut[i - 1] ? 'ON' : 'OFF' }}
                    </span>
                  </button>
                </div>
              </div>

              <!-- Incoming GPIOs -->
              <div>
                <h3 class="text-xs text-gray-400 uppercase tracking-wide mb-3">Incoming</h3>
                <div class="space-y-2">
                  <div
                    v-for="i in 6"
                    :key="'in-' + i"
                    class="w-full flex items-center gap-3 px-3 py-2 rounded-lg"
                    :class="gpioState.gpioIn[i - 1]
                      ? 'bg-blue-900/40'
                      : 'bg-gray-700/50'"
                  >
                    <!-- LED indicator -->
                    <div
                      class="w-3 h-3 rounded-full flex-shrink-0 transition-colors"
                      :class="gpioState.gpioIn[i - 1]
                        ? 'bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.6)]'
                        : 'bg-gray-600'"
                    />
                    <span class="text-sm font-mono" :class="gpioState.gpioIn[i - 1] ? 'text-blue-300' : 'text-gray-400'">
                      GPIO {{ i }}
                    </span>
                    <span class="ml-auto text-xs" :class="gpioState.gpioIn[i - 1] ? 'text-blue-400' : 'text-gray-500'">
                      {{ gpioState.gpioIn[i - 1] ? 'ON' : 'OFF' }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import type { GpioState } from '~/types';
import { createDefaultGpioState } from '~/types';

const props = defineProps<{
  show: boolean;
  accountUri: string;
  gpioState: GpioState;
}>();

const emit = defineEmits<{
  close: [];
  toggleGpio: [gpioIndex: number, state: boolean];
}>();

const toggling = ref<Record<number, boolean>>({});

const accountName = computed(() => {
  const match = props.accountUri?.match(/^sip:([^@]+)/);
  return match ? match[1] : props.accountUri;
});

const toggleOut = async (gpioIndex: number) => {
  if (toggling.value[gpioIndex]) return;
  toggling.value[gpioIndex] = true;
  try {
    const newState = !props.gpioState.gpioOut[gpioIndex - 1];
    emit('toggleGpio', gpioIndex, newState);
  } finally {
    // Small delay to prevent rapid clicking
    setTimeout(() => {
      toggling.value[gpioIndex] = false;
    }, 300);
  }
};
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
</style>
