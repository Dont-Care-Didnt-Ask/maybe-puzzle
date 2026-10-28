import { defineConfig } from 'vite';

export default defineConfig({
  // No hardcoded username/repository: works at /, /repo/, and /repo/index.html.
  base: './',
  // scripts/build.mjs copies only validated training versions and other public assets.
  build: { copyPublicDir: false },
});
