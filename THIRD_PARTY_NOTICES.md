# Third-Party Notices

Story Studio source code is licensed under the **MIT License** (see `LICENSE`).
This repository and its installers also ship **third-party command-line binaries**
that are **not** covered by the MIT license — each binary remains under the
license set by its upstream project. The notices below describe each bundled
binary, its provenance, and the obligations that come with redistributing it.

## Lucide Icons

- **Used in:** local SVG icon components under `src/components/icons/` and
  `src/components/TreePanel/`.
- **Upstream project:** <https://lucide.dev/>
- **Source repository:** <https://github.com/lucide-icons/lucide>
- **License:** ISC License
- **License text:** `public/licenses/Lucide-ISC.txt`
- **Copyright notice:** Copyright (c) Lucide Icons and Contributors.

Story Studio copies selected Lucide SVG path data into local React components
instead of depending on `lucide-react`. Those copied icon definitions remain
licensed by Lucide under the ISC License and are not covered by Story Studio's
MIT license.

## Space Grotesk

- **Bundled file:** `public/fonts/SpaceGrotesk-Variable.woff2`
- **Upstream project:** <https://github.com/floriankarsten/space-grotesk>
- **License:** SIL Open Font License, Version 1.1
- **License text:** `public/fonts/OFL-SpaceGrotesk.txt`
- **Copyright notice:** Copyright 2020 The Space Grotesk Project Authors.
- **SHA-256:** `8E085AA438094F11487A836652EDD5C054FA6A96F63FC7C282105EE3A4B08C07`

Story Studio bundles the variable WOFF2 font file locally so the desktop app
can render its UI consistently without loading fonts from the network. The font
software remains licensed under the SIL Open Font License and is not covered by
Story Studio's MIT license.

## JetBrains Mono

- **Bundled files:**
  - `public/fonts/JetBrainsMono-Regular.ttf`
  - `public/fonts/JetBrainsMono-Medium.ttf`
- **Upstream project:** <https://www.jetbrains.com/lp/mono/>
- **Source repository:** <https://github.com/JetBrains/JetBrainsMono>
- **License:** SIL Open Font License, Version 1.1
- **License text:** `public/fonts/OFL-JetBrainsMono.txt`
- **Copyright notice:** Copyright 2020 The JetBrains Mono Project Authors.
- **SHA-256:**
  - `JetBrainsMono-Regular.ttf`: `44CE4A84F20D60F24539BD0CEF11F79C29E38609E0F8ADF18551C9794A5D9DC3`
  - `JetBrainsMono-Medium.ttf`: `3386A05F6ECE969E4537DE6BE894170D20558E82F7D56C8C5D332972EF172160`

Story Studio bundles JetBrains Mono locally for compact technical labels and
numeric UI text. The font software remains licensed under the SIL Open Font
License and is not covered by Story Studio's MIT license.

## FFmpeg

- **Bundled files:**
  - Windows x64: tracked `src-tauri/tools/ffmpeg.exe`;
  - Linux x86_64: generated `src-tauri/tools/linux-x86_64/ffmpeg`;
  - macOS Apple Silicon: generated `src-tauri/tools/macos-aarch64/ffmpeg`.
- **Windows version:** `8.1-essentials_build-www.gyan.dev`
  (string returned by `ffmpeg.exe -version`).
- **Windows binary SHA-256:**
  `1a65d5b0b10d8d9a81d2824a3538046a40ed3607c906b335a166add87613f705`.
- **Upstream project:** <https://ffmpeg.org/>
- **Windows build provenance:** Gyan Doshi's prebuilt Windows binaries —
  <https://www.gyan.dev/ffmpeg/builds/>
  (the `release-essentials` variant on which the bundled `8.1` build is based)
