import { defineConfig } from 'vite';

// demo build: `index.html` at the repo root → dist-demo (static, deployable)
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    // Two pages: the simulator, and the moving map on the second screen.
    rollupOptions: { input: { main: 'index.html', map: 'map.html' } },
  },
  test: { environment: 'node' },
});
