// An experiment: the workbench split into chunks as Vite makes them (lazy parts load when used) instead of one bundle,
// to see how much of it the start really needs. Output in dist-split (ES modules, for a desktop browser).
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config.mjs'

export default mergeConfig(base, defineConfig({
  plugins: [],
  build: {
    outDir: 'dist-split',
    rollupOptions: {
      output: {
        format: 'es',
        inlineDynamicImports: false,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js'
      }
    }
  }
}))
