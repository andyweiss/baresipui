export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: false },

  modules: ['@nuxtjs/tailwindcss'],

  runtimeConfig: {
    public: {
      wsPath: process.env.NUXT_PUBLIC_WS_PATH || '/ws',
      apiUrl: process.env.NUXT_PUBLIC_API_URL || '/api'
    }
  },

  ssr: false
})