- **Linux build provenance:** the `imageio-ffmpeg 0.6.0` manylinux2014 x86_64
  wheel, whose included `7.0.2-static` executable identifies
  <https://johnvansickle.com/ffmpeg/> as its builder:
  - wheel:
    <https://files.pythonhosted.org/packages/a0/2d/43c8522a2038e9d0e7dbdf3a61195ecc31ca576fb1527a528c877e87d973/imageio_ffmpeg-0.6.0-py3-none-manylinux2014_x86_64.whl>
  - wheel SHA-256:
    `c7e46fcec401dd990405049d2e2f475e2b397779df2519b544b8aab515195282`
  - extracted binary SHA-256:
    `e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99`.
- **macOS ARM64 build provenance:** the native Apple Silicon executable from
  the `imageio-ffmpeg 0.6.0` wheel, sourced by that project from the
  osxexperts.net ARM64 builds:
  - wheel:
    <https://files.pythonhosted.org/packages/40/5c/f3d8a657d362cc93b81aab8feda487317da5b5d31c0e1fdfd5e986e55d17/imageio_ffmpeg-0.6.0-py3-none-macosx_11_0_arm64.whl>
  - wheel SHA-256:
    `b1ae3173414b5fc5f538a726c4e48ea97edc0d2cdc11f103afee655c463fa742`
  - extracted `7.1` ARM64 binary SHA-256:
    `6d175a4743ca50256e89a8cdd731100f9cee33bd79aeea46894d209410dc6617`.
- **Cross-platform version policy:** these validated binaries intentionally use
  different FFmpeg versions because each target comes from a separately pinned
  native distribution source. Story Studio requires the same codecs and
  operations on every platform, not a shared FFmpeg build number.
- **Build configuration:** all three binaries report `--enable-gpl` and
  `--enable-libmp3lame`. Windows and Linux additionally report
  `--enable-version3`; macOS does not. None reports `--enable-nonfree`.
  Consequently the Windows and Linux builds are **GNU GPL v3 or later**, while
  the macOS build is **GNU GPL v2 or later**.
- **License texts:**
  - FFmpeg legal overview: <https://www.ffmpeg.org/legal.html>
  - GPL v2: <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>
  - GPL v3: <https://www.gnu.org/licenses/gpl-3.0.en.html>

### Obligations when redistributing this binary

Story Studio redistributes a native FFmpeg executable as object code inside
each platform bundle.
Under GPL §3/§6, anyone distributing the binary must also make available the
**Corresponding Source** of FFmpeg (the source code, build scripts and
configuration used to produce the binary). The Gyan build page publishes the
upstream source archives and build recipes used to produce these official
Windows builds; pinning the exact upstream commit / source archive for the
version above is the recommended way to satisfy that obligation.

If you fork Story Studio and distribute an installer, you must either:

1. ship the matching FFmpeg source alongside your installer, or
2. include a written offer to provide that source, as described in GPL v3 §6,
   pointing to a stable mirror of the matching FFmpeg source tarball.

This is **not** legal advice — when in doubt, consult a lawyer or replace the
bundled binary with an LGPL-only FFmpeg build that you produce yourself.

### Important — license scope

- The Story Studio source code (Rust + JavaScript in this repository) remains
  under the **MIT License**.
- The FFmpeg binaries are **not** MIT-licensed. They are redistributed under
  GPL v3 or later on Windows/Linux and GPL v2 or later on macOS, with their own
  obligations (notably, providing the Corresponding Source).
- Do **not** describe `ffmpeg.exe` or any other third-party binary in this
  repository as covered by Story Studio's MIT license.

### When replacing the bundled FFmpeg

If you replace any bundled FFmpeg build, update this
notice with:

- the new version string returned by `ffmpeg.exe -version`,
- the upstream source / mirror you used,
- the SHA-256 checksum of the binary you committed,
- and the license implications of the new build (e.g. LGPL-only vs. GPL).

## 7-Zip

- **Bundled files:**
  - Windows x64: tracked `src-tauri/tools/7z.exe` (historical x86 console
    executable, compatible with Windows x64);
  - Linux x86_64: generated `src-tauri/tools/linux-x86_64/7zz`;
  - macOS: generated universal `src-tauri/tools/macos-aarch64/7zz`, whose
    ARM64 slice is used on Apple Silicon.
