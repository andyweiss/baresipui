<template>
  <div class="min-h-screen bg-gray-900 flex items-center justify-center px-4">
    <div class="w-full max-w-sm bg-gray-800 rounded-lg shadow-lg p-8">
      <h1 class="text-2xl font-bold text-white mb-6 text-center">Baresip UI</h1>
      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div>
          <label class="block text-sm text-gray-300 mb-1" for="username">Username</label>
          <input
            id="username"
            v-model="username"
            type="text"
            autocomplete="username"
            required
            class="w-full px-3 py-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label class="block text-sm text-gray-300 mb-1" for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            class="w-full px-3 py-2 rounded bg-gray-700 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
        <button
          type="submit"
          :disabled="submitting"
          class="w-full py-2 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium transition"
        >
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
const username = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);
const route = useRoute();

function redirectTarget() {
  const redirect = route.query.redirect;
  return typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/';
}

onMounted(async () => {
  try {
    const status: any = await $fetch('/api/auth/status');
    if (!status.enabled || status.authenticated) {
      await navigateTo(redirectTarget());
    }
  } catch {
    // Stay on the login form if the status check itself fails.
  }
});

const handleSubmit = async () => {
  error.value = '';
  submitting.value = true;
  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value }
    });
    await navigateTo(redirectTarget());
  } catch {
    error.value = 'Invalid username or password';
  } finally {
    submitting.value = false;
  }
};
</script>
