export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: false },

  modules: ['@nuxtjs/tailwindcss', 'nuxt-socket-io'],

  io: {
    sockets: [
      {
        name: 'main',
        url: process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000',
        default: true
      }
    ]
  },

  runtimeConfig: {
    baresipHost: process.env.BARESIP_HOST || 'baresip',
    baresipPort: process.env.BARESIP_PORT || '4444',
    contactsConfigPath: process.env.CONTACTS_CONFIG_PATH || '/config/contacts',
    accountsConfigPath: process.env.ACCOUNTS_CONFIG_PATH || '/config/accounts',
    asoundrcPath: process.env.ASOUNDRC_PATH || '/config/.asoundrc',

    public: {
      wsEnabled: true
    }
  },

  nitro: {
    experimental: {
      websocket: false
    }
  },

  ssr: false
})