- **Version:** 25.01, 2025-08-03.
- **Windows binary SHA-256:**
  `26817725650583d99ca3e617a618dd75c0f71bd316b5761780b7361f5f824cad`.
- **Linux official archive:**
  <https://www.7-zip.org/a/7z2501-linux-x64.tar.xz>
  - archive SHA-256:
    `4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4`
  - extracted `7zz` SHA-256:
    `a1860fdf0d6ec395e0e277e5222e9aa488747db4aa5c87d1ec879a0916ba0b2f`.
- **macOS official archive:**
  <https://www.7-zip.org/a/7z2501-mac.tar.xz>
  - archive SHA-256:
    `26aa75bc262bb10bf0805617b95569c3035c2c590a99f7db55c7e9607b2685e0`
  - extracted universal `7zz` SHA-256:
    `5c2fd36f00a66f7787dcf1badd977d44a02b50063fe5678e1f19ff64797432ed`.
- **Upstream project:** <https://www.7-zip.org/>
- **License information:** <https://www.7-zip.org/license.txt>
- **Bundled license text:** `scripts/assets/7-Zip-License.txt` is copied into
  every platform bundle as `tools/licenses/7-Zip-License.txt`.

7-Zip is free software. Most of the code is under the **GNU LGPL**; some parts
are under **BSD-style** licenses; and some parts may carry the **unRAR**
license restriction as documented by 7-Zip. Do **not** describe 7-Zip as
covered by Story Studio's MIT license.

## AppImage runtime

- **Bundled in:** the Linux x86_64 AppImage header.
- **Runtime release:** `20251108`:
  <https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64>
- **Runtime SHA-256:**
  `2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d`.
- **Repacking tool:** `appimagetool` 1.9.1:
  <https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage>
- **Repacking-tool SHA-256:**
  `ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0`.
- **License information:**
  - appimagetool: <https://github.com/AppImage/appimagetool/blob/1.9.1/LICENSE>
  - type2 runtime and its statically linked components:
    <https://github.com/AppImage/type2-runtime/blob/20251108/LICENSE>
- **Bundled license text:** the AppImage contains
  `licenses/AppImage-type2-runtime-LICENSE.txt`.

`appimagetool` is used only while building and is not shipped as a standalone
tool. Its versioned runtime is embedded in the resulting AppImage. Both files
are downloaded from immutable release URLs and verified before repacking; the
build never relies on AppImage's floating `continuous` runtime.

## GStreamer in the Linux AppImage

The AppImage bundles the GStreamer 1.20 core and plugin set supplied by the
Ubuntu 22.04 build environment so WebKitGTK can decode Story Studio's WAV, MP3,
Ogg/Vorbis and M4A/AAC previews without mixing an older bundled core with
ABI-incompatible plugins from a newer host distribution.

- **Upstream project:** <https://gstreamer.freedesktop.org/>
- **Ubuntu source packages:** `gstreamer1.0`, `gst-plugins-base1.0`,
  `gst-plugins-good1.0` and `gst-libav1.0`.
- **Licenses:** predominantly LGPL 2 or LGPL 2.1 or later; the exact
  per-file notices from the Ubuntu packages are bundled under
  `licenses/*-copyright` in the AppImage.
- **Bundled-plugin inventory:** `GSTREAMER_PLUGINS.txt` in the AppImage
  resources, generated from the actual `.so` files at repack time.
- **Source packages:** <https://packages.ubuntu.com/jammy/source/gstreamer1.0>,
  <https://packages.ubuntu.com/jammy/source/gst-plugins-base1.0>,
  <https://packages.ubuntu.com/jammy/source/gst-plugins-good1.0> and
  <https://packages.ubuntu.com/jammy/source/gst-libav1.0>.

The DEB and RPM use the distribution WebKitGTK/GStreamer stack instead and do
not bundle this AppImage-specific plugin set.

## External runtime tools

The tools below run as separate processes. yt-dlp is downloaded on first use
into writable app-data; Piper 1.6 is built from source and bundled per platform
while its voice models remain downloaded separately. Their upstream licenses
and notices apply as detailed below.

### yt-dlp

