# Changelog

This changelog is intentionally concise. It summarizes the main public features
added to Story Studio over time, without mirroring every internal commit.

GitHub Releases carry the detailed notes and downloadable installers for each
public version; this file stays as the concise project history.

---

## [Unreleased]

---

## [0.9.2] - 2026-06-18

Story Studio v0.9.2 focuses on making pack preparation easier to understand:
community pack checking, a cleaner audio pipeline, podcast import, audio
splitting and a complete UI redesign around clearer navigation and actions.

### Added

- Added a community pack checker/corrector for ZIP packs, with analysis for
  structure, navigation, metadata, images, audio loudness, edge silences and
  saturated sources.
- Added an HTML export for community pack checker reports.
- Added dedicated checker states for audio that is already saturated at the
  source, with a clear "not correctable" warning instead of pretending the
  distortion can be repaired automatically.
- Added podcast RSS import so episodes can be brought into a project more
  directly.
- Added an audio splitter to cut an audio file before using it in a story,
  menu, assembly or generated pack.
- Added launcher buttons to open project and ZIP simulation more directly.
- Added navigation rails and clearer diagram path highlighting so users can
  better understand where they are and how stories return or chain together.
- Added image level controls and conversion for Lunii-unsupported image
  formats.

### Changed

- Redesigned the application UI for better comprehension, including the app
  chrome, toolbar, project/generation/options popovers, buttons, dialog actions,
  light theme, validation states and editor layouts.
- Reworked audio preparation around a `-14 LUFS` target, static gain,
  peak limiting at `-2 dBFS`, and shared rules between the checker and native
  generator. `loudnorm` is no longer used as the final correction path.
- Kept working audio in FLAC until final export to avoid repeated lossy MP3
  compression during edits and replacements.
- Normalized leading and trailing silence by measuring each file first, then
  setting clean edge silence to about `0.5 s` instead of blindly adding silence.
- Made pack loudness correction and silence correction independent, so fixing
  one no longer unexpectedly changes the other.
- Improved the tree workflow with toolbar search, steadier folder drag/drop,
  multi-selection expand/collapse and clearer display options.
- Improved missing-media relinking, audio replacement in place, edited audio
  preview refresh and reuse of original audio sources after editing.
- Refined the AI queue, home screen actions and audio trim controls.
- Removed obsolete global selection options and simplified pack metadata copy.

### Fixed

- Fixed legacy workspace media path handling.
- Fixed project naming when unpacking ZIP packs.
- Fixed thumbnail export so generated thumbnails are forced to PNG.
- Fixed end-node deletion and confirmation edge cases.
- Fixed duplicate native tooltips and the audio original restore workflow.
- Fixed autoplay preview behavior to match generated packs more closely.
- Fixed compact layouts for audio controls, root menus, dialogs, popovers and
  central editor panels.
- Fixed several navigation, validation, keyboard shortcut, media explorer and
  generated pack edge cases discovered during the 0.9.2 redesign.

---

## [0.9.1] - 2026-06-01

Story Studio v0.9.1 is a maintenance and architecture release focused on
making the project easier to understand, test and extend after the first public
beta releases.

### Changed

- Reorganized the native Rust pack generation engine into smaller, focused
  modules for assets, document building, stage writing, returns, night mode and
  imported ZIP handling.
- Split pack import, project file operations, ComfyUI services and audio edit
  workflows into clearer service boundaries.
- Simplified the project model around `rootEntries`: legacy `rootItems` and
  `menus` are migrated on load but are no longer saved or sent to Rust.
- Replaced native frontend error/confirmation dialogs with the shared Story
  Studio dialog and aligned frontend log event names on `module:action`.
- Shared frontend tree operations between the tree panel and diagram views, and
  extracted several large UI/audio/image editor areas into smaller helpers and
  hooks.
- Improved diagram navigation readability with highlighted return paths, clearer
  route labels/icons and a resizable settings panel.
- Improved tree return badges with clearer default/override states, better
  spacing, route arrows and dedicated visibility controls.
- Improved tree badge, simulator, image editor, media explorer and audio editor
  behavior discovered during the architecture cleanup.

### Added

