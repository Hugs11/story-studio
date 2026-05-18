> 🇬🇧 **English** | [🇫🇷 Français](release-checklist.fr.md)

# Release Checklist

Use this checklist when preparing a public Story Studio release.

## 1. Preflight

- Review `CHANGELOG.md` and make sure the public release section is concise and user-facing.
- Confirm the version number is synchronized in:
  - `package.json`
  - `package-lock.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/Cargo.lock`
  - `src-tauri/tauri.conf.json`
- If README screenshots are present, check that they still match the current UI.
- Confirm `THIRD_PARTY_NOTICES.md` matches the bundled `ffmpeg.exe` and `7z.exe` versions.

## 2. Validation

Run the release validation commands from a clean checkout:

```powershell
npm ci
npm run build
cd src-tauri
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cd ..
npm run tauri build
```

If `src-tauri/src/native_pack.rs` changed, manually test at least:

- A simple one-story project
- A multi-menu pack
- A pack with imported ZIP content
- A story using custom navigation after playback

## 3. Release Build

Build artifacts are created under:

```text
src-tauri/target/release/bundle/
```

Before uploading installers, verify:

- The app launches on Windows
- The title bar shows the expected version
- A new project can be saved as `.mbah`
- A small pack can be generated and reopened by the emulator
- Bundled third-party notices are included in the app bundle

## 4. GitHub Release

Create a GitHub release from the version tag, for example:

```text
v0.8.9
```

Release notes should include:

- A short human summary of the release
- User-facing additions and fixes
- Migration notes, if any
- Known limitations, if any
- Windows installer artifacts from the Tauri bundle output or the `Release Build` workflow

Use GitHub's generated release notes as a starting point, then edit them for clarity.

## 5. First Public GitHub Publication

For the first public release, do not push the local development history if the
repository is meant to start clean on GitHub.

Recommended path:

- Create a new empty GitHub repository and push the prepared `v0.8.9` tree as
  its first commit. Keep this local repository as the private working history.

Alternative path:

- Create an orphan `main` branch from the prepared tree, then push that branch
  to GitHub as the public default branch.

Before doing either, confirm that:

- `CHANGELOG.md` contains the simplified public history.
- No local-only files are tracked.
- The release commit is tagged with the public version, for example `v0.8.9`.

Keep the private/local repository as the working history if you still need it
for reference.

## 6. After Publishing

- Confirm the release page links to the uploaded artifacts.
- Download the published installer once and smoke-test it.
- Open a follow-up issue for any known release debt instead of hiding it in the notes.