- **Used by:** the "Pack depuis YouTube" funnel (plan 09), to list videos and
  extract their audio. Provisioned by `src-tauri/src/services/youtube/`.
- **Downloaded from:**
  the latest immutable release tag resolved through the official GitHub API,
  then `yt-dlp.exe` (Windows x64), `yt-dlp_linux` (Linux x86_64) or
  `yt-dlp_macos` (macOS Apple Silicon) and that exact tag's
  `SHA2-256SUMS`. The installed Unix filename is normalized to `yt-dlp`.
- **Upstream project:** <https://github.com/yt-dlp/yt-dlp>
- **License:** the yt-dlp source project is licensed under **The Unlicense**,
  but the standalone Windows release binary downloaded here is a
  **PyInstaller-bundled executable**. Upstream documents that those executables
  include GPLv3+ licensed code and that the combined work is therefore
  **GPL v3 or later**.
- **License texts / notices:**
  - yt-dlp source license: <https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE>
  - yt-dlp licensing notes: <https://github.com/yt-dlp/yt-dlp#licensing>
  - yt-dlp third-party notices:
    <https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt>
  - GPL v3: <https://www.gnu.org/licenses/gpl-3.0.en.html>

The latest version is always fetched because YouTube blocks outdated releases.
yt-dlp uses the native bundled FFmpeg (see above) to extract audio. Story Studio
does not redistribute yt-dlp; it is fetched at runtime. If a future
release bundles it, treat that standalone binary as GPL v3 or later and
include the matching upstream third-party notices.

### Piper (text-to-speech) — 0.9.6 migration

Story Studio 0.9.6 builds and bundles a native Piper runtime for Windows x64,
Linux x86_64 and macOS Apple Silicon. The runtime is invoked as a separate
process. It needs no Python installation, Homebrew runtime or Rosetta.

- **Used by:** the default zero-config TTS backend (plan 08).
- **Piper source:** `OHF-Voice/piper1-gpl` tag `v1.6.0`, commit
  `f04d52c5528ac7cf2d73757f57990ff490f75005` —
  <https://codeload.github.com/OHF-Voice/piper1-gpl/tar.gz/refs/tags/v1.6.0>
  (SHA-256
  `171e27d9f5dc38048552155909f5760f781c08958e6208ea4b5d97525e1ad82b`).
- **Story Studio build recipe:** `scripts/build-piper-runtime.mjs`, manifest
  `scripts/piper-runtime-manifest.mjs` and published patch
  `scripts/patches/piper-1.6.0-story-studio.patch`.
- **Piper license:** **GNU GPL v3 or later**, as declared by Piper 1.6 —
  <https://github.com/OHF-Voice/piper1-gpl/blob/v1.6.0/COPYING>.
- **eSpeak NG source:** commit
  `212928b394a96e8fd2096616bfd54e17845c48f6` —
  <https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/212928b394a96e8fd2096616bfd54e17845c48f6>
  (SHA-256
  `1f201cabc73e569a7cb434d40d3b30980f923010f8ecd4d1c4ae94691ac2888a`).
  eSpeak NG is primarily **GNU GPL v3 or later** and its source/data tree
  carries additional Apache-2.0, BSD-2-Clause and Unicode-data notices.
- **Sonic build input:** commit
  `fbf75c3d6d846bad3bb3d456cbc5d07d9fd8c104` —
  <https://codeload.github.com/waywardgeek/sonic/tar.gz/fbf75c3d6d846bad3bb3d456cbc5d07d9fd8c104>
  (SHA-256
  `715827b5a39b79e56e44397d7b845910df996d4cca74777b3b61629b1ddc98c1`).
  eSpeak's CMake configures this pinned **Apache-2.0** source while Piper
  explicitly disables libsonic runtime integration; no Sonic object is linked
  into the distributed runtime.
