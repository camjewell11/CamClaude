import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // index.ts loads host.ts (the full app) or client.ts (a window onto another PC). As entries
      // of their own they land next to index.js, so their paths to ../renderer still hold.
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          host: resolve('src/main/host.ts'),
          client: resolve('src/main/client.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // A sandboxed preload must be CommonJS, even though the main process is ESM.
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), client: resolve('src/preload/client.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
})
