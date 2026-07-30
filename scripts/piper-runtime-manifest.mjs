export const PIPER_VERSION = '1.6.0';
export const PIPER_COMMIT = 'f04d52c5528ac7cf2d73757f57990ff490f75005';
export const ESPEAK_COMMIT = '212928b394a96e8fd2096616bfd54e17845c48f6';
export const SONIC_COMMIT = 'fbf75c3d6d846bad3bb3d456cbc5d07d9fd8c104';
export const ONNXRUNTIME_VERSION = '1.22.0';
export const PIPER_VOICES_VERSION = 'v1.0.0';

export const PIPER_BUILD_INPUTS = {
  piper: {
    filename: `piper1-gpl-${PIPER_VERSION}.tar.gz`,
    url: `https://codeload.github.com/OHF-Voice/piper1-gpl/tar.gz/refs/tags/v${PIPER_VERSION}`,
    sha256: '171e27d9f5dc38048552155909f5760f781c08958e6208ea4b5d97525e1ad82b',
    maxBytes: 32 * 1024 * 1024,
    archiveType: 'tar.gz',
    rootDirectory: `piper1-gpl-${PIPER_VERSION}`,
  },
  espeak: {
    filename: `espeak-ng-${ESPEAK_COMMIT}.tar.gz`,
    url: `https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/${ESPEAK_COMMIT}`,
    sha256: '1f201cabc73e569a7cb434d40d3b30980f923010f8ecd4d1c4ae94691ac2888a',
    maxBytes: 24 * 1024 * 1024,
    archiveType: 'tar.gz',
    rootDirectory: `espeak-ng-${ESPEAK_COMMIT}`,
  },
  sonic: {
    filename: `sonic-${SONIC_COMMIT}.tar.gz`,
    url: `https://codeload.github.com/waywardgeek/sonic/tar.gz/${SONIC_COMMIT}`,
    sha256: '715827b5a39b79e56e44397d7b845910df996d4cca74777b3b61629b1ddc98c1',
    maxBytes: 8 * 1024 * 1024,
    archiveType: 'tar.gz',
    rootDirectory: `sonic-${SONIC_COMMIT}`,
  },
  googletest: {
    filename: 'googletest-v1.17.0.tar.gz',
    url: 'https://codeload.github.com/google/googletest/tar.gz/refs/tags/v1.17.0',
    sha256: '65fab701d9829d38cb77c14acdc431d2108bfdbf8979e40eb8ae567edf10b27c',
    maxBytes: 2 * 1024 * 1024,
    archiveType: 'tar.gz',
    rootDirectory: 'googletest-1.17.0',
  },
  testModel: {
    filename: 'en_US-lessac-medium.onnx',
    url: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_VERSION}/en/en_US/lessac/medium/en_US-lessac-medium.onnx`,
    sha256: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
    maxBytes: 70 * 1024 * 1024,
  },
  testModelConfig: {
    filename: 'en_US-lessac-medium.onnx.json',
    url: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_VERSION}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json`,
    sha256: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0',
    maxBytes: 64 * 1024,
  },
};

export const PIPER_TARGETS = {
  'win32-x64': {
    platformName: 'windows-x86_64',
    format: 'pe',
    architectures: ['x86_64'],
    generator: 'Visual Studio 17 2022',
    generatorArgs: ['-A', 'x64'],
    installRpath: null,
    executable: 'piper.exe',
    runtimeFiles: [
      { installed: 'piper_exe.exe', output: 'piper.exe' },
      { installed: 'piper.dll', output: 'piper.dll' },
      { installed: 'onnxruntime.dll', output: 'onnxruntime.dll' },
      {
        installed: 'onnxruntime_providers_shared.dll',
        output: 'onnxruntime_providers_shared.dll',
      },
    ],
    onnxruntime: {
      filename: `onnxruntime-win-x64-${ONNXRUNTIME_VERSION}.zip`,
      url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-win-x64-${ONNXRUNTIME_VERSION}.zip`,
      sha256: '174c616efc0271194488642a72f1a514e01487da4dfe84c49296d66e40ebe0da',
      maxBytes: 80 * 1024 * 1024,
      archiveType: 'zip',
      rootDirectory: `onnxruntime-win-x64-${ONNXRUNTIME_VERSION}`,
    },
  },
  'linux-x64': {
    platformName: 'linux-x86_64',
    format: 'elf',
    architectures: ['x86_64'],
    generator: 'Ninja',
    generatorArgs: [],
    installRpath: '$ORIGIN',
    executable: 'piper',
    runtimeFiles: [
      { installed: 'piper_exe', output: 'piper' },
      { installed: 'libpiper.so', output: 'libpiper.so' },
      {
        installed: `libonnxruntime.so.${ONNXRUNTIME_VERSION}`,
        output: 'libonnxruntime.so.1',
      },
      {
        installed: 'libonnxruntime_providers_shared.so',
        output: 'libonnxruntime_providers_shared.so',
      },
    ],
    onnxruntime: {
      filename: `onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}.tgz`,
      url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}.tgz`,
      sha256: '8344d55f93d5bc5021ce342db50f62079daf39aaafb5d311a451846228be49b3',
      maxBytes: 16 * 1024 * 1024,
      archiveType: 'tar.gz',
      rootDirectory: `onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}`,
    },
  },
  'darwin-arm64': {
    platformName: 'macos-aarch64',
    format: 'macho',
    architectures: ['aarch64'],
    generator: 'Ninja',
    generatorArgs: [],
    installRpath: '@loader_path',
    executable: 'piper',
    runtimeFiles: [
      { installed: 'piper_exe', output: 'piper' },
      { installed: 'libpiper.dylib', output: 'libpiper.dylib' },
      {
        installed: `libonnxruntime.${ONNXRUNTIME_VERSION}.dylib`,
        output: `libonnxruntime.${ONNXRUNTIME_VERSION}.dylib`,
      },
    ],
    onnxruntime: {
      filename: `onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}.tgz`,
      url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}.tgz`,
      sha256: 'cab6dcbd77e7ec775390e7b73a8939d45fec3379b017c7cb74f5b204c1a1cc07',
      maxBytes: 32 * 1024 * 1024,
      archiveType: 'tar.gz',
      rootDirectory: `onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}`,
    },
  },
};

export function selectPiperTarget(platform, architecture) {
  const key = `${platform}-${architecture}`;
  const target = PIPER_TARGETS[key];
  if (!target) {
    throw new Error(
      `Unsupported Piper target: ${platform}/${architecture}. `
      + 'Supported: win32/x64, linux/x64, darwin/arm64.',
    );
  }
  return { key, target };
}
