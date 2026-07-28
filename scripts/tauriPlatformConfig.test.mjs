import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const merged = target && typeof target === 'object' && !Array.isArray(target)
    ? { ...target }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

test('Tauri platform configs resolve with replacement arrays and isolated tool resources', async () => {
  const common = await readJson('../src-tauri/tauri.conf.json');
  const windows = mergePatch(common, await readJson('../src-tauri/tauri.windows.conf.json'));
  const linux = mergePatch(common, await readJson('../src-tauri/tauri.linux.conf.json'));
  const macos = mergePatch(common, await readJson('../src-tauri/tauri.macos.conf.json'));

  assert.deepEqual(windows.bundle.targets, ['nsis', 'msi']);
  assert.deepEqual(linux.bundle.targets, ['appimage', 'deb', 'rpm']);
  assert.deepEqual(macos.bundle.targets, ['app', 'dmg']);
  assert.equal(windows.bundle.resources['tools/ffmpeg.exe'], 'tools/ffmpeg.exe');
  assert.equal(windows.bundle.resources['tools/7z.exe'], 'tools/7z.exe');
  assert.equal(linux.bundle.resources['tools/ffmpeg.exe'], undefined);
  assert.equal(linux.bundle.resources['tools/7z.exe'], undefined);
  assert.equal(linux.bundle.resources['tools/linux-x86_64/ffmpeg'], 'tools/ffmpeg');
  assert.equal(linux.bundle.resources['tools/linux-x86_64/7zz'], 'tools/7zz');
  assert.equal(macos.bundle.resources['tools/macos-aarch64/ffmpeg'], 'tools/ffmpeg');
  assert.equal(macos.bundle.resources['tools/macos-aarch64/7zz'], 'tools/7zz');
  assert.equal(
    windows.bundle.resources['tools/windows-x86_64/piper/'],
    'tools/piper/',
  );
  assert.equal(
    linux.bundle.resources['tools/linux-x86_64/piper/'],
    'tools/piper/',
  );
  assert.equal(
    macos.bundle.resources['tools/macos-aarch64/piper/'],
    'tools/piper/',
  );
  assert.equal(linux.bundle.resources['../LICENSE'], 'LICENSE');
  assert.equal(macos.bundle.resources['../LICENSE'], 'LICENSE');
  assert.equal(linux.app.windows[0].decorations, false);
  assert.equal(macos.app.windows[0].decorations, false);
  assert.equal(linux.app.enableGTKAppId, true);
  assert.equal(linux.bundle.linux.appimage.bundleMediaFramework, true);
  assert.equal(macos.bundle.macOS.minimumSystemVersion, '11.0');
  assert.equal(macos.bundle.macOS.signingIdentity, '-');
  assert.equal(macos.bundle.macOS.hardenedRuntime, false);
  assert.equal(macos.bundle.macOS.infoPlist, 'Info.plist');
  assert.equal(common.bundle.category, 'Education');
  assert.equal(common.bundle.license, 'MIT');
  assert.equal(common.bundle.homepage, 'https://hugs11.github.io/story-studio/');
  assert.equal(
    linux.bundle.linux.deb.desktopTemplate,
    'linux/story-studio.desktop.hbs',
  );
  assert.equal(
    linux.bundle.linux.rpm.desktopTemplate,
    'linux/story-studio.desktop.hbs',
  );
});

test('Linux bundles match their desktop entry to the GTK application ID', async () => {
  const common = await readJson('../src-tauri/tauri.conf.json');
  const desktopTemplate = await readFile(
    new URL('../src-tauri/linux/story-studio.desktop.hbs', import.meta.url),
    'utf8',
  );

  assert.match(desktopTemplate, new RegExp(`^StartupWMClass=${common.identifier}$`, 'm'));
  assert.match(desktopTemplate, /^Icon=\{\{icon\}\}$/m);
});

test('Tauri filesystem scopes are split by platform and preserve removable media access', async () => {
  const common = await readJson('../src-tauri/capabilities/default.json');
  const windows = await readJson('../src-tauri/capabilities/filesystem-windows.json');
  const linux = await readJson('../src-tauri/capabilities/filesystem-linux.json');
  const macos = await readJson('../src-tauri/capabilities/filesystem-macos.json');

  assert.equal(common.permissions.some((permission) => typeof permission === 'object'), false);
  assert.deepEqual(windows.platforms, ['windows']);
  assert.deepEqual(linux.platforms, ['linux']);
  assert.deepEqual(macos.platforms, ['macOS']);

  for (const permission of linux.permissions) {
    const denied = new Set(permission.deny.map(({ path }) => path));
    for (const systemPath of ['/boot/**', '/dev/**', '/etc/**', '/proc/**', '/root/**', '/sys/**', '/usr/**']) {
      assert.equal(denied.has(systemPath), true, `${permission.identifier} must deny ${systemPath}`);
    }
    assert.equal(denied.has('/run'), true);
    assert.equal(denied.has('/run/**'), false, '/run/media must stay available for removable media');
    assert.equal(permission.allow.some(({ path }) => path === '**'), true);
  }

  for (const permission of macos.permissions) {
    const denied = new Set(permission.deny.map(({ path }) => path));
    for (const systemPath of [
      '/System/**',
      '/Library/**',
      '/private/**',
      '/usr/**',
      '/bin/**',
      '/sbin/**',
      '/dev/**',
    ]) {
      assert.equal(denied.has(systemPath), true, `${permission.identifier} must deny ${systemPath}`);
    }
    assert.equal(denied.has('/Volumes'), false);
    assert.equal(denied.has('/Volumes/**'), false);
    assert.equal(permission.allow.some(({ path }) => path === '**'), true);
  }
});

test('macOS bundle declares microphone usage without Apple credentials', async () => {
  const config = JSON.stringify(await readJson('../src-tauri/tauri.macos.conf.json'));
  const plist = await readFile(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');

  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.doesNotMatch(config, /APPLE_|notari|Developer ID|teamId/i);
});

test('frontend-visible temporary media uses the app-owned cache instead of the system temp dir', async () => {
  const [textImages, imageExports, fileCommands, podcastCommands, youtubeCommands, comfyCommands] =
    await Promise.all([
      readFile(new URL('../src/components/TextImageGenerator/generateTextImage.js', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/ImageEditorModal/imageEditorExport.js', import.meta.url), 'utf8'),
      readFile(new URL('../src-tauri/src/commands/files.rs', import.meta.url), 'utf8'),
      readFile(new URL('../src-tauri/src/commands/podcast.rs', import.meta.url), 'utf8'),
      readFile(new URL('../src-tauri/src/commands/youtube.rs', import.meta.url), 'utf8'),
      readFile(new URL('../src-tauri/src/commands/comfyui.rs', import.meta.url), 'utf8'),
    ]);

  for (const frontendSource of [textImages, imageExports]) {
    assert.match(frontendSource, /appCacheDir/);
    assert.doesNotMatch(frontendSource, /\btempDir\b|BaseDirectory\.Temp/);
  }

  assert.match(fileCommands, /app_cache_subdir[\s\S]*TEMP_IMAGES_DIR/);
  assert.match(fileCommands, /app_cache_subdir[\s\S]*AUDIO_PREVIEWS_DIR/);
  assert.match(podcastCommands, /app_cache_subdir[\s\S]*PODCAST_MEDIA_DIR/);
  assert.match(youtubeCommands, /app_cache_subdir[\s\S]*YOUTUBE_MEDIA_DIR/);
  assert.match(comfyCommands, /app_cache_subdir[\s\S]*TEMP_IMAGES_DIR/);
});
