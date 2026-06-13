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
- **License text:** <https://github.com/lucide-icons/lucide/blob/main/LICENSE>
- **Copyright notice:** Copyright (c) Lucide Icons and Contributors.

Story Studio copies selected Lucide SVG path data into local React components
instead of depending on `lucide-react`. Those copied icon definitions remain
licensed by Lucide under the ISC License and are not covered by Story Studio's
MIT license.

## Space Grotesk

- **Bundled file:** `public/fonts/SpaceGrotesk-Variable.woff2`
- **Upstream project:** <https://github.com/floriankarsten/space-grotesk>
- **License:** SIL Open Font License, Version 1.1
- **License text:** <https://github.com/floriankarsten/space-grotesk/blob/master/OFL.txt>
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

- **Bundled file:** `src-tauri/tools/ffmpeg.exe`
- **Version:** `8.1-essentials_build-www.gyan.dev`
  (string returned by `ffmpeg.exe -version`)
- **Upstream project:** <https://ffmpeg.org/>
- **Windows build provenance:** Gyan Doshi's prebuilt Windows binaries —
  <https://www.gyan.dev/ffmpeg/builds/>
  (the `release-essentials` variant on which the bundled `8.1` build is based)
- **Build configuration:** the binary reports `--enable-gpl --enable-version3`
  (see `ffmpeg.exe -buildconf`). Per FFmpeg's own legal notice, enabling
  `--enable-gpl` and any GPL component makes the resulting binary licensed
  under the **GNU GPL v3 or later**, not LGPL.
- **License texts:**
  - FFmpeg legal overview: <https://www.ffmpeg.org/legal.html>
  - GPL v3: <https://www.gnu.org/licenses/gpl-3.0.en.html>

### Obligations when redistributing this binary

Story Studio redistributes `ffmpeg.exe` as object code inside its installers.
Under GPL v3 §6, anyone distributing the binary must also make available the
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
- The `ffmpeg.exe` binary in `src-tauri/tools/` is **not** MIT-licensed. It is
  redistributed under the **GPL v3 or later** and carries its own obligations
  (notably, providing the Corresponding Source on request).
- Do **not** describe `ffmpeg.exe` or any other third-party binary in this
  repository as covered by Story Studio's MIT license.

### When replacing the bundled FFmpeg

If you replace `src-tauri/tools/ffmpeg.exe` with a different build, update this
notice with:

- the new version string returned by `ffmpeg.exe -version`,
- the upstream source / mirror you used,
- the SHA-256 checksum of the binary you committed,
- and the license implications of the new build (e.g. LGPL-only vs. GPL).

## 7-Zip

- **Bundled file:** `src-tauri/tools/7z.exe`
- **Version:** `7-Zip (a) 25.01 (x86)`, 2025-08-03
- **Upstream project:** <https://www.7-zip.org/>
- **License information:** <https://www.7-zip.org/license.txt>

7-Zip is free software. Most of the code is under the **GNU LGPL**; some parts
are under **BSD-style** licenses; and some parts may carry the **unRAR**
license restriction as documented by 7-Zip. Do **not** describe 7-Zip as
covered by Story Studio's MIT license.

## Distribution notes

The current release strategy keeps `ffmpeg.exe` and `7z.exe` in
`src-tauri/tools/` and bundles them with the Tauri installer. Do not replace
`ffmpeg.exe` without checking that the tracked file remains below GitHub's
hard **100 MiB per-file** limit (the current binary is close to that limit).
