# Contributing to Story Studio

Thanks for your interest in contributing. Story Studio is a Windows desktop app with a React frontend and a Tauri/Rust backend, so the project values focused pull requests, reproducible testing, and clear release notes.

## Development Setup

```powershell
git clone https://github.com/hugs11/story-studio.git
cd story-studio
npm install
npm run tauri dev
```

Prerequisites:

- Windows 10 or later
- Node.js 20.19+ or 22.12+ (required by Vite 8)
- Rust stable
- [Tauri v2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/)

The dev server runs on `localhost:1420` with hot reload. The Rust backend recompiles automatically when you save a `.rs` file.

If port `1420` is already in use:

```powershell
npx kill-port 1420
npm run tauri dev
```

## Useful Commands

```powershell
npm run build
npm run tauri build
cd src-tauri
cargo build
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

## Reporting Bugs

Open a GitHub issue using the bug report template. Include:

- Steps to reproduce
- What you expected vs. what happened
- Story Studio version (shown in the title bar)
- Whether the issue is reproducible with a fresh project

Attach the project file (`.mbah`) if it helps isolate the problem. Remove or replace any audio/images you don't want to share.

## Suggesting Features

Open a GitHub issue using the feature request template. Describe the use case before proposing a solution; it helps evaluate fit and keeps the roadmap grounded in real workflows.

## Pull Requests

1. Fork the repo and create a branch from `main`.
2. Keep the change focused. One concern per PR is easiest to review.
3. Preserve the existing architecture unless the PR explicitly discusses a larger change.
4. Update `CHANGELOG.md` under `[Unreleased]` for user-visible behavior changes.
5. Update docs or screenshots when the user experience changes.
6. Open the PR against `main` and fill in the pull request template.

If you touch `src-tauri/src/native_pack.rs`, run:

```powershell
cd src-tauri
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

That file contains the native pack generation engine. Regressions can produce invalid packs without an obvious UI error, so tests are required.

## Code Style

- Frontend: no formatter enforced — match the surrounding code.
- Rust: `cargo clippy` should pass without new warnings.
- Comments: only when the *why* is non-obvious.
- Markdown: keep headings short, links relative, and release-facing docs easy to scan.

## License

By submitting a pull request you agree that your contribution will be licensed under the MIT License.