- Added `npm run convert:legacy-project` to convert older `.mbah` files to the
  current rootEntries-only project shape, with overwrite protection by default.
- Added synthetic Rust round-trip coverage for generated packs, night-mode packs
  and imported native graphs.
- Added local audit scripts for dead code and import cleanup.
- Added recent-project thumbnails on the home screen.
- Added streamed generation logs and cancel support for the render queue.

### Fixed

- Prevented `scoped_label_id` collisions for entries sharing the same first
  eight ID characters.
- Hardened XTTS output filenames and recording names against path-like or
  overly long values.
- Fixed missing-media relinking, imported audio cover extraction, generated
  media drops, image edit metadata, image filter framing and audio waveform sync.
- Fixed several navigation, end-node, import, generated-media, waveform and
  compact-layout edge cases found while validating the reorganized code.

### Performance

- Parallelized native pack asset preprocessing with Rayon so audio conversion
  through FFmpeg, image resizing and imported ZIP preparation can run across
  multiple CPU cores before the final deterministic staging step.
- Lazy-loaded heavy audio and image editor modals, reduced tree drag/drop churn
  and cached tree badge data for smoother large-project editing.

---

## [0.9.0] - 2026-05-22

### Added

- French README and French setup/release documentation for XTTS, ComfyUI and
  release workflows.
- GitHub Pages landing site under `docs/` introducing the project with
  screenshots and feature highlights.
- Configurable keyboard shortcuts, with shortcuts grouped by context so editor,
  tree and audio-editor actions can be tuned independently.
- Diagnostic preferences for beta debugging, including opt-in logs, resolved log
  paths and clearer bug-report guidance.

### Changed

- Replaced the app logo and favicon with SVG assets and regenerated Tauri
  application icons.
- Redesigned navigation badges in the project tree as tinted square icons with
  a unified OKLCH palette and clearer tooltips.
- Renamed multi-selection and end-node editor sections to "Pendant la lecture"
  / "Après la lecture" for a clearer split between active controls and
  post-playback destinations.
- Replaced native dropdowns in every navigation destination field with a custom
  listbox showing Lucide icons (folder, music, play) consistent with the
  project tree, grouped by category and keyboard-accessible.
- Renamed the "Début du pack" destination to "Première entrée du pack" to match
  what the firmware actually navigates to.
- Each navigation dropdown now shows the resolved destination inline
  (e.g. `↳ Quelle histoire... (premier élément du pack)`) so users see where a
  default or contextual setting actually leads.
- The story editor's "Après la lecture" card now chains a second pill showing
  the destination reached after the end-node bridge
  (`Passe par le nœud de fin du pack → Mini Loup à l'école`).
- Separated the project name (local identity used for file prefixes, window
  title and the `.mbah` filename) from the published pack name (community
  convention with age, title, author, version, producer, bonus). The pack
  card in the central panel has been removed; pack metadata is now edited
  through a dedicated modal opened from the title bar or the toolbar split
  button. Existing projects are migrated automatically on load — the legacy
  free-text pack name is parsed into structured fields or preserved as a
  legacy export name.
- Refactored the title bar into a breadcrumb (Story Studio › project name ›
  pack title) with a clickable pack recap that opens the metadata modal, a
  save indicator, and consistent project tooltips on every element.
- Replaced the central "Générer le pack" CTA with a split button in the
  toolbar offering "Generate now", "Edit metadata…" and "Open export folder".
- File prefixes for imported media, recordings, XTTS output, ComfyUI output
  and audio assemblies now derive from the project name (short and stable)
  instead of the full conventional pack name, producing shorter and more
  identifiable filenames.
