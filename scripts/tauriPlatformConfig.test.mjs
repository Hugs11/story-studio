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
  assert.equal(
    windows.bundle.resources['../scripts/assets/windows-platform-tools.json'],
    'tools/platform-tools.json',
  );
  assert.equal(
    windows.bundle.resources['../scripts/assets/GPL-3.0.txt'],
    'tools/licenses/GPL-3.0.txt',
  );
  assert.equal(
    windows.bundle.resources['../scripts/assets/7-Zip-License.txt'],
    'tools/licenses/7-Zip-License.txt',
  );
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
  for (const config of [windows, linux, macos]) {
    assert.equal(
      config.bundle.resources['../THIRD_PARTY_SOURCE_OFFER.md'],
      'THIRD_PARTY_SOURCE_OFFER.md',
    );
  }
  for (const config of [linux, macos]) {
    assert.equal(
      Object.values(config.bundle.resources).includes('tools/licenses/7-Zip-License.txt'),
      true,
    );
  }
  assert.equal(
    Object.values(linux.bundle.resources).includes('tools/licenses/GPL-3.0.txt'),
    true,
  );
  assert.equal(
    Object.values(macos.bundle.resources).includes('tools/licenses/GPL-2.0.txt'),
    true,
  );
  assert.equal(linux.app.windows[0].decorations, false);
  assert.equal(macos.app.windows[0].decorations, false);
  for (const [platform, config] of Object.entries({ windows, linux, macos })) {
    assert.equal(
      config.app.windows[0].zoomHotkeysEnabled,
      false,
      `${platform} must leave page zoom disabled so interactive surfaces own wheel and pinch gestures`,
    );
  }
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
  const frontendHiddenDirectories = [
    '.story-studio-backups',
    '.story-studio-image-edits',
    '.story-studio-thumbnail',
  ];

  assert.equal(common.permissions.includes('fs:allow-appcache-write-recursive'), true);
  const commonFsScope = common.permissions.find(
    (permission) => permission?.identifier === 'fs:scope',
  );
  assert.deepEqual(
    new Set(commonFsScope.allow.map(({ path }) => path)),
    new Set([
      '$APPCACHE/**/.session-recovery.mbah*',
      ...frontendHiddenDirectories.flatMap((directory) => [
        `$APPCACHE/**/${directory}`,
        `$APPCACHE/**/${directory}/**`,
      ]),
    ]),
  );
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
  const linuxFsScope = linux.permissions.find(
    (permission) => permission?.identifier === 'fs:scope',
  );
  const linuxAllowed = new Set(linuxFsScope.allow.map(({ path }) => path));
  for (const directory of frontendHiddenDirectories) {
    assert.equal(linuxAllowed.has(`**/${directory}`), true);
    assert.equal(linuxAllowed.has(`**/${directory}/**`), true);
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
  const macosFsScope = macos.permissions.find(
    (permission) => permission?.identifier === 'fs:scope',
  );
  const macosAllowed = new Set(macosFsScope.allow.map(({ path }) => path));
  for (const directory of frontendHiddenDirectories) {
    assert.equal(macosAllowed.has(`**/${directory}`), true);
    assert.equal(macosAllowed.has(`**/${directory}/**`), true);
  }
});

test('macOS bundle declares microphone usage without Apple credentials', async () => {
  const config = JSON.stringify(await readJson('../src-tauri/tauri.macos.conf.json'));
  const plist = await readFile(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');

  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.doesNotMatch(config, /APPLE_|notari|Developer ID|teamId/i);
});

test('GitHub workflows pin the Windows runner required by the Piper build', async () => {
  const [ci, release] = await Promise.all([
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/release-build.yml', import.meta.url), 'utf8'),
  ]);

  for (const workflow of [ci, release]) {
    assert.match(workflow, /^\s+os: windows-2022$/m);
    assert.doesNotMatch(workflow, /^\s+os: windows-latest$/m);
    assert.match(workflow, /npm run build:piper-runtime/);
    assert.match(workflow, /name: Cache verified build downloads/);
    assert.match(workflow, /path: src-tauri\/tools\/\.download-cache/);
    assert.match(workflow, /scripts\/verified-download\.mjs/);
  }
  assert.match(ci, /python3-venv/);
  assert.match(ci, /cmake==3\.31\.10/);
  assert.match(ci, /ninja==1\.13\.0/);
  assert.match(release, /name: Remove stale Tauri bundles restored from cache/);
  assert.match(release, /node scripts\/clean-tauri-bundles\.mjs/);
  assert.ok(
    release.indexOf('Remove stale Tauri bundles restored from cache')
      < release.indexOf('Build Tauri bundles'),
    'stale bundles must be removed before the release build',
  );
});

test('the reproducible Linux bundle image provides Piper build dependencies', async () => {
  const [containerfile, containerignore] = await Promise.all([
    readFile(new URL('../packaging/linux/Containerfile', import.meta.url), 'utf8'),
    readFile(new URL('../.containerignore', import.meta.url), 'utf8'),
  ]);

  assert.match(containerfile, /^\s+git \\/m);
  assert.match(containerfile, /npm run build:piper-runtime/);
  assert.match(containerignore, /^!THIRD_PARTY_SOURCE_OFFER\.md$/m);
});

test('frontend-visible temporary files use the app-owned cache instead of the system temp dir', async () => {
  const [
    textImages,
    imageExports,
    fileCommands,
    packCommands,
    podcastCommands,
    youtubeCommands,
    comfyCommands,
  ] =
    await Promise.all([
      readFile(new URL('../src/components/TextImageGenerator/generateTextImage.js', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/ImageEditorModal/imageEditorExport.js', import.meta.url), 'utf8'),
      readFile(new URL('../src-tauri/src/commands/files.rs', import.meta.url), 'utf8'),
      readFile(new URL('../src-tauri/src/commands/pack.rs', import.meta.url), 'utf8'),
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
  const folderConversionCommand = packCommands.match(
    /pub async fn convert_folder_pack_to_zip[\s\S]*?(?=\n#\[tauri::command\])/,
  )?.[0] ?? '';
  assert.match(folderConversionCommand, /app_cache_subdir/);
  assert.match(folderConversionCommand, /IMPORTED_PACK_CACHE_DIR/);
  assert.match(folderConversionCommand, /path_for_frontend/);
  assert.doesNotMatch(folderConversionCommand, /std::env::temp_dir/);
  assert.match(podcastCommands, /app_cache_subdir[\s\S]*PODCAST_MEDIA_DIR/);
  assert.match(youtubeCommands, /app_cache_subdir[\s\S]*YOUTUBE_MEDIA_DIR/);
  assert.match(comfyCommands, /app_cache_subdir[\s\S]*TEMP_IMAGES_DIR/);
});
