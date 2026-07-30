# Security

## Scope

Story Studio is a local desktop application for Windows, Linux and macOS. It
has no network backend, no user accounts and no telemetry. All data stays on
the user's machine.

## Permissions model

Story Studio uses broad filesystem read access because it is a file editor: users select media files from arbitrary disk locations. This is intentional and documented.

Project files (`.mbah`) are written through the Tauri filesystem plugin to the
path explicitly chosen by the user. Generated or imported media writes are
routed to managed workspace folders (`fichiers-importes/`, `enregistrements/`,
`voix-generees/`, `images-generees/`, `zips-extraits/`) by the frontend or by
Rust commands depending on the workflow.

Destructive operations such as deleting media from disk are routed through Rust
Tauri commands. User-facing media deletion is constrained to files inside the
configured workspace, and only under:

- `fichiers-importes/`
- `enregistrements/`
- `voix-generees/`
- `images-generees/`

External source files, temporary files, directories, files next to a `.mbah`,
and `zips-extraits/` are not deleted by the media deletion flows. They can be
removed from the project/library, but the original disk file is preserved.

The Tauri capability configuration lives in `src-tauri/capabilities/`.

The optional XTTS and ComfyUI integrations make HTTP requests to `localhost` only — no external servers are contacted by default.

## Bundled binaries

Native FFmpeg and 7-Zip executables are bundled for every supported platform.
They are invoked as subprocesses with arguments constructed in Rust. User
input is never interpolated into a shell command; executable paths and
arguments are passed as discrete process parameters.

See `THIRD_PARTY_NOTICES.md` for provenance details on the bundled binaries.

## User-configured external launchers

If the user enables the **ComfyUI** integration and supplies a path to a local
launcher (Preferences → ComfyUI), Story Studio can start that file to launch
the ComfyUI server. Windows `.bat` and `.cmd` files are passed to `cmd /c` as a
discrete argument; Unix `.sh` files are either executed directly or passed to
`/bin/sh` as a discrete argument. Other executable launchers run directly.
The launcher must be a regular local file and cannot be a symbolic link. Its
path comes from local preferences only and is never fetched remotely. Story
Studio does not download, install or auto-update ComfyUI.

If no ComfyUI launcher is configured, this integration spawns no external
process.

## Reporting a vulnerability

If you find a security issue, please **do not open a public GitHub issue**.
Instead, use **GitHub Private Vulnerability Reporting** on this repository:

> Security tab → "Report a vulnerability"

Please include a description of the issue, steps to reproduce, and the Story
Studio version. You will receive a response within 7 days.