- Root editor card "Menu Racine" rewords the image section: subtitle adapts
  to the chosen mode ("Affichée sur la Lunii et utilisée comme image de
  catalogue (320×240)" vs "Une image pour la Lunii, une pour les
  catalogues"), and the split slots are renamed "Écran Lunii (320×240)" and
  "Vignette bibliothèque" instead of device-specific labels.
- Replaced the persistent right-side validation panel with a compact toolbar
  validation pill that groups blocking issues and jumps directly to the
  affected node.
- Split validation feedback into blocking errors and items still to complete, so
  the toolbar badge better matches what prevents generation.
- Unified the media explorer search and filter controls for a quieter, more
  consistent library workflow.
- Improved simple-story mode and compact desktop layouts so editor surfaces stay
  usable on smaller windows.
- Clarified the story "Après la lecture" card: controls available during
  playback are separated from end-of-story behavior, automatic end-node routing
  is shown as a generated-pack fact, and optional custom end messages stay in
  advanced settings by default.
- Refreshed the README screenshots with the current pack workspace, story
  editor and pack metadata flows.

### Fixed

- Fixed Rust 1.95 Clippy compatibility for the public CI toolchain.
- Serialized local XTTS and ComfyUI generation queues to avoid launching many
  heavy AI jobs at once and exhausting system memory.
- Fixed Windows audio edit paths after trim/cut operations, made edited audio
  originals visible next to the edited file, and kept those backup files out of
  media scans unless they are explicitly referenced by the project.
- End-of-story node now appears in the tree, diagram and flow views as soon as
  it is added from the context menu, even before its audio is configured.
- Fixed Home navigation badge visibility on stories when an end node is active,
  and removed a misleading per-story badge that mirrored a global setting.
- Preserved the per-pack end-node Home return target when loading packs from
  disk so imported community packs keep their configured night-mode home.
- Allowed pack metadata to specify a version number without requiring an
  author field.
- Simplified empty-state actions in the media explorer.
- Navigation destinations shown in editors and diagrams now reflect the actual
  generated behavior, including the `autoNext` next-story shortcut, contextual
  `next_story` resolution per source story, and the end-node fallback that
  inherits each story's own return target when no global destination is set.
- Project tree badges now focus on direct navigation overrides and hide
  advanced end-flow details such as end messages, end sequences and imported
  end-node returns.
- The story "Accueil" selector once again anchors its default destination with
  an explicit `Réglage par défaut : ...` hint.
- Validation issue selection now closes the toolbar dropdown immediately, and
  its keyboard handling no longer intercepts keys outside the validation menu.
- Bottom-bar tab pills stay hidden while the side panel is open, avoiding
  duplicated navigation controls in constrained layouts.

---

## [0.8.9] - 2026-05-18

Public GitHub release preparation.

- Professional open-source repository metadata: README, contribution guide,
  security policy, release checklist, issue templates and pull request template.
- Simplified public changelog focused on major user-facing features.
- Repository cleanup for public distribution, including ignored local artifacts,
  bundled binary notices and screenshot guidance.

---

## [0.8.8] - 2026-05

Media workspace and editor polish.

- Media manager with grid/list views, metadata columns, tags, usage counters,
  quick preview, sorting, filtering and multi-selection.
- Audio assembly workflow for combining multiple audio files into one MP3.
- Drag and drop from Windows Explorer into the project tree and media library.
- AI generation queue panel for local XTTS and ComfyUI jobs.
- Floating simulator improvements for diagram and editor workflows.
- Tree panel color tags, collapsible folders, descendant counters and refreshed
  vector icons.
- FLAC support in audio pickers, metadata probing and pack generation.

---

## [0.8.7] - 2026-05

Round-trip import/export and advanced audio editing.

- Folder import workflow that creates one story per audio file.
- Persistent pack-name bar with community naming convention support.
- Advanced import support for complex Lunii ZIP graphs and preserved native
  story structures.
- End-of-story prompt editing, including OK/Home controls and multi-step
  playback sequences.
- Native auto-next story generation.
- Audio editor with waveform seeking, trim previews, cuts, fades, zoom and
  keyboard shortcuts.

---

## [0.8.6] - 2026-05

Audio editing and large-pack handling.

- Waveform-based audio trim editor powered by WaveSurfer.
- Lazy audio loading for better performance on large projects.
- Position-aware drag and drop indicators in the story tree.
- Increased archive import limits for very large community packs.
- Automatic image resizing to Lunii-compatible 320x240 assets during export.

---

## [0.8.5] - 2026-05

Search, cleanup and usability tools.

- Structure search with configurable keyboard shortcut.
- Project cleanup tool for detecting unused managed files.
- "Show in Explorer" actions for media fields and tree nodes.
- Optional compact diagram inside the editor panel.
- Image generation dialog improvements, including root cover as reference image.

---

## [0.8.4] - 2026-04

User preferences and interface customization.

- Configurable keyboard shortcuts.
- Light, dark and system theme preference.
- Redesigned home screen with recent projects.
- Richer tooltips and clearer required-media states.
- AI generation panel improvements for generated images and audio.

---

## [0.8.3] - 2026-04

Save system and diagram refinement.

- More reliable project save flow and asset copy handling.
- More compact full-diagram view for larger packs.
- Resizable render queue panel.
- Clearer navigation badges for return targets and end nodes.

---

## [0.8.2] - 2026-04

Security hardening.

- Safer ComfyUI launcher execution.
- ZIP extraction constrained to managed project folders.
- Local-only network validation for XTTS and ComfyUI services.
- Safer validation of generated images, imported ZIPs and bundled tool usage.

---

## [0.8.1] - 2026-04

Open-source groundwork.

- Contribution guide, security policy, issue templates and pull request template.
- Developer command aliases for Tauri workflows.
- README prerequisites and project file documentation.
- Expanded `.gitignore` for local configuration and generated artifacts.

---

## [0.8.0] - 2026-04

Licensing and public distribution preparation.

- MIT license added for the Story Studio source code.
- Third-party notices added for bundled binaries and copied icon assets.
- Initial Tauri filesystem and command security review.

---

## [0.7.9] - 2026-03

Render queue and story endings.

- Background render queue for generating multiple packs sequentially.
- Explicit end-of-story node support in the graph model.
- Audio option to trim leading and trailing silence during export.

---

## [0.7.8] - 2026-02

Editor refinement.

- Broad UX and layout polish across the editor.
- Stability improvements for pack editing workflows.

---

## [0.7.6] - 2026-01

Pack generation reliability.

- Fixed asset role collisions so regenerated packs keep distinct story content.

---

## [0.7.5] - 2026-01

Diagram editing and navigation.

- Full diagram multi-select, group editing, clipboard and context menu support.
- Sequential story navigation with configurable next-story targets.
- Shared tooltip system for richer inline help.

---

## [0.7.4] - 2025-04

Compatibility validation.

- Lunii compatibility validator for checking generated pack structure.
- Audio conversion fixes around bundled ffmpeg workflows.

---

## [0.7.3] - 2025-04

Editor layout polish.

- Unified media panel layout across node editors.
- Streamlined story and menu image controls.
- Refined app chrome and export naming.

---

## [0.7.2] - 2025-04

Performance pass.

- React rendering optimizations for larger projects.
- Faster project indexing and lookup behavior.
- Import path fixes after asset extraction.

---

## [0.7.0] - 2025-04

Navigation workflow.

- Return-target workflow after story playback.
- Full pack flow diagram.
- Background XTTS queue that applies generated voice clips to target fields.

---

## [0.6.0] - 2025-03

Native generation and local AI integrations.

- Native Rust pack engine replacing the previous Studio-Pack-Generator flow.
- Direct `.zip` and `.7z` pack import without Java.
- XTTS voice generation and ComfyUI image generation integrations.
- Copy/cut/paste in the story tree.
- Embedded MP3 cover-art import.

---

## [0.5.1] - 2025-02

Project format refinement.

- Project file extension changed from `.lunii` to `.mbah`.
- More accurate dirty-check behavior before prompting to save.

---

## [0.5.0] - 2025-02

Media creation tools.

- Built-in image editor with crop, pan, zoom and color filters.
- Automatic text-image generation from node names.
- Pack simulator with ZIP support, audio playback and night-mode preview.
- Microphone recording workflow.

---

## [0.4.0] - 2025-01

Tauri desktop foundation.

- Rust/Tauri backend replacing the previous Node.js layer.
- Project store with undo history.
- Real-time validation panel.
- Drag-and-drop story tree reordering.
- Multi-file import for audio and ZIP assets.

---

## [0.3.0] - 2024-12

Initial application.

- Graphical editor for Lunii story packs.
- Simple story and multi-pack project modes.
- Menu, story and ZIP node editing.
- Lunii-compatible ZIP generation through the original generator workflow.
