#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifiedDownload } from './verified-download.mjs';

const MAX_TOOL_BYTES = 24 * 1024 * 1024;
const DOWNLOAD_CACHE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src-tauri',
  'tools',
  '.download-cache',
);
const APPIMAGE_RUNTIME_LICENSE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'assets',
  'AppImage-type2-runtime-LICENSE.txt',
);
const WAYLAND_LIBRARIES = new Set([
  'libwayland-client.so.0',
  'libwayland-cursor.so.0',
  'libwayland-egl.so.1',
  'libwayland-server.so.0',
]);
const REQUIRED_GSTREAMER_PLUGINS = [
  'libgstapp.so',
  'libgstaudioconvert.so',
  'libgstcoreelements.so',
  'libgstisomp4.so',
  'libgstlibav.so',
  'libgstogg.so',
  'libgstplayback.so',
  'libgsttypefindfunctions.so',
  'libgstvorbis.so',
  'libgstwavparse.so',
];
const GSTREAMER_COPYRIGHT_FILES = [
  ['libgstreamer1.0-0', '/usr/share/doc/libgstreamer1.0-0/copyright'],
  ['gstreamer1.0-plugins-base', '/usr/share/doc/gstreamer1.0-plugins-base/copyright'],
  ['gstreamer1.0-plugins-good', '/usr/share/doc/gstreamer1.0-plugins-good/copyright'],
  ['gstreamer1.0-libav', '/usr/share/doc/gstreamer1.0-libav/copyright'],
];

export const APPIMAGE_TOOL = {
  version: '1.9.1',
  url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage',
  sha256: 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0',
};

export const APPIMAGE_RUNTIME = {
  version: '20251108',
  url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
  sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
};

export const XDG_OPEN_WRAPPER = `#!/bin/sh
# Prevent host URL handlers from loading libraries injected by the AppImage.
unset LD_LIBRARY_PATH LD_PRELOAD
unset GTK_PATH GTK_EXE_PREFIX GTK_DATA_PREFIX GTK_THEME
unset GDK_BACKEND GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR
unset GSETTINGS_SCHEMA_DIR GIO_MODULE_DIR GIO_EXTRA_MODULES
unset GTK_IM_MODULE_FILE GST_PLUGIN_PATH GST_PLUGIN_SYSTEM_PATH
for candidate in /usr/bin/xdg-open /bin/xdg-open /usr/local/bin/xdg-open; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done
echo "xdg-open: no system handler found" >&2
exit 3
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`${command} failed (${result.status})${detail ? `: ${detail}` : ''}`);
  }
}

async function downloadPinnedFile(spec, destination, label) {
  const bytes = await verifiedDownload({
    ...spec,
    maxBytes: MAX_TOOL_BYTES,
  }, label, {
    allowedHosts: [
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
    ],
    cacheDir: DOWNLOAD_CACHE,
    userAgent: 'Story-Studio-AppImage-patcher',
  });
  await writeFile(destination, bytes, { mode: 0o755 });
  return bytes;
}

async function findFiles(root, names, matches = []) {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await findFiles(path, names, matches);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && names.has(entry.name)) {
      matches.push(path);
    }
  }
  return matches;
}

export async function resolveAppImage(input) {
  const path = resolve(input);
  const metadata = await lstat(path);
  if (metadata.isFile()) return path;
  if (!metadata.isDirectory()) throw new Error(`Not a regular file or directory: ${path}`);

  const candidates = (await readdir(path))
    .filter((name) => name.endsWith('.AppImage'))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one AppImage in ${path}, found ${candidates.length}.`);
  }
  return join(path, candidates[0]);
}

async function installXdgOpenWrapper(appDir) {
  const wrapper = join(appDir, 'usr', 'bin', 'xdg-open');
  const metadata = await lstat(wrapper);
  if (!metadata.isFile()) throw new Error('Bundled xdg-open is not a regular file.');
  await writeFile(wrapper, XDG_OPEN_WRAPPER, { mode: 0o755 });
}

