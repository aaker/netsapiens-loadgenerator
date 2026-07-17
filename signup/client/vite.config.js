import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Served under /signup on the portal host (v46lab.ucaas.tech/signup). This
  // bakes /signup/ into asset URLs and import.meta.env.BASE_URL. Must match
  // SIGNUP_BASE_PATH on the server.
  base: '/signup/',
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/signup/api': 'http://localhost:3100'
    }
  }
});
