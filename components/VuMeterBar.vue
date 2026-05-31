<template>
  <div :class="vertical ? 'vu-meter-vertical' : 'vu-meter-bar'">
    <div :class="vertical ? 'vu-meter-track-v' : 'vu-meter-track'">
      <!-- Scale lines at -3, -9, -20 dB -->
      <div
        v-if="showScale"
        v-for="mark in scaleMarks"
        :key="mark.db"
        class="vu-meter-scale"
        :style="vertical
          ? { bottom: mark.percent + '%', left: 0, right: 0, height: '1px', width: '100%' }
          : { left: mark.percent + '%', top: 0, bottom: 0, width: '1px', height: '100%' }"
      ></div>
      <!-- Dark mask -->
      <div
        class="vu-meter-mask"
        :style="vertical
          ? { bottom: fillPercent + '%', top: 0 }
          : { left: fillPercent + '%' }"
      ></div>
      <!-- Peak hold -->
      <div
        v-if="peakPercent > 0.5"
        class="vu-meter-peak"
        :style="vertical
          ? { bottom: peakPercent + '%', left: 0, right: 0, width: 'auto', height: '2px', transform: 'translateY(1px)' }
          : { left: peakPercent + '%' }"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  /** Current level in dBFS (negative, e.g. -18.2) */
  level: { type: Number, required: true, default: -96 },
  /** Minimum displayable level in dBFS */
  minDb: { type: Number, default: -60 },
  /** Maximum displayable level in dBFS */
  maxDb: { type: Number, default: 0 },
  /** Vertical orientation */
  vertical: { type: Boolean, default: false },
  /** Show scale lines */
  showScale: { type: Boolean, default: false },
});

// --- PPM smoothing (IEC 60268-10 Type II) ---
// Rise: essentially instantaneous (< 10ms integration)
// Fall: 20 dB in 1.7 seconds ≈ 11.76 dB/s
const FALL_RATE_DB_PER_SEC = 20 / 1.7;
const PEAK_HOLD_MS = 1500;
const PEAK_FALL_RATE = 20 / 1.0;

let smoothedDb = -96;
let peakDb = -96;
let peakHoldTime = 0;
let lastFrameTime = 0;
let animFrameId = 0;

const fillPercent = ref(0);
const peakPercent = ref(0);

function dbToPercent(db: number): number {
  const clamped = Math.max(props.minDb, Math.min(props.maxDb, db));
  return ((clamped - props.minDb) / (props.maxDb - props.minDb)) * 100;
}

const scaleMarks = computed(() => [
  { db: -3, percent: dbToPercent(-3) },
  { db: -9, percent: dbToPercent(-9) },
  { db: -18, percent: dbToPercent(-18) },
  { db: -30, percent: dbToPercent(-30) },
  { db: -42, percent: dbToPercent(-42) },
  { db: -54, percent: dbToPercent(-54) },
]);

function animate(timestamp: number) {
  if (!lastFrameTime) lastFrameTime = timestamp;
  const dt = (timestamp - lastFrameTime) / 1000;
  lastFrameTime = timestamp;

  const targetDb = props.level;

  // Rise: instant (PPM attack < 10ms, our updates are 100ms)
  // Fall: decay at FALL_RATE_DB_PER_SEC
  if (targetDb >= smoothedDb) {
    smoothedDb = targetDb;
  } else {
    smoothedDb = Math.max(targetDb, smoothedDb - FALL_RATE_DB_PER_SEC * dt);
  }

  // Peak hold logic
  if (targetDb >= peakDb) {
    peakDb = targetDb;
    peakHoldTime = timestamp;
  } else if (timestamp - peakHoldTime > PEAK_HOLD_MS) {
    peakDb = Math.max(targetDb, peakDb - PEAK_FALL_RATE * dt);
  }

  fillPercent.value = dbToPercent(smoothedDb);
  peakPercent.value = dbToPercent(peakDb);

  animFrameId = requestAnimationFrame(animate);
}

onMounted(() => {
  animFrameId = requestAnimationFrame(animate);
});

onUnmounted(() => {
  cancelAnimationFrame(animFrameId);
});

watch(() => props.level, (newVal, oldVal) => {
  if (oldVal <= props.minDb && newVal > props.minDb) {
    smoothedDb = newVal;
  }
});
</script>

<style scoped>
/* Horizontal mode */
.vu-meter-bar {
  width: 100%;
  height: 6px;
}

.vu-meter-track {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 2px;
  overflow: hidden;
  /* Flat color zones: green < -9dB | orange -9..-3dB | red -3..0dB */
  /* -9dB = 85%, -3dB = 95% (with minDb=-60, maxDb=0) */
  background: linear-gradient(
    to right,
    #22c55e 0%,
    #22c55e 85%,
    #f97316 85%,
    #f97316 95%,
    #ef4444 95%,
    #ef4444 100%
  );
}

/* Vertical mode */
.vu-meter-vertical {
  width: 100%;
  height: 100%;
}

.vu-meter-track-v {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 2px;
  overflow: hidden;
  /* Flat color zones: green < -9dB | orange -9..-3dB | red -3..0dB */
  background: linear-gradient(
    to top,
    #22c55e 0%,
    #22c55e 85%,
    #f97316 85%,
    #f97316 95%,
    #ef4444 95%,
    #ef4444 100%
  );
}

/* Dark mask covers the unfilled area */
.vu-meter-mask {
  position: absolute;
  background: #1f2937;
  z-index: 1;
}

/* Horizontal mask: right side */
.vu-meter-track > .vu-meter-mask {
  top: 0;
  right: 0;
  height: 100%;
}

/* Vertical mask: top side */
.vu-meter-track-v > .vu-meter-mask {
  top: 0;
  left: 0;
  right: 0;
  width: 100%;
}

/* Peak hold marker */
.vu-meter-peak {
  position: absolute;
  background: #e5e7eb;
  opacity: 0.7;
  z-index: 2;
}

/* Horizontal peak: vertical line */
.vu-meter-track > .vu-meter-peak {
  top: 0;
  width: 2px;
  height: 100%;
  transform: translateX(-1px);
}

/* Scale reference lines */
.vu-meter-scale {
  position: absolute;
  background: rgba(0, 0, 0, 0.5);
  z-index: 3;
  pointer-events: none;
}
</style>
