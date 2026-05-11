import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Intelligent Progress Assistant',
        short_name: 'IPA',
        description: 'Set SMART goals, build a plan, get proactive check-ins.',
        theme_color: '#4f46e5',
        background_color: '#0b1020',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /\.(?:js|css|html|svg|png|webp|woff2?)$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'ipa-assets' },
          },
        ],
      },
    }),
  ],
  server: { host: true, port: 5173 },
});
