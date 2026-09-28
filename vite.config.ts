import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const src = resolve(root, 'src');
const outDir = resolve(root, 'dist');

/**
 * Three build targets, selected with `--mode`:
 *  - ui:         side panel + options page (React, HTML entries) and copies public/manifest.json
 *  - background: MV3 service worker (single ES module file)
 *  - content:    content script (single IIFE file: executeScript({files}) cannot load ES modules)
 */
export default defineConfig(({ mode }): UserConfig => {
  const base: UserConfig = {
    root: src,
    base: './',
    publicDir: false,
    build: { outDir, emptyOutDir: false, target: 'chrome114', modulePreload: false },
  };

  if (mode === 'background') {
    return {
      ...base,
      build: {
        ...base.build,
        minify: false,
        rollupOptions: {
          input: resolve(src, 'background/serviceWorker.ts'),
          output: { format: 'es', entryFileNames: 'background.js', codeSplitting: false },
        },
      },
    };
  }

  if (mode === 'content') {
    return {
      ...base,
      build: {
        ...base.build,
        minify: false,
        rollupOptions: {
          input: resolve(src, 'content/contentScript.ts'),
          output: { format: 'iife', entryFileNames: 'content.js', codeSplitting: false },
        },
      },
    };
  }

  return {
    ...base,
    plugins: [react()],
    publicDir: resolve(root, 'public'),
    build: {
      ...base.build,
      rollupOptions: {
        input: {
          sidepanel: resolve(src, 'sidepanel/index.html'),
          options: resolve(src, 'options/index.html'),
        },
      },
    },
  };
});
