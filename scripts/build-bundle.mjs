import { build } from 'vite'

await build({
  configFile: false,
  build: {
    target: 'node24',
    minify: false,
    emptyOutDir: true,
    lib: {
      entry: 'bin/extrabrain.ts',
      formats: ['cjs'],
      fileName: () => 'extrabrain.cjs'
    },
    outDir: 'dist',
    rollupOptions: {
      external: [/^node:/]
    }
  }
})
