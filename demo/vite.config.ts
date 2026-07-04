import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Served from GitHub Pages at https://<user>.github.io/hygc-editor/
export default defineConfig({
  base: '/hygc-editor/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The demo consumes the package straight from source — it is the
      // reference EditorHost implementation, so it should only import through
      // the public entry point.
      '@hygc/editor': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['..'] },
  },
})
