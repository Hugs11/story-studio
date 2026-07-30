# Third-party corresponding sources

Story Studio is MIT-licensed, but its desktop bundles also redistribute
standalone third-party programs under their own licenses. This document covers
the binaries shipped with Story Studio 0.9.6.

The `v0.9.6` GitHub release includes a
`story-studio-v0.9.6-corresponding-sources.zip` asset. It contains the pinned
Piper and eSpeak NG sources, the Story Studio Piper patch and build recipe,
the FFmpeg source releases matching each bundled major/minor version, the
embedded FFmpeg build configurations, and this offer.

## Piper 1.6

- Piper source: `OHF-Voice/piper1-gpl` v1.6.0, commit
  `f04d52c5528ac7cf2d73757f57990ff490f75005`.
- eSpeak NG source: commit
  `212928b394a96e8fd2096616bfd54e17845c48f6`.
- Sonic build input: commit
  `fbf75c3d6d846bad3bb3d456cbc5d07d9fd8c104`.
- Story Studio recipe: `scripts/build-piper-runtime.mjs`,
  `scripts/piper-runtime-manifest.mjs` and
  `scripts/patches/piper-1.6.0-story-studio.patch`.

The release source asset retains the original archive filenames and SHA-256
values recorded in `scripts/piper-runtime-manifest.mjs`.

## FFmpeg

| Platform | Binary | License | Matching FFmpeg source |
|---|---|---|---|
| Windows x64 | 8.1 essentials, SHA-256 `1a65d5b0b10d8d9a81d2824a3538046a40ed3607c906b335a166add87613f705` | GPL-3.0-or-later | FFmpeg `n8.1` |
| Linux x86_64 | 7.0.2 static, SHA-256 `e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99` | GPL-3.0-or-later | FFmpeg `n7.0.2` |
| macOS Apple Silicon | 7.1, SHA-256 `6d175a4743ca50256e89a8cdd731100f9cee33bd79aeea46894d209410dc6617` | GPL-2.0-or-later | FFmpeg `n7.1` |

All three binaries report `--enable-gpl`; none reports
`--enable-nonfree`. Their complete configuration strings and original
distribution provenance are included in the release source asset and in
`THIRD_PARTY_NOTICES.md`.

## Source request

For at least three years after the publication of Story Studio 0.9.6, the
maintainer will provide the corresponding source and the available build
information for these redistributed binaries at no charge other than the
reasonable cost of physical transfer. Requests can be opened on the public
GitHub repository with the title `Corresponding source request`; private
contact is also available through GitHub Private Vulnerability Reporting when
the request must contain non-public contact information.

This offer applies only to third-party binaries redistributed by Story Studio.
Voice models downloaded separately keep the licenses stated in
`THIRD_PARTY_NOTICES.md`.
