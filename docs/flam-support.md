# FLAM support

Story Studio supports FLAM library browsing in read-only mode. The initial
implementation was checked on Linux with a mounted FLAM running firmware
2.4.1. Windows and macOS use the same file parser but have not been checked on
a physical FLAM.

The device panel shows the ordered story list, hidden stories when listed,
titles from the optional firmware cache, firmware version and storage capacity.
The existing operating-system ejection command is available. Titles can be
absent when the cache is missing or uses an unknown layout. A missing or invalid
playlist is reported without offering Lunii repair operations.

Sending, retrieving, removing, reordering, renaming, hiding and repairing are
disabled in both the interface and the backend. The Lunii device writer refuses
FLAM roots, including roots containing both `.md` and `.mdf`. Inspection does
not create sidecars, regenerate playlists, clear caches or read device keys.

A separate [experimental native-Lua prototype](../scripts/prototypes/flam-native/README.md)
can be prepared and installed explicitly outside the app's production transfer path.
Its second version has user-confirmed playback with audio profile B and return
to the start screen on firmware 2.4.1. Inventory, dice and durable saves remain
unvalidated. This does not enable FLAM writes in the app.

## File layout

- `.mdf` identifies the device family. Inspection reads only the first 50 bytes:
  a little-endian format version and a 48-byte firmware field. It does not read
  the serial or the key material beginning at offset `0x4e`.
- `etc/library/list` contains newline-separated full story UUIDs in device
  order. `etc/library/list.hidden` is optional. Duplicates retain their first
  occurrence; visible entries take priority over hidden entries.
- Listed story folders live under `str/<uuid>` or `str.hidden/<uuid>`. The
  presence of `info` and `key`, together with either `main.lsf` and `version`
  or the index files `ni`, `li`, `ri` and `si`, indicates the expected container
  files, not a validation of playable content. FLAM 2.x can hold both layouts.
  Their contents are not decoded.
- `usr/0/library.cache` supplies optional titles. The observed 2.4 layout starts
  with a 32-bit count, 64 firmware bytes and a table of 32-bit record offsets.
  A record contains its size, story kind (1 for Lua, 2 for index-based), then three 16-bit-length,
  NUL-terminated UTF-8 strings: UUID, `/str/<uuid>` and title. Remaining
  thumbnail data is ignored. Invalid, unknown or truncated caches are ignored;
  cache entries never add stories to the authoritative playlist.

Reads are bounded and all paths use the existing ancestor symlink/reparse-point
checks. Tests use synthetic devices; no device files or credentials are stored
in the repository.

The public metadata and playlist layout were cross-checked against
[Lunii.QT's FLAM implementation](https://github.com/o-daneel/Lunii.QT/blob/main/pkg/api/device_flam.py).
The cache string layout was observed on the mounted firmware. Supporting writes
requires a separate FLAM transfer implementation and playback validation;
Lunii-format transfers cannot simply be redirected into `str/`.

## Validation

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib storyteller_device::
node --test scripts/luniiDevices.test.mjs scripts/luniiPanel.test.mjs
```

An optional read-only test checks native discovery and inventory on a device
explicitly selected through environment variables. Supply its mount path and
expected story count:

```sh
STORY_STUDIO_FLAM_TEST_ROOT=/run/media/user/FLAM \
STORY_STUDIO_FLAM_TEST_STORIES=11 \
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  mounted_flam_inventory -- --ignored --nocapture
```

This test checks that all expected stories have cached titles and container
files and that the playlist bytes stay unchanged. It performs no transfers,
repairs, mounts or ejection.
