import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.js';
import { installCollector } from './lib/webdriver/collector.mjs';

export default defineConfig(async context => mergeConfig(await base(context), {
  plugins: [{
    name: 'e2e-webdriver-collector',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', injectTo: 'head-prepend', children:
        `(${installCollector.toString()})(${JSON.stringify(process.env.SS_E2E_WORKSPACE)});` }],
    },
  }],
}));
