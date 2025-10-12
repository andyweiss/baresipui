export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: false },

  modules: ['@nuxtjs/tailwindcss'],

  runtimeConfig: {
    public: {
      wsUrl: process.env.NUXT_PUBLIC_WS_URL || 'ws://localhost:4000',
      apiUrl: process.env.NUXT_PUBLIC_API_URL || 'http://localhost:4000'
    }
  },

  ssr: false
})
