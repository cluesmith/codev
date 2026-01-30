import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4200',
      '/ws': {
        target: 'ws://localhost:4200',
        ws: true,
      },
      '/terminal': 'http://localhost:4200',
      '/annotation': 'http://localhost:4200',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
