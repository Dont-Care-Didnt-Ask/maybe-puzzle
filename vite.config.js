import { defineConfig } from 'vite';

export default defineConfig({
  // No hardcoded username/repository: works at /, /repo/, and /repo/index.html.
  base: './',
});