async function documentBundledGStreamer(appDir) {
  const pluginsDir = join(appDir, 'usr', 'lib', 'gstreamer-1.0');
  const plugins = (await readdir(pluginsDir))
    .filter((name) => name.endsWith('.so'))
    .sort();
  for (const required of REQUIRED_GSTREAMER_PLUGINS) {
    if (!plugins.includes(required)) {
      throw new Error(`Bundled GStreamer is missing required plugin ${required}.`);
    }
  }

  const resources = join(appDir, 'usr', 'lib', 'Story Studio');
  const licenses = join(resources, 'licenses');
  await mkdir(licenses, { recursive: true });
  await writeFile(
    join(resources, 'GSTREAMER_PLUGINS.txt'),
    [
      'GStreamer plugins bundled in the Story Studio AppImage',
      'Generated from the Ubuntu 22.04 build environment.',
      '',
      ...plugins,
      '',
    ].join('\n'),
  );
  for (const [packageName, source] of GSTREAMER_COPYRIGHT_FILES) {
    const sourceMetadata = await lstat(source);
    if (!sourceMetadata.isFile()) {
      throw new Error(`GStreamer copyright notice is not a regular file: ${source}`);
    }
    await copyFile(source, join(licenses, `${packageName}-copyright`));
  }
  const runtimeLicenseMetadata = await lstat(APPIMAGE_RUNTIME_LICENSE);
  if (!runtimeLicenseMetadata.isFile()) {
    throw new Error('AppImage runtime license is not a regular file.');
  }
  await copyFile(
    APPIMAGE_RUNTIME_LICENSE,
    join(licenses, 'AppImage-type2-runtime-LICENSE.txt'),
  );
  return plugins.length;
}

export async function patchLinuxAppImage(input) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`AppImage patching requires Linux x64, found ${process.platform}-${process.arch}.`);
  }

  const appImage = await resolveAppImage(input);
  const metadata = await lstat(appImage);
  if (!metadata.isFile()) throw new Error(`AppImage is not a regular file: ${appImage}`);

  const workDir = await mkdtemp(join(tmpdir(), 'story-studio-appimage-'));
  const inputCopy = join(workDir, 'input.AppImage');
  const appImageTool = join(workDir, 'appimagetool.AppImage');
  const appImageRuntime = join(workDir, 'runtime-x86_64');
  const patched = join(dirname(appImage), `.${basename(appImage)}.patched-${randomUUID()}`);

  try {
    await copyFile(appImage, inputCopy);
    await chmod(inputCopy, 0o755);
    run(inputCopy, ['--appimage-extract'], { cwd: workDir, quiet: true });

    const appDir = join(workDir, 'squashfs-root');
    const bundledWayland = await findFiles(appDir, WAYLAND_LIBRARIES);
    const bundledNames = new Set(bundledWayland.map((path) => basename(path)));
    if (!bundledNames.has('libwayland-client.so.0')) {
      throw new Error('AppImage did not contain the incompatible bundled Wayland client library.');
    }
    for (const path of bundledWayland) await rm(path);
    await installXdgOpenWrapper(appDir);
    const gstreamerPlugins = await documentBundledGStreamer(appDir);

    const toolBytes = await downloadPinnedFile(
      APPIMAGE_TOOL,
      appImageTool,
      'appimagetool',
    );
    if (!toolBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('appimagetool is not an ELF executable.');
    }
    const runtimeBytes = await downloadPinnedFile(
      APPIMAGE_RUNTIME,
      appImageRuntime,
      'AppImage runtime',
    );
    if (!runtimeBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('AppImage runtime is not an ELF executable.');
    }
    run(appImageTool, ['--runtime-file', appImageRuntime, appDir, patched], {
      env: {
        ...process.env,
        ARCH: 'x86_64',
        APPIMAGE_EXTRACT_AND_RUN: '1',
      },
    });

    const patchedBytes = await readFile(patched);
    if (!patchedBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('Patched AppImage is not an ELF executable.');
    }
    await chmod(patched, 0o755);
    await rename(patched, appImage);
    const digest = createHash('sha256').update(patchedBytes).digest('hex');
    process.stdout.write(
      `Patched ${appImage}: removed ${bundledWayland.length} bundled Wayland libraries; SHA-256 ${digest}\n`,
    );
    process.stdout.write(`Verified and documented ${gstreamerPlugins} GStreamer plugins.\n`);
    return {
      appImage,
      digest,
      removed: bundledWayland.length,
      gstreamerPlugins,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(patched, { force: true });
  }
}

async function main() {
  const input = process.argv[2];
  if (!input || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/patch-linux-appimage.mjs <AppImage-or-directory>');
  }
  await patchLinuxAppImage(input);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`AppImage patch failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
