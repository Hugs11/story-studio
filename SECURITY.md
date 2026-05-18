# Security

## Scope

Story Studio is a local Windows desktop application. It has no network backend, no user accounts, and no telemetry. All data stays on the user's machine.

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

`ffmpeg.exe` and `7z.exe` are bundled third-party binaries. They are invoked as subprocesses with arguments constructed in Rust. User input is never passed directly to shell commands; arguments are always passed as discrete array elements to prevent injection.

See `THIRD_PARTY_NOTICES.md` for provenance details on the bundled binaries.

## User-configured external launchers

If the user enables the **ComfyUI** integration and supplies a path to a local
`.bat` launcher (Preferences → ComfyUI), Story Studio can spawn that batch file
to start the ComfyUI server. The launcher path comes from the user's local
preferences only; it is never fetched from a remote source. The spawn uses
`cmd /c "<path>"` with the path passed as a discrete argument (no shell
interpolation of user input). Story Studio does not download, install or
auto-update ComfyUI — the user fully controls which `.bat` runs.

If you do not configure a ComfyUI launcher, no external process is spawned by
this integration.

## Reporting a vulnerability

If you find a security issue, please **do not open a public GitHub issue**.
Instead, use **GitHub Private Vulnerability Reporting** on this repository:

> Security tab → "Report a vulnerability"

Please include a description of the issue, steps to reproduce, and the Story
Studio version. You will receive a response within 7 days.
