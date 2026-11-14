<p align="center">
  🇬🇧 <strong>English</strong> | 🇫🇷 <a href="README.fr.md" lang="fr">Français</a> | 🇮🇹 <a href="README.it.md" lang="it">Italiano</a>
</p>

<p align="center">
  <img src="public/logostory.svg" alt="Story Studio" width="240">
</p>

<p align="center">
  A modern desktop editor for creating, combining, testing and generating Lunii-compatible audiobooks.
</p>

<p align="center">
  <a href=".github/workflows/ci.yml"><img alt="CI: desktop builds" src="https://img.shields.io/badge/CI-desktop%20builds-2ea44f.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="#requirements"><img alt="Platforms: Windows, Linux and macOS" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-0078D4.svg"></a>
  <a href="CHANGELOG.md"><img alt="Version 0.9.11" src="https://img.shields.io/badge/version-0.9.11-2F80ED.svg"></a>
  <a href="#beta-status"><img alt="Status: beta" src="https://img.shields.io/badge/status-beta-f59e0b.svg"></a>
  <a href="https://tauri.app/"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB.svg"></a>
  <a href="https://react.dev/"><img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB.svg"></a>
</p>

## Looking to create stories for My Fabulous Storyteller?

The [online user documentation](https://hugs11.github.io/story-studio/docs/) is currently available in French.

Story Studio lets you create and edit audiobooks for **My Fabulous Storyteller by Lunii**. It includes audio and image
editing tools, so you can build your audiobook without switching between Audacity and other
applications. Everything stays local: images, audio, navigation, simulation and ZIP generation.

Two editors let the workspace adapt to the project:

- the **Menu editor** organizes folders and stories in a straightforward tree;
- the **Graph editor** exposes Screens, choice lists and all their connections for branching stories, quizzes and intersecting paths. [Read the guide (in French)](https://hugs11.github.io/story-studio/docs/editeur-graphe/).

For a single story, the **Simple editor** offers a more guided starting point.

Import your media, assemble and trim audio, crop images, organize menus and
story paths, then generate a Lunii-compatible ZIP without juggling between
several tools.

> Story Studio is a community tool. It is not affiliated with, endorsed by, or
> sponsored by Lunii.

> **Story Studio is designed and developed with the assistance of AI tools. Design decisions, project direction, and final validation remain human-led.**

## Beta Status

Story Studio is currently in beta. The app is usable, but it may still contain
bugs, edge cases and compatibility issues with some community audiobooks. Please keep
backup copies of important projects and report reproducible problems through
GitHub issues.

> ### Join the community on Discord
>
> Have an idea for Story Studio, a bug to discuss quickly, want access to beta
> releases, or simply need help?
> [Join the Story Studio Discord server](https://discord.gg/jeC6Qk4NS) to talk
> directly with users and the people building the project.

## Using Story Studio with your Lunii

Writing to the device (sending, deleting, reordering and retrieving audiobooks) has been tested on a **Lunii V3 with firmware 3.1.5 and 3.3.4**, on Windows, Linux and macOS. Other models and firmware versions have not been verified on a real device, and a firmware update may change how the device stores audiobooks.

Initial **FLAM support is read-only**: Story Studio detects mounted devices and
shows their story list, cached titles, firmware and storage capacity. Transfers,
retrieval, editing and repair are not supported for FLAM. See
[FLAM support](docs/flam-support.md) for implementation and validation details.

- Back up your Lunii before writing to it for the first time, and keep copies of your packs.
- Official Lunii audiobooks are never copied back to your computer.
- Story Studio is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)). **You use it with your device at your own risk**: the authors cannot be held responsible for data loss or a device malfunction.

## Version 0.9.11

This version is mostly about making Story Studio more reliable. When the Lunii is busy, operations wait their turn instead of being refused. A sound that is too quiet is flagged when you add it. If you want, Story Studio can also tell you when a new version is out.

Since 0.9.10, Story Studio has a local audiobook catalogue and manages your Lunii directly. You can browse, send and retrieve audiobooks, manage the device list and eject it. Official titles and covers are optional and require your consent.

The interface is available in French, English and Italian. English and Italian translations were produced and reviewed with AI; corrections are welcome. On an existing installation without a language preference, the interface remains in French; change it in Preferences. New installations use the system language when available, otherwise English.

- [Download the latest public release](https://github.com/Hugs11/story-studio/releases/latest)
- [See the full changelog](CHANGELOG.md)

## Demo audiobooks

Discover Story Studio with two ready-to-open audiobooks that you can explore in the
Simulator and adapt in the editor:

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://drive.proton.me/urls/5ND49D487R#IxRa3Bd0Lm8L"><img src="docs/public/assets/demo-packs/leo-la-licorne.png" width="130" alt="Léo la licorne cover"></a><br>
      <strong>Léo la licorne</strong><br>
      <a href="https://drive.proton.me/urls/5ND49D487R#IxRa3Bd0Lm8L">Download from Proton Drive</a>
    </td>
    <td align="center" width="50%">
      <a href="https://drive.proton.me/urls/H7ZTBC8S14#aj2WBn39jDRF"><img src="docs/public/assets/demo-packs/toudou-cache-cache.png" width="130" alt="Toudou mon doudou and Cache-Cache cover"></a><br>
      <strong>Toudou mon doudou + Cache-Cache — complete collection</strong><br>
      <a href="https://drive.proton.me/urls/H7ZTBC8S14#aj2WBn39jDRF">Download from Proton Drive</a>
    </td>
  </tr>
</table>

To explore an audiobook in Story Studio:

1. Download its ZIP file from Proton Drive.
2. Launch Story Studio and click **Edit an existing audiobook**.
3. Select the downloaded `.zip` file.

These audiobooks are distributed separately from the software. Their stories, audio
files and illustrations are not covered by Story Studio's MIT license.

## At a Glance

| | |
|---|---|
| **Status** | Beta |
| **Target platforms** | Windows x64, Linux x86_64 and macOS Apple Silicon |
| **Interface languages** | French, English and Italian |
| **Project format** | `.mbah` |
| **Generation format** | Lunii-compatible ZIP audiobooks |
| **Main stack** | React 19, Vite, Tauri 2, Rust |
| **Workflow** | Guided home workflows, Menu editor, Graph editor, combining audiobooks from ZIP files, Media, Simulator and controlled ZIP generation |
| **Privacy model** | Local app, no hosted backend, no telemetry |

## From first import to finished audiobook

Story Studio keeps the complete workflow in one local application: start from
your own files or an existing audiobook, prepare the media, build the navigation,
test the result and generate an audiobook ready for your Lunii.

### 1. Start a project or import existing stories

Start however you like, reopen saved work, edit an existing ZIP/7z audiobook, or
start from a podcast or YouTube source. Dedicated guided flows also let you
combine several audiobooks or inspect a community audiobook.

![Story Studio home screen with the three editors and guided workflows](docs/public/assets/screenshots/home-dark.png)

### 2. Manage your collection and transfer audiobooks to your Lunii

Add your source folders, browse audiobooks in grid or list view, and organize
favorites and tags. Connect your Lunii to browse its stories, send audiobooks,
retrieve them into your catalogue and safely eject the device.

![Catalogue grid with a connected Lunii and audiobook details](docs/public/assets/screenshots/catalogue-lunii-dark.png)

<details>
<summary>See the catalogue in list view</summary>

![Catalogue list showing audiobook metadata, formats and copies](docs/public/assets/screenshots/catalogue-lunii-list-dark.png)

</details>

### 3. Prepare the audio

Import or record audio, then adjust it before using it in a story. A long
recording can be split into reusable clips, while several files can be reordered
and assembled into a single track without changing the originals.

![Editing an audio waveform in Story Studio](docs/public/assets/screenshots/audio-editor-dark.png)

| Split one recording into clips | Assemble several files into one track |
|---|---|
| ![Audio splitter with several prepared clips](docs/public/assets/screenshots/Audio-decoupe-light.png) | ![Audio assembly with reorderable source files](docs/public/assets/screenshots/Audio-assemble-light.png) |

### 4. Create voices, generate artwork and adapt images

Generate voices locally with zero-config Piper or use XTTS for advanced voice
cloning. ComfyUI can produce illustrations through a local service, with both
voice and image jobs followed from Story Studio's generation queues.

| Generate a voice locally with Piper or XTTS | Generate an illustration with ComfyUI |
|---|---|
| ![Local voice generation with Piper](docs/public/assets/screenshots/voice-generation-dark.png) | ![Illustration generation with a ComfyUI workflow](docs/public/assets/screenshots/comfyui-generation-dark.png) |

Images can then be cropped, resized and adjusted for the 320x240 Lunii
format.

![Cropping and adjusting an image for your Lunii](docs/public/assets/screenshots/image-editor-dark.png)

### 5. Build and test the navigation

With the **Menu editor**, build a tree of Folders and Stories, assign their
images and audio, and define what the buttons do during and after playback.
The Diagram lets you review the resulting path while preserving its
level-by-level organization.

![Unified workspace with the tree, story settings and Diagram](docs/public/assets/screenshots/workspace-dark.png)

With the **Graph editor**, work directly with Screens, choice lists and their
connections. It supports branching stories, quizzes, random selection and
paths that reuse the same Screens in several places.

![Graph editor overview with the node list and Inspector](docs/public/assets/screenshots/graph-editor-overview-dark.png)

Both editors share the Media, audio tools, generation queue and the same
floating Simulator. You can play through the navigation before ZIP generation as it
will behave on your Lunii.

![Full project Diagram tested with the built-in Simulator](docs/public/assets/screenshots/diagram-simulator-dark.png)

### 6. Review the settings and generate the ZIP

Review the public metadata, catalog thumbnail, output filename, and the audiobook's
audio or navigation settings. Story Studio checks the structure, identity and
media, then rereads the resulting ZIP before completing ZIP generation.

![Audiobook metadata with the catalog thumbnail, UUID and ZIP filename](docs/public/assets/screenshots/pack-metadata-dark.png)

![Audiobook audio and navigation settings](docs/public/assets/screenshots/Pack-settings.png)

Existing community audiobooks can also be analyzed separately. The checker groups
structural, image and audio findings, proposes safe corrections and can export
a detailed report.

![Community audiobook checker with proposed corrections](docs/public/assets/screenshots/pack-checker-dark.png)

## Features

- **Pack catalogue & Lunii**: organize local audiobooks, connect your Lunii, send and retrieve audiobooks, and manage its list.
- **Menu editor** with Folders, Stories, nested menus, multi-select, drag-and-drop and a Diagram.
- **Graph editor** with Screens, choice lists, connections, multi-selection, clipboard operations and automatic layout.
- **Guided home workflows** to edit an existing audiobook, create from a podcast or YouTube, combine audiobooks from ZIP files, and check/correct a community audiobook.
- **Lunii audiobook import (ZIP)**: choose between the two editors when possible, open complex structures in the graph, and select an audiobook from files containing several audiobooks.
- **Built-in audio workflow**: microphone recording, trimming, cuts, fades, assembly and silence insertion.
- **Built-in image workflow**: automatic 320×240 cropping, text-image generation from node names.
- **Local voice generation** with Piper by default and XTTS as an advanced opt-in backend.
- **Media** with tags, filters, usage counters and quick previews.
- **Built-in Simulator** to test navigation and end nodes before ZIP generation.
- **Validation and generation queue**: compatibility checks and serial generation with log tracking.
- **Optional local integrations**: YouTube via yt-dlp, XTTS (voice) and ComfyUI (images).
- **Project comfort**: optional-save sessions, autosave, recovery snapshots, safety versions, configurable shortcuts, light/dark themes, full Diagram view.

## Why Story Studio?

I was looking for a simple tool to create audio stories for my child. As a
former video editor, I could never find in existing tools what felt essential
to me: a visual and straightforward interface that makes building a narrative
fluid and frictionless, without relying on command-line tools or dealing with
complex folder structures.

Story Studio was born from that need: bringing import, images, audio,
navigation, simulation and ZIP generation into one clear local workspace.

## Requirements

| Platform | Requirements and limits |
|---|---|
| Windows x64 | Windows 10 or later with WebView2 |
| Linux x86_64 | A glibc-based distribution with WebKitGTK 4.1 and the usual GStreamer codecs; AppImage, DEB and RPM packages are available |
| macOS Apple Silicon | macOS 11 or later on an M1-or-newer Mac; Intel Macs are not supported |

Bundled third-party binaries keep their own licenses and pinned provenance —
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the
[corresponding-source offer](THIRD_PARTY_SOURCE_OFFER.md).

## Installation

Download the package for your platform from the
[GitHub Releases page](https://github.com/Hugs11/story-studio/releases/latest):

- **Windows x64:** use the EXE installer, or the MSI package for managed
  deployments.
- **AppImage:** make the file executable with `chmod +x Story-Studio*.AppImage`,
  then run it.
- **Debian/Ubuntu:** install the downloaded DEB with
  `sudo apt install ./Story-Studio*.deb`.
- **Fedora:** install the downloaded RPM with
  `sudo dnf install ./Story-Studio*.rpm`.
- **macOS Apple Silicon:** open the DMG, drag Story Studio into Applications,
  then launch the app.

The macOS build has no Developer ID certificate and is not notarized. Gatekeeper
may therefore block its first launch. In Finder, Control-click the app and
choose **Open**, or use **System Settings → Privacy & Security → Open Anyway**.
Do not disable Gatekeeper globally.

AI integrations are optional. XTTS was tested on Linux in CPU mode; GPU mode
was not validated for 0.9.9. ComfyUI is manually validated on Windows only: manual Linux tests have not been run.

To build from source or contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project Files and Workspace

Story Studio saves projects as `.mbah` files. Runtime assets are organized in
managed workspace folders:

| Folder | Purpose |
|---|---|
| `fichiers-importes/` | Imported media files when copy-on-import is enabled |
| `enregistrements/` | Microphone recordings |
| `voix-generees/` | XTTS-generated voice clips |
| `images-generees/` | ComfyUI-generated and edited images |
| `zips-extraits/` | Unpacked ZIP collections |
| `sauvegardes/` | Default save folder and safety versions |
| `exports/` | Suggested output folder for generated audiobooks |

Files in managed media folders use a `{project-name}__` prefix so multiple
projects can share the same workspace more safely.

Application data is stored under `%LOCALAPPDATA%\com.hugs11.story-studio` on
Windows, `${XDG_DATA_HOME:-~/.local/share}/com.hugs11.story-studio` on Linux,
and `~/Library/Application Support/com.hugs11.story-studio` on macOS.
User-selected files remain accessible outside these folders, including on
external macOS volumes under `/Volumes`.

When Story Studio offers to delete media from disk, it only deletes files inside
managed workspace media folders. Files stored elsewhere are only removed from the project or the Media,
never deleted from disk.

## Documentation

- [Online user documentation](https://hugs11.github.io/story-studio/docs/) — currently available in French
- [Piper and XTTS local voices](https://hugs11.github.io/story-studio/docs/voix-locales-piper-xtts/) — French
- [ComfyUI integration](https://hugs11.github.io/story-studio/docs/comfyui/) — French
- [Security model](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

The security model, third-party notices and changelog are currently available only in English.

## Roadmap

- Fix the remaining bugs.
- Get out of beta with a finished v1.
- Make the app work with other story boxes.

## Contributing

Contributions are welcome, especially:

- Reproducible bug reports.
- Compatibility notes for community audiobooks.
- Documentation improvements.
- Translation corrections are welcome on GitHub: open an issue or propose a pull request; see [TRANSLATING.md](TRANSLATING.md).
- Focused pull requests with clear testing notes.

To discuss an idea before opening an issue or quickly share beta-test feedback,
you can also join the
[Story Studio Discord server](https://discord.gg/jeC6Qk4NS).

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Story Studio is a local desktop file editor. Optional XTTS and ComfyUI features
connect to local services configured by the user.

See [SECURITY.md](SECURITY.md) for the permissions model and vulnerability
reporting process.

## License

Story Studio source code is licensed under the [MIT License](LICENSE).

Bundled third-party binaries and copied third-party assets remain under their
respective licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
