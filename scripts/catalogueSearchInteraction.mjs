// Optional native Firefox runner, no dependency or local listener required.
import assert from 'node:assert/strict';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const entry = process.argv[2] ?? 'scripts/catalogueSearchInteraction.jsx';
const root = await mkdtemp(join(tmpdir(), 'catalogue-search-interaction-'));
try {
  await build({ configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, plugins: [react()], logLevel: 'error', build: { outDir: join(root, 'bundle'), minify: false, lib: { entry: join(process.cwd(), entry), name: 'SearchInteraction', formats: ['iife'] } } });
  const files = await readdir(join(root, 'bundle'));
  const script = await readFile(join(root, 'bundle', files.find(file => file.endsWith('.js'))), 'utf8');
  const css = (await Promise.all(files.filter(file => file.endsWith('.css')).map(file => readFile(join(root, 'bundle', file), 'utf8')))).join('\n');
  await writeFile(join(root, 'test.html'), `<!doctype html><meta charset="utf-8"><style>${css} body{margin:0}</style><div id="surface" class="catalogue-screen"></div><script>window.onerror=(message)=>dump("CATALOGUE_INTERACTION_ERROR "+message+"\\n");window.onunhandledrejection=(event)=>dump("CATALOGUE_INTERACTION_ERROR "+event.reason+"\\n");</script><script>${script.replaceAll('</script', '<\\/script')}</script>`);
  for (const width of [1440, 600]) {
    const profile = join(root, `profile-${width}`);
    await mkdir(profile);
    await writeFile(join(profile, 'user.js'), 'user_pref("browser.dom.window.dump.enabled", true);\n');
    const browser = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, '--window-size', `${width},700`, `file://${join(root, 'test.html')}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => browser.kill('SIGTERM'), 30000);
    browser.stdout.on('data', data => { output += data; if (/CATALOGUE_INTERACTION_(OK|ERROR)/.test(output)) browser.kill('SIGTERM'); });
    browser.stderr.on('data', data => { errors += data; });
    try {
      await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('close', (code, signal) => { errors += ` exit=${code} signal=${signal}`; resolve(); }); });
      assert.match(output, /CATALOGUE_INTERACTION_OK/, output || `Firefox produced no interaction result: ${errors}`);
      console.log(`${width}px: ${entry} OK`);
    } finally { clearTimeout(timer); browser.kill('SIGTERM'); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