- **ONNX Runtime:** version `1.22.0`, **MIT License** —
  <https://github.com/microsoft/onnxruntime/blob/v1.22.0/LICENSE>.
  Official archives used by the recipe:
  - Windows x64 —
    <https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-win-x64-1.22.0.zip>,
    SHA-256
    `174c616efc0271194488642a72f1a514e01487da4dfe84c49296d66e40ebe0da`;
  - Linux x86_64 —
    <https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-linux-x64-1.22.0.tgz>,
    SHA-256
    `8344d55f93d5bc5021ce342db50f62079daf39aaafb5d311a451846228be49b3`;
  - macOS ARM64 —
    <https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-osx-arm64-1.22.0.tgz>,
    SHA-256
    `cab6dcbd77e7ec775390e7b73a8939d45fec3379b017c7cb74f5b204c1a1cc07`.

Each generated runtime contains the Piper, eSpeak NG and ONNX Runtime license
texts, ONNX Runtime third-party notices, binary hashes and a machine-readable
provenance manifest. The build downloads every source/runtime archive over
HTTPS, verifies its pinned SHA-256 before extraction and rejects an unexpected
platform architecture or loader path.

The voice models are not bundled. They are downloaded on first use into the
user's writable app-data directory and are verified against the SHA-256 values
pinned in `src-tauri/src/services/piper/catalog.rs`. They are not covered by
Story Studio's MIT license. The upstream model cards record the following
dataset licenses and attribution requirements:

- `fr_FR-siwis-medium`: **CC BY 4.0** —
  <https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/fr/fr_FR/siwis/medium/MODEL_CARD>.
- `fr_FR-tom-medium`: **AGPL v3** —
  <https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/fr/fr_FR/tom/medium/MODEL_CARD>.
- `en_GB-jenny_dioco-medium`: custom attribution terms. The voice must be
  identified as **Jenny**, and as **Jenny (Dioco)** wherever practical;
  commercial use is permitted. Story Studio uses the preferred full name in
  its interface — <https://github.com/dioco-group/jenny-tts-dataset>.
- `en_GB-alba-medium`: **CC BY 4.0** —
  <https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/en/en_GB/alba/medium/MODEL_CARD>.
- `en_US-kristin-medium`: dataset recordings declared **public domain** —
  <https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/en/en_US/kristin/medium/MODEL_CARD>.
- `en_US-ljspeech-medium`: dataset declared **public domain** —
  <https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/en/en_US/ljspeech/medium/MODEL_CARD>.
- `it_IT-serena-medium` and `it_IT-serena-high`: **CC BY 4.0** —
  <https://huggingface.co/rhasspy/piper-voices/blob/ea046e8458f6acd997706d6e6066a022b42f6fb1/it/it_IT/serena/medium/MODEL_CARD>.

`fr_FR-beatrice-medium` is mirrored byte-for-byte from `DantSu/Telmi-Sync`
commit `0d0cd1906cf7cc5565fdfb1d27cc8de8e74044bb`, with redistribution authorized
by DantSu. The upstream repository declares **GPL-3.0-only**. Story Studio
publishes the model and configuration under that license in the versioned,
SHA-256-pinned `piper-beatrice-v1.0.0` release of
<https://github.com/Hugs11/story-studio-voice-assets>. The release includes the
GPL-3.0 text, provenance record and integrity manifest. The same GPL-3.0 text is
already included in every Story Studio bundle under `tools/licenses/` for the
Piper runtime; this notice also identifies its application to the separately
downloaded Béatrice model.

## Distribution notes

The historical Windows FFmpeg and 7-Zip binaries remain tracked in
`src-tauri/tools/`. Linux and macOS FFmpeg/7-Zip payloads are reproducibly
prepared from the pinned archives above by `scripts/prepare-platform-tools.mjs`.
Piper is built separately by `scripts/build-piper-runtime.mjs`; preparation
validates and preserves an existing runtime. Generated platform directories are
intentionally ignored by Git.

Each generated tool directory includes the applicable license texts and
machine-readable provenance manifests. Do not replace the tracked Windows
`ffmpeg.exe` without checking that it remains below GitHub's hard **100 MiB
per-file** limit.

yt-dlp remains downloaded at runtime and is not bundled. Piper 1.6 is bundled
without its voice models; corresponding-source availability for the exact
runtime build must accompany the 0.9.6 release.
