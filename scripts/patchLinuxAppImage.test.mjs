import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  APPIMAGE_RUNTIME,
  APPIMAGE_TOOL,
  resolveAppImage,
  XDG_OPEN_WRAPPER,
} from './patch-linux-appimage.mjs';

test('AppImage repacking tool is immutable and integrity-pinned', () => {
  for (const artifact of [APPIMAGE_TOOL, APPIMAGE_RUNTIME]) {
    assert.doesNotMatch(artifact.url, /continuous|latest/);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(APPIMAGE_TOOL.version, '1.9.1');
  assert.match(APPIMAGE_TOOL.url, /\/releases\/download\/1\.9\.1\//);
  assert.equal(APPIMAGE_RUNTIME.version, '20251108');
  assert.match(APPIMAGE_RUNTIME.url, /\/releases\/download\/20251108\//);
});

test('external URL wrapper clears AppImage library and GTK environments', () => {
  for (const variable of [
    'LD_LIBRARY_PATH',
    'GDK_BACKEND',
    'GIO_EXTRA_MODULES',
    'GST_PLUGIN_SYSTEM_PATH',
  ]) {
    assert.match(XDG_OPEN_WRAPPER, new RegExp(`unset [^\\n]*${variable}`));
  }
  assert.match(XDG_OPEN_WRAPPER, /exec "\$candidate" "\$@"/);
  assert.doesNotMatch(XDG_OPEN_WRAPPER, /eval|sh -c/);
});

test('AppImage directory resolution refuses ambiguous bundle outputs', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'story-studio-appimage-test-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(resolveAppImage(directory), /found 0/);
  await writeFile(join(directory, 'Story Studio.AppImage'), 'fixture');
  assert.equal(
    await resolveAppImage(directory),
    join(directory, 'Story Studio.AppImage'),
  );
  await writeFile(join(directory, 'duplicate.AppImage'), 'fixture');
  await assert.rejects(resolveAppImage(directory), /found 2/);
});
