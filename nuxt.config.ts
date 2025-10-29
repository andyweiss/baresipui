export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: false },

  modules: ['@nuxtjs/tailwindcss'],

  runtimeConfig: {
    baresipHost: process.env.BARESIP_HOST || 'baresip',
    baresipPort: process.env.BARESIP_PORT || '4444',

    public: {
      wsEnabled: true
    }
  },

  nitro: {
    experimental: {
      websocket: true
    }
  },

  ssr: false
})
