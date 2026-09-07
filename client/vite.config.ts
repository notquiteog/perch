import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the console runs from Vite and the API from the server, so
// everything under /api goes to the server's port. In production the server
// serves the built files itself and there is no proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PERCH_CONSOLE_PORT || 8099}`,
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
