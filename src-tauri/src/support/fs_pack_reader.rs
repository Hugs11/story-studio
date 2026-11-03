use crate::support::imported_pack::cancellation;
use crate::support::user_message;
use crate::support::user_message::codes;
#[cfg(test)]
use crate::support::user_message::MessageTransportAssertions as _;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::native_pack::{
    classify_stage_id, named_option_targets, ActionNode, ControlSettings, OptionSelection,
    Presence, StageNode, StoryDocument, StoryDocumentContext, Transition, STAGE_TYPE_FALLBACK,
};
use crate::support::fs_pack_diagnostics::{
    ActionOffsetReuse, FsPackObserver, NativeTransition, NoopObserver, OptionSlot, RawControls,
    Trigger,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FsPackVariant {
    /// `ri`/`si`/`li` and assets enciphered with the common key.
    Encrypted,
    /// `ri.plain`/`si.plain`/`li.plain`, assets with an extension.
    Plain,
    /// Same names as `Encrypted` (no suffix, extensionless assets) but stored
    /// in clear. Selected by index detection or explicitly for rereading
    /// a plain storyteller output before device encryption.
    Cleartext,
}

impl FsPackVariant {
    fn index_name(self, base: &str) -> String {
        match self {
            Self::Encrypted | Self::Cleartext => base.to_string(),
            Self::Plain => format!("{base}.plain"),
        }
    }

    fn decode(self, bytes: &[u8]) -> Vec<u8> {
        match self {
            Self::Encrypted => decipher_common_key(bytes),
            Self::Plain | Self::Cleartext => bytes.to_vec(),
        }
    }

    fn preview_name(self) -> &'static str {
        match self {
            Self::Encrypted => "encrypted",
            Self::Plain => "plain",
            Self::Cleartext => "cleartext",
        }
    }

    /// Inverse of the `variant` name written by `read_fs_pack_preview`.
    pub(crate) fn from_preview_name(name: &str) -> Option<Self> {
        match name {
            "encrypted" => Some(Self::Encrypted),
            "plain" => Some(Self::Plain),
            "cleartext" => Some(Self::Cleartext),
            _ => None,
        }
    }
}

/// Marker file of a device pack whose suffix-less indexes and assets are
/// stored in clear (it only orders the content probe, it never proves it).
pub(crate) const FS_PACK_CLEARTEXT_MARKER: &str = ".cleartext";

/// Neither a clear read nor the common key yields a valid asset index: the
/// pack is enciphered with another (device-bound) key.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct FsPackUnknownKey;

/// Whether the deciphered zone of an asset index (`ri`/`si`) reads as asset
/// names. `None` when the sample holds no complete record to judge.
fn index_names_readable(index: &[u8]) -> Option<bool> {
    // The common-key cipher only covers the first 512 bytes: beyond them,
    // both readings are identical and prove nothing.
    let zone = &index[..index.len().min(512)];
    let mut records = zone.chunks_exact(12).peekable();
    records.peek()?;
    Some(records.all(|record| {
        std::str::from_utf8(record).is_ok_and(|name| {
            let name = name.trim_matches('\0');
            !name.is_empty() && !name.chars().any(|c| c.is_control())
        })
    }))
}

/// Shared rule deciding how the indexes of a structurally detected pack are
/// read, for the catalogue preview and the import conversion alike. A `Plain`
/// pack is named so and kept. Suffix-less indexes are deciphered with the
/// common key unless their content proves they are stored in clear; the
/// `.cleartext` marker only makes the clear reading the first one tried,
/// since some marked packs are enciphered. `samples` are raw asset indexes
/// (`ri`, then `si`): the first one holding a complete record decides.
pub(crate) fn resolve_fs_pack_index_variant(
    structural: FsPackVariant,
    cleartext_marker: bool,
    samples: &[&[u8]],
) -> Result<FsPackVariant, FsPackUnknownKey> {
    if structural == FsPackVariant::Plain {
        return Ok(FsPackVariant::Plain);
    }
    for sample in samples {
        let Some(clear) = index_names_readable(sample) else {
            continue;
        };
        let deciphered = index_names_readable(&decipher_common_key(sample)) == Some(true);
        return match (cleartext_marker, clear, deciphered) {
            (true, true, _) | (false, true, false) => Ok(FsPackVariant::Cleartext),
            (_, _, true) => Ok(FsPackVariant::Encrypted),
            (_, false, false) => Err(FsPackUnknownKey),
        };
    }
    // Nothing to judge (no image nor sound record): the marker decides.
    Ok(if cleartext_marker {
        FsPackVariant::Cleartext
    } else {
        FsPackVariant::Encrypted
    })
}

/// MP3 (ID3 tag or MPEG frame sync) or Ogg signature of a device-pack sound.
fn has_audio_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"ID3")
        || bytes.starts_with(b"OggS")
        || matches!(bytes, [0xFF, second, ..] if second & 0xE0 == 0xE0)
}

fn fs_pack_unknown_key_message() -> String {
    user_message::UserMessage::new(codes::IMPORT_FS_ENCRYPTED_UNKNOWN_KEY)
        .with_detail("Pack chiffré avec une clé inconnue : ni la lecture en clair ni la clé commune ne donnent un index d'assets lisible.")
        .into_transport()
}

/// Decodes one asset already read by the caller (catalogue covers), with the
/// same per-variant decoding as the conversion: the cipher stays here.
pub(crate) fn decode_fs_pack_asset(variant: FsPackVariant, bytes: &[u8]) -> Vec<u8> {
    variant.decode(bytes)
}

/// Resolve each component without rewriting actual filesystem names. Exact
/// spelling wins; ASCII-insensitive fallback matches ZIP device-pack lookup.
/// Asset validation and canonical confinement still apply to the resolved path.
pub(crate) fn resolve_fs_path(root: &Path, relative: impl AsRef<Path>) -> PathBuf {
    let relative = relative.as_ref();
    let mut path = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return root.join(relative);
        };
        let exact = path.join(name);
        if std::fs::symlink_metadata(&exact).is_ok() {
            path = exact;
            continue;
        }
        let actual =
            std::fs::read_dir(&path).ok().and_then(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry.file_name().to_str().zip(name.to_str()).is_some_and(
                            |(actual, requested)| actual.eq_ignore_ascii_case(requested),
                        )
                    })
                    .min_by_key(|entry| entry.file_name())
            });
        path = actual.map(|entry| entry.path()).unwrap_or(exact);
    }
    path
}

pub(crate) fn detect_fs_pack_variant(pack_dir: &Path) -> Option<FsPackVariant> {
    detect_fs_pack_variant_with(
        |name| resolve_fs_path(pack_dir, name).is_file(),
        |name| resolve_fs_path(pack_dir, name).is_dir(),
    )
}

/// Whether an on-disk device pack carries the [`FS_PACK_CLEARTEXT_MARKER`].
pub(crate) fn has_fs_pack_cleartext_marker(pack_dir: &Path) -> bool {
    resolve_fs_path(pack_dir, FS_PACK_CLEARTEXT_MARKER).is_file()
}

/// Shared structural rule for on-disk and archived device packs. Suffix-less
/// indexes are reported `Encrypted`; whether they are actually stored in clear
/// is decided from their content by [`resolve_fs_pack_index_variant`].
pub(crate) fn detect_fs_pack_variant_with(
    file: impl Fn(&str) -> bool,
    directory: impl Fn(&str) -> bool,
) -> Option<FsPackVariant> {
    if !file("ni") || !directory("rf") || !directory("sf") {
        return None;
    }
    let indexes = |suffix: &str| {
        ["ri", "si", "li"]
            .iter()
            .all(|name| file(&format!("{name}{suffix}")))
    };
    match (indexes(""), indexes(".plain")) {
        (true, false) => Some(FsPackVariant::Encrypted),
        (false, true) => Some(FsPackVariant::Plain),
        _ => None,
    }
}

// XXTEA common key (hardcoded in STUdio)
const COMMON_KEY: [u8; 16] = [
    0x91, 0xbd, 0x7a, 0x0a, 0xa7, 0x54, 0x40, 0xa9, 0xbb, 0xd4, 0x9d, 0x6c, 0xe0, 0xdc, 0xc0, 0xe3,
];

fn xxtea_key() -> [u32; 4] {
    [
        u32::from_be_bytes([COMMON_KEY[0], COMMON_KEY[1], COMMON_KEY[2], COMMON_KEY[3]]),
        u32::from_be_bytes([COMMON_KEY[4], COMMON_KEY[5], COMMON_KEY[6], COMMON_KEY[7]]),
        u32::from_be_bytes([COMMON_KEY[8], COMMON_KEY[9], COMMON_KEY[10], COMMON_KEY[11]]),
        u32::from_be_bytes([
            COMMON_KEY[12],
            COMMON_KEY[13],
            COMMON_KEY[14],
            COMMON_KEY[15],
        ]),
    ]
}

fn xxtea_mx(k: &[u32; 4], e: usize, p: usize, y: u32, z: u32, sum: u32) -> u32 {
    ((z >> 5 ^ y << 2).wrapping_add(y >> 3 ^ z << 4)) ^ ((sum ^ y).wrapping_add(k[(p & 3) ^ e] ^ z))
}

fn xxtea_decipher(v: &mut [u32]) {
    let n = v.len();
    if n < 2 {
        return;
    }
    let k = xxtea_key();
    const DELTA: u32 = 0x9e3779b9;
    let rounds = 1u32 + 52 / n as u32;
    let mut sum = rounds.wrapping_mul(DELTA);
    let mut y = v[0];
    for _ in 0..rounds {
        let e = ((sum >> 2) & 3) as usize;
        for p in (1..n).rev() {
            let z = v[p - 1];
            let m = xxtea_mx(&k, e, p, y, z, sum);
            v[p] = v[p].wrapping_sub(m);
            y = v[p];
        }
        let z = v[n - 1];
        let m = xxtea_mx(&k, e, 0, y, z, sum);
        v[0] = v[0].wrapping_sub(m);
        y = v[0];
        sum = sum.wrapping_sub(DELTA);
    }
}

// Mirror of Java XXTEACipher.cipherCommonKey(DECIPHER, data):
// deciphers min(128, len/4) ints from the first 512 bytes, leaves the rest unchanged.
fn decipher_common_key(data: &[u8]) -> Vec<u8> {
    let op = (data.len() / 4).min(128);
    if op < 2 {
        return data.to_vec();
    }
    let mut v: Vec<u32> = (0..op)
        .map(|i| u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap()))
        .collect();
    xxtea_decipher(&mut v);
    let mut result = data.to_vec();
    for (i, val) in v.iter().enumerate() {
        result[i * 4..i * 4 + 4].copy_from_slice(&val.to_le_bytes());
    }
    result
}

#[cfg(test)]
fn sha1_hex(bytes: &[u8]) -> String {
    sha1_hex_cancellable(bytes, &AtomicBool::new(false)).unwrap()
}
fn sha1_hex_cancellable(bytes: &[u8], cancel: &AtomicBool) -> Result<String, String> {
    let mut hasher = Sha1::new();
    for chunk in bytes.chunks(65536) {
        cancellation::check(cancel)?;
        hasher.update(chunk);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

struct StageRecord {
    image_index: i32,
    sound_index: i32,
    ok_li_offset: i32,
    ok_num_options: i32,
    ok_selected: i32,
    home_li_offset: i32,
    home_num_options: i32,
    home_selected: i32,
    wheel: bool,
    ok: bool,
    home: bool,
    pause: bool,
    autoplay: bool,
}

/// Index-only document for catalogue classification. Asset names remain locators;
/// no media conversion or generated pack is involved.
///
/// The node layout read here (offsets 0..42 of each `ni` record, `li` option
/// tables, `si` names) is the one the importer decodes in the FS conversion
/// above (`StageRecord`, "Parse stage nodes"). Keep both in step: a layout fix
/// there must be mirrored here. Unlike the importer, a reused `li` offset with
/// a different option count makes the pack unclassifiable instead of keeping
/// the first count. A change of result here requires a new
/// `LISTENING_VERSION` (`services/catalogue/analyze/listening.rs`).
pub(crate) fn listening_document(
    ni: &[u8],
    ri: &[u8],
    si: &[u8],
    li: &[u8],
    structural: FsPackVariant,
    cleartext: bool,
) -> Option<(StoryDocument, FsPackVariant)> {
    // Work bound for an untrusted index: the preview's stage limit, and a
    // bounded number of option links in total (one lookup each).
    const MAX_STAGES: usize = 20_000;
    const MAX_LINKS: usize = 1_000_000;
    let header = index_header(ni).ok()?;
    if header.stage_count > MAX_STAGES {
        return None;
    }
    let mut links = 0usize;
    let mut action_index: HashMap<usize, usize> = HashMap::new();
    let variant = resolve_fs_pack_index_variant(structural, cleartext, &[ri, si]).ok()?;
    let si = variant.decode(si);
    let li = variant.decode(li);
    let mut stages = Vec::new();
    let mut actions = Vec::new();
    for i in 0..header.stage_count {
        let d = ni.get(512 + i * header.node_size..512 + (i + 1) * header.node_size)?;
        let number = |offset| -> Option<i32> {
            Some(i32::from_le_bytes(
                d.get(offset..offset + 4)?.try_into().ok()?,
            ))
        };
        let sound = number(4)?;
        let audio = if sound < 0 {
            None
        } else {
            let start = (sound as usize).checked_mul(12)?;
            let name = std::str::from_utf8(si.get(start..start + 12)?)
                .ok()?
                .trim_matches('\0')
                .replace('\\', "/");
            if name
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
                || name.contains(':')
            {
                return None;
            }
            Some(format!(
                "sf/{name}{}",
                if variant == FsPackVariant::Plain && Path::new(&name).extension().is_none() {
                    ".mp3"
                } else {
                    ""
                }
            ))
        };
        let offset = number(8)?;
        let transition = if offset == -1 {
            serde_json::Value::Null
        } else {
            let count = usize::try_from(number(12)?).ok()?;
            let offset = usize::try_from(offset).ok()?;
            links = links.checked_add(count)?;
            if count == 0 || count > header.stage_count || links > MAX_LINKS {
                return None;
            }
            let mut targets = Vec::new();
            for j in 0..count {
                let at = (offset + j).checked_mul(4)?;
                let target = u32::from_le_bytes(li.get(at..at + 4)?.try_into().ok()?) as usize;
                if target >= header.stage_count {
                    return None;
                }
                targets.push(target.to_string());
            }
            // Preserve shared router identity by native link offset.
            let action = format!("li-{offset}");
            let value = serde_json::json!({"id":action,"options":targets});
            if let Some(&known) = action_index.get(&offset) {
                if actions[known] != value {
                    return None;
                }
            } else {
                action_index.insert(offset, actions.len());
                actions.push(value);
            }
            let selection = native_option_selection(number(16)?, i, "ok").ok()?;
            serde_json::json!({"actionNode":action,"optionIndex":selection})
        };
        let flag = |at| u16::from_le_bytes([d[at], d[at + 1]]) != 0;
        stages.push(serde_json::json!({"uuid":i.to_string(),"squareOne":i==0,"audio":audio,
            "okTransition":transition,"controlSettings":{"wheel":flag(32),"ok":flag(34),"home":flag(36),"pause":flag(38),"autoplay":flag(40)}}));
    }
    let doc =
        serde_json::from_value(serde_json::json!({"stageNodes":stages,"actionNodes":actions}))
            .ok()?;
    Some((doc, variant))
}

fn read_asset(
    index_data: &[u8],
    asset_folder: &Path,
    index: i32,
    variant: FsPackVariant,
    plain_extension: &str,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if index < 0 {
        return Err({
            let _msg_index = (index).to_string();
            user_message::UserMessage::new(codes::FILES_NEGATIVE_ASSET_INDEX)
                .param("index", user_message::transport_param(_msg_index.clone()))
                .with_detail(format!(
                    "Index asset négatif : {_msg_index}",
                    _msg_index = user_message::transport_detail(&_msg_index)
                ))
                .into_transport()
        });
    }
    let start = index as usize * 12;
    if start + 12 > index_data.len() {
        return Err({
            let _msg_index = (index).to_string();
            user_message::UserMessage::new(codes::FILES_ASSET_INDEX_OUTSIDE)
                .param("index", user_message::transport_param(_msg_index.clone()))
                .with_detail(format!(
                    "Index asset {_msg_index} hors limites",
                    _msg_index = user_message::transport_detail(&_msg_index)
                ))
                .into_transport()
        });
    }
    let name = std::str::from_utf8(&index_data[start..start + 12])
        .map_err(|e| {
            crate::support::user_message::coded_error(codes::IMPORT_UNSUPPORTED_VARIANT, {
                let _msg_e = (e).to_string();
                user_message::UserMessage::new(codes::FILES_INVALID_ASSET_NAME)
                    .param("error", user_message::transport_param(_msg_e.clone()))
                    .with_detail(format!(
                        "Nom asset invalide : {_msg_e}",
                        _msg_e = user_message::transport_detail(&_msg_e)
                    ))
                    .into_transport()
            })
        })?
        .trim_matches('\0')
        .replace('\\', "/");
    let path = resolve_asset_path(asset_folder, &name, variant, plain_extension)?;
    let raw = cancellation::read(&path, cancel).map_err(|e| {
        let _msg_path = (path.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ASSET_NOT_FOUND)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Asset introuvable {_msg_path} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_path = user_message::transport_detail(&_msg_path)
            ))
            .into_transport()
    })?;
    Ok(variant.decode(&raw))
}

fn resolve_asset_path(
    asset_folder: &Path,
    name: &str,
    variant: FsPackVariant,
    plain_extension: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(name);
    if name.is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err({
            let _msg_name = (name).to_string();
            user_message::UserMessage::new(codes::FILES_INVALID_ASSET_PATH_INDEX)
                .param("name", user_message::transport_param(_msg_name.clone()))
                .with_detail(format!(
                    "Chemin d'asset invalide dans l'index : {_msg_name}",
                    _msg_name = user_message::transport_detail(&_msg_name)
                ))
                .into_transport()
        });
    }

    let mut relative = relative.to_path_buf();
    if variant == FsPackVariant::Plain && relative.extension().is_none() {
        relative.set_extension(plain_extension);
    }
    let path = resolve_fs_path(asset_folder, relative);

    let metadata = std::fs::symlink_metadata(&path).map_err(|e| {
        let _msg_path = (path.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ASSET_NOT_FOUND)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Asset introuvable {_msg_path} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_path = user_message::transport_detail(&_msg_path)
            ))
            .into_transport()
    })?;
    if !metadata.file_type().is_file() {
        return Err({
            let _msg_path = (path.display()).to_string();
            user_message::UserMessage::new(codes::FILES_ASSET_FILE_IRREGULAR)
                .param("path", user_message::transport_param(_msg_path.clone()))
                .with_detail(format!(
                    "Asset refusé car il n'est pas un fichier régulier : {_msg_path}",
                    _msg_path = user_message::transport_detail(&_msg_path),
                ))
                .into_transport()
        });
    }

    let canonical_root = std::fs::canonicalize(asset_folder).map_err(|e| {
        let _msg_asset_folder = (asset_folder.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ASSET_FOLDER_INACCESSIBLE)
            .param(
                "assetFolder",
                user_message::transport_param(_msg_asset_folder.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Dossier d'assets inaccessible {_msg_asset_folder} : {_msg_error}",
                _msg_asset_folder = user_message::transport_detail(&_msg_asset_folder),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let canonical_path = std::fs::canonicalize(&path).map_err(|e| {
        let _msg_path = (path.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ASSET_INACCESSIBLE)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Asset inaccessible {_msg_path} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_path = user_message::transport_detail(&_msg_path)
            ))
            .into_transport()
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err({
            let _msg_path = (path.display()).to_string();
            user_message::UserMessage::new(codes::FILES_ASSET_PATH_OUTSIDE)
                .param("path", user_message::transport_param(_msg_path.clone()))
                .with_detail(format!(
                    "Chemin d'asset hors du dossier autorisé : {_msg_path}",
                    _msg_path = user_message::transport_detail(&_msg_path)
                ))
                .into_transport()
        });
    }
    Ok(canonical_path)
}

/// L'identité portée par le nom du dossier d'un pack filesystem : c'est le seul
/// identifiant de Stage que le format natif contient réellement, et il devient
/// l'UUID du Stage d'entrée de la projection. La frontière d'import la relit
/// pour reconstruire le contexte d'une conversion mise en cache.
/// La sélection d'option d'une transition native, décodée une seule fois.
///
/// Le champ `selected` du header FS est un entier signé 32 bits : `-1` y est la
/// même sentinelle `Random` que dans le dialecte STUdio, et Story
/// Studio la préserve — le lecteur FS historique de STUdio, lui, l'ignore, sans
/// que cela change la validité de `Random`.
///
/// Une valeur `< -1` n'est pas représentable dans le dialecte : la projection
/// s'arrête en nommant le Stage plutôt que d'émettre un `story.json` que Story
/// Studio lui-même refuserait de relire.
fn native_option_selection(
    selected: i32,
    stage_index: usize,
    trigger: &str,
) -> Result<OptionSelection, String> {
    OptionSelection::from_dialect_index(i64::from(selected)).map_err(|error| {
        {
            let _msg_trigger = (trigger).to_string();
            let _msg_stage_index_1 = (stage_index + 1).to_string();
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_FS_OPTION_INDEX_INVALID,
            )
                .param("trigger", user_message::transport_param(_msg_trigger.clone()))
                .param(
                    "stageNumber",
                    user_message::transport_param(_msg_stage_index_1.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Pack natif illisible : la transition {_msg_trigger} du stage {_msg_stage_index_1} porte un index d'option hors dialecte ({_msg_error}).",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_stage_index_1 = user_message::transport_detail(&_msg_stage_index_1),
                    _msg_trigger = user_message::transport_detail(&_msg_trigger),
                ))
                .into_transport()
            }
    })
}

pub(crate) fn fs_pack_directory_identity(pack_dir: &Path) -> String {
    let dir_name = pack_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    dir_name.split('.').next().unwrap_or(dir_name).to_string()
}

#[cfg(test)]
pub fn read_fs_pack_to_studio_zip(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
) -> Result<(), String> {
    read_fs_pack_to_studio_zip_observed(pack_dir, output_zip, fallback_title, &mut NoopObserver)
        .map(|_| ())
}

/// Variante instrumentée de la conversion. `observer` reçoit les valeurs que le
/// lecteur normalise ou abandonne ; la production passe `NoopObserver`,
/// dont toutes les méthodes sont vides, et le comportement reste identique.
#[cfg(test)]
pub(crate) fn read_fs_pack_to_studio_zip_observed<O: FsPackObserver>(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
    observer: &mut O,
) -> Result<StoryDocumentContext, String> {
    read_fs_pack_to_studio_zip_observed_cancellable(
        pack_dir,
        output_zip,
        fallback_title,
        observer,
        &AtomicBool::new(false),
    )
}
pub(crate) fn read_fs_pack_to_studio_zip_cancellable(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let result = read_fs_pack_to_studio_zip_observed_cancellable(
        pack_dir,
        output_zip,
        fallback_title,
        &mut NoopObserver,
        cancel,
    );
    cancellation::check(cancel)?;
    result.map(|_| ())
}
fn read_fs_pack_to_studio_zip_observed_cancellable<O: FsPackObserver>(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
    observer: &mut O,
    cancel: &AtomicBool,
) -> Result<StoryDocumentContext, String> {
    read_fs_pack_with_variant(
        pack_dir,
        output_zip,
        fallback_title,
        observer,
        cancel,
        FsReadOptions::default(),
    )
}

/// Explicit plain-device re-reading for locally staged output. It uses exactly
/// the same parser, with no heuristic and no extra marker in the output folder.
#[allow(dead_code)] // Headless plain staging API, consumed by the future device driver.
pub(crate) fn read_cleartext_fs_pack_to_studio_zip(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    read_fs_pack_with_variant(
        pack_dir,
        output_zip,
        fallback_title,
        &mut NoopObserver,
        cancel,
        FsReadOptions {
            variant: Some(FsPackVariant::Cleartext),
            ..Default::default()
        },
    )
    .map(|_| ())
}

/// Device acquisition uses the same graph reader, with a read-only D23 cover.
pub(crate) fn read_repatriated_fs_pack_to_studio_zip(
    pack_dir: &Path,
    output_zip: &Path,
    title: &str,
    cover: Option<&[u8]>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    read_fs_pack_with_variant(
        pack_dir,
        output_zip,
        title,
        &mut NoopObserver,
        cancel,
        FsReadOptions {
            variant: Some(FsPackVariant::Cleartext),
            cover,
            preserve_assets: true,
            media_already_decrypted: true,
        },
    )
    .map(|_| ())
}

#[derive(Default)]
struct FsReadOptions<'a> {
    variant: Option<FsPackVariant>,
    cover: Option<&'a [u8]>,
    preserve_assets: bool,
    // Repatriation already decrypted the files and validated their indexes.
    // Media signatures are key-detection probes, not acquisition requirements.
    media_already_decrypted: bool,
}
fn read_fs_pack_with_variant<O: FsPackObserver>(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
    observer: &mut O,
    cancel: &AtomicBool,
    options: FsReadOptions<'_>,
) -> Result<StoryDocumentContext, String> {
    cancellation::check(cancel)?;
    let pack_uuid = fs_pack_directory_identity(pack_dir);
    let night_mode = resolve_fs_path(pack_dir, "nm").exists();

    let variant = detect_fs_pack_variant(pack_dir).ok_or_else(|| {
        let _msg_pack_dir = (pack_dir.display()).to_string();
        user_message::UserMessage::new(codes::IMPORT_FS_FOLDER_UNRECOGNIZED)
            .param(
                "packDir",
                user_message::transport_param(_msg_pack_dir.clone()),
            )
            .with_detail(format!(
                "Dossier de pack filesystem non reconnu : {_msg_pack_dir}",
                _msg_pack_dir = user_message::transport_detail(&_msg_pack_dir)
            ))
            .into_transport()
    })?;

    let read_index = |name: &str| {
        let index_name = variant.index_name(name);
        cancellation::read(&resolve_fs_path(pack_dir, &index_name), cancel).map_err(|e| {
            let _msg_index_name = (index_name).to_string();
            let _msg_e = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_FS_INDEX_READ_FAILED)
                .param(
                    "indexName",
                    user_message::transport_param(_msg_index_name.clone()),
                )
                .param("error", user_message::transport_param(_msg_e.clone()))
                .with_detail(format!(
                    "Impossible de lire {_msg_index_name} : {_msg_e}",
                    _msg_e = user_message::transport_detail(&_msg_e),
                    _msg_index_name = user_message::transport_detail(&_msg_index_name)
                ))
                .into_transport()
        })
    };
    let ri = read_index("ri")?;
    let si = read_index("si")?;
    let li = read_index("li")?;
    let variant = match options.variant {
        Some(variant) => variant,
        None => resolve_fs_pack_index_variant(
            variant,
            has_fs_pack_cleartext_marker(pack_dir),
            &[&ri, &si],
        )
        .map_err(|FsPackUnknownKey| fs_pack_unknown_key_message())?,
    };
    let (ri, si, li) = (
        variant.decode(&ri),
        variant.decode(&si),
        variant.decode(&li),
    );

    let ni = cancellation::read(&resolve_fs_path(pack_dir, "ni"), cancel).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_NI_READ_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lire ni : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let IndexHeader {
        version,
        node_size,
        stage_count,
        factory_disabled,
    } = index_header(&ni)?;

    observer.on_pack_header(&pack_uuid, stage_count, node_size);

    // Parse stage nodes (start at offset 512 in ni)
    let mut stages: Vec<StageRecord> = Vec::with_capacity(stage_count);
    let mut stage_uuids: Vec<String> = Vec::with_capacity(stage_count);

    for i in 0..stage_count {
        cancellation::check(cancel)?;
        let off = 512 + i * node_size;
        if off + node_size > ni.len() {
            return Err({
                let _msg_i = (i).to_string();
                user_message::UserMessage::new(codes::FILES_NI_TRUNCATED_AT_NODE)
                    .param("index", user_message::transport_param(_msg_i.clone()))
                    .with_detail(format!(
                        "ni tronqué au nœud {_msg_i}",
                        _msg_i = user_message::transport_detail(&_msg_i)
                    ))
                    .into_transport()
            });
        }
        let d = &ni[off..off + node_size];
        // Les cinq contrôles sont lus une seule fois en brut. `valeur != 0` est
        // strictement équivalent à l'ancienne lecture signée ; l'observateur mesure
        // ce que la conversion en booléen efface.
        let raw_controls = RawControls {
            wheel: u16::from_le_bytes([d[32], d[33]]),
            ok: u16::from_le_bytes([d[34], d[35]]),
            home: u16::from_le_bytes([d[36], d[37]]),
            pause: u16::from_le_bytes([d[38], d[39]]),
            autoplay: u16::from_le_bytes([d[40], d[41]]),
        };
        observer.on_stage_controls(i, raw_controls);
        stages.push(StageRecord {
            image_index: i32::from_le_bytes([d[0], d[1], d[2], d[3]]),
            sound_index: i32::from_le_bytes([d[4], d[5], d[6], d[7]]),
            ok_li_offset: i32::from_le_bytes([d[8], d[9], d[10], d[11]]),
            ok_num_options: i32::from_le_bytes([d[12], d[13], d[14], d[15]]),
            ok_selected: i32::from_le_bytes([d[16], d[17], d[18], d[19]]),
            home_li_offset: i32::from_le_bytes([d[20], d[21], d[22], d[23]]),
            home_num_options: i32::from_le_bytes([d[24], d[25], d[26], d[27]]),
            home_selected: i32::from_le_bytes([d[28], d[29], d[30], d[31]]),
            wheel: raw_controls.wheel != 0,
            ok: raw_controls.ok != 0,
            home: raw_controls.home != 0,
            pause: raw_controls.pause != 0,
            autoplay: raw_controls.autoplay != 0,
        });
        let stage_uuid = if i == 0 {
            pack_uuid.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        observer.on_stage_id(i, &stage_uuid);
        stage_uuids.push(stage_uuid);
    }

    if stages.is_empty() {
        return Err(
            user_message::UserMessage::new(codes::FILES_FS_PACK_EMPTY_STAGES)
                .with_detail("Pack FS vide ou sans stages.".to_string())
                .into_transport(),
        );
    }

    // li as int32 array
    let li_ints: Vec<i32> = li
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| i32::from_le_bytes(*chunk))
        .collect();
    observer.on_link_table(&li_ints, stages.len());

    // Discover action nodes in stage iteration order (mirrors Java LinkedHashMap behaviour)
    let mut action_order: Vec<(i32, i32)> = Vec::new(); // (li_offset, num_options)
    let mut action_offset_to_idx: HashMap<(i32, i32), usize> = HashMap::new();
    let mut first_action_counts = HashMap::new();
    for (stage_index, stage) in stages.iter().enumerate() {
        for (trigger, li_off, num_opt) in [
            (Trigger::Ok, stage.ok_li_offset, stage.ok_num_options),
            (Trigger::Home, stage.home_li_offset, stage.home_num_options),
        ] {
            if li_off == -1 {
                continue;
            }
            // A native transition selects a slice (offset, length). Two
            // different lengths at one offset are distinct actions, otherwise
            // reconstruction silently adds/drops wheel options.
            if let Some(first_count) = first_action_counts.get(&li_off) {
                observer.on_action_offset_reuse(ActionOffsetReuse {
                    li_offset: li_off,
                    first_option_count: *first_count,
                    reused_option_count: num_opt,
                    stage_index,
                    trigger,
                });
            }
            first_action_counts.entry(li_off).or_insert(num_opt);
            if let std::collections::hash_map::Entry::Vacant(entry) =
                action_offset_to_idx.entry((li_off, num_opt))
            {
                entry.insert(action_order.len());
                action_order.push((li_off, num_opt));
            }
        }
    }

    let rf_dir = resolve_fs_path(pack_dir, "rf");
    let sf_dir = resolve_fs_path(pack_dir, "sf");
    let mut assets: HashMap<String, Vec<u8>> = HashMap::new();

    // Build action nodes
    let mut action_nodes: Vec<ActionNode> = Vec::new();
    for (action_idx, (li_off, num_opt)) in action_order.iter().enumerate() {
        let li_start = *li_off as usize;
        let count = (*num_opt).max(0) as usize;
        let options: Vec<String> = (0..count)
            .filter_map(|j| {
                let li_slot = li_ints.get(li_start + j).copied();
                let resolved = li_slot.and_then(|stage_idx| {
                    let index = stage_idx as usize;
                    stage_uuids.get(index).map(|uuid| (index, uuid))
                });
                observer.on_option_slot(OptionSlot {
                    action_index: action_idx,
                    li_offset: *li_off,
                    option_position: j,
                    li_slot,
                    resolved_stage_index: resolved.map(|(index, _)| index),
                });
                resolved.map(|(_, uuid)| uuid.clone())
            })
            .collect();
        action_nodes.push(ActionNode {
            id: format!("action-{}", action_idx + 1),
            name: Presence::Value(format!("Action {}", action_idx + 1)),
            // Un pack FS natif ne porte ni `type` ni `groupId` : la projection
            // n'en invente pas.
            group_id: Presence::Absent,
            // Un slot `li` non résolu reste écarté du document.
            options: named_option_targets(options),
            action_type: Presence::Absent,
            // Aucune position d'auteur : la disposition synthétisée par la
            // projection appartient à l'état d'éditeur du contexte, qui la
            // reconstruit avec `projected_action_position`.
            position: Presence::Absent,
        });
    }

    // Build stage nodes
    let mut stage_nodes: Vec<StageNode> = Vec::new();
    let square_one_uuid = stage_uuids[0].clone();

    // An index judged clear does not prove the media are: the first image and
    // the first sound of a `Cleartext` pack must carry a media signature, so
    // that media enciphered with another key fail instead of a broken pack.
    let cleartext = variant == FsPackVariant::Cleartext;
    let checked = !cleartext || options.media_already_decrypted;
    let (mut image_checked, mut audio_checked) = (checked, checked);
    for (stage_idx, (stage, stage_uuid)) in stages.iter().zip(stage_uuids.iter()).enumerate() {
        cancellation::check(cancel)?;
        let audio_name: Option<String> = if stage.sound_index >= 0 {
            let bytes = read_asset(&si, &sf_dir, stage.sound_index, variant, "mp3", cancel)
                .map_err(|e| {
                    crate::support::user_message::contextual_error(
                        &format!("Audio stage {stage_idx}"),
                        e,
                    )
                })?;
            if !audio_checked {
                if !has_audio_signature(&bytes) {
                    return Err(fs_pack_unknown_key_message());
                }
                audio_checked = true;
            }
            let name = sha1_hex_cancellable(&bytes, cancel)? + ".mp3";
            assets.entry(name.clone()).or_insert(bytes);
            Some(name)
        } else {
            None
        };

        let image_name: Option<String> = if stage.image_index >= 0 {
            let img_bytes = read_asset(&ri, &rf_dir, stage.image_index, variant, "bmp", cancel)
                .map_err(|e| {
                    crate::support::user_message::contextual_error(
                        &format!("Image stage {stage_idx}"),
                        e,
                    )
                })?;
            if !image_checked {
                if !img_bytes.starts_with(b"BM") {
                    return Err(fs_pack_unknown_key_message());
                }
                image_checked = true;
            }
            let name = sha1_hex_cancellable(&img_bytes, cancel)? + ".bmp";
            assets.entry(name.clone()).or_insert(img_bytes);
            Some(name)
        } else {
            None
        };

        // Les champs optionnels absents restent portés par des `Option` : la
        // sérialisation de `StageNode` les émet explicitement à `null`, forme que
        // les lecteurs tiers déréférencent sans garde (STUdio lit `image` avant de
        // tester sa nullité).
        let mut stage_node = StageNode {
            uuid: stage_uuid.clone(),
            name: Presence::Value(format!("Stage {}", stage_idx + 1)),
            stage_type: Presence::Value(STAGE_TYPE_FALLBACK.to_string()),
            square_one: Presence::Value(*stage_uuid == square_one_uuid),
            group_id: Presence::Absent,
            audio: Presence::from_nullable(audio_name),
            image: Presence::from_nullable(image_name),
            control_settings: Presence::Value(ControlSettings::authored(
                stage.wheel,
                stage.ok,
                stage.home,
                stage.pause,
                stage.autoplay,
            )),
            home_transition: Presence::Null,
            ok_transition: Presence::Null,
            // Même statut que la position des Actions ci-dessus.
            position: Presence::Absent,
        };

        if stage.ok_li_offset != -1 {
            let a_idx = action_offset_to_idx[&(stage.ok_li_offset, stage.ok_num_options)];
            observer.on_native_transition(NativeTransition {
                stage_index: stage_idx,
                trigger: Trigger::Ok,
                li_offset: stage.ok_li_offset,
                option_count: stage.ok_num_options,
                selected: stage.ok_selected,
                action_index: a_idx,
            });
            stage_node.ok_transition = Presence::Value(Transition {
                action_node: format!("action-{}", a_idx + 1),
                selection: native_option_selection(stage.ok_selected, stage_idx, "ok")?,
            });
        }
        if stage.home_li_offset != -1 {
            let a_idx = action_offset_to_idx[&(stage.home_li_offset, stage.home_num_options)];
            observer.on_native_transition(NativeTransition {
                stage_index: stage_idx,
                trigger: Trigger::Home,
                li_offset: stage.home_li_offset,
                option_count: stage.home_num_options,
                selected: stage.home_selected,
                action_index: a_idx,
            });
            stage_node.home_transition = Presence::Value(Transition {
                action_node: format!("action-{}", a_idx + 1),
                selection: native_option_selection(stage.home_selected, stage_idx, "home")?,
            });
        }
        stage_nodes.push(stage_node);
    }

    // Device acquisition keeps unused indexed media too. Ordinary imports
    // retain their established policy of copying only referenced assets.
    if options.preserve_assets {
        for (index, directory, extension) in [(&ri, &rf_dir, "bmp"), (&si, &sf_dir, "mp3")] {
            for rank in 0..index.len() / 12 {
                cancellation::check(cancel)?;
                let bytes = read_asset(index, directory, rank as i32, variant, extension, cancel)?;
                let name = sha1_hex_cancellable(&bytes, cancel)? + "." + extension;
                assets.entry(name).or_insert(bytes);
            }
        }
    }
    let document = StoryDocument {
        title: Presence::Value(fallback_title.to_string()),
        version: Presence::Value(i32::from(version)),
        description: Presence::Value(String::new()),
        // Dialecte STUdio standard. Les passerelles tierces lisent `format` comme
        // `v<N>` — Lunii.QT calcule littéralement `int(format[1:])` — donc une
        // valeur maison telle que « studio-import » les arrête avant le graphe.
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(night_mode),
        // `factoryDisabled` et `uuid` sont maintenant portés par le modèle :
        // ils étaient injectés dans la `Value` après coup, donc jamais relus.
        // `factoryDisabled` est lu dans `ni` ; l'UUID d'un pack Lunii natif est
        // le nom de son dossier racine, exposé à la racine comme le font les
        // packs STUdio pour qu'il survive à la conversion puis à l'extraction.
        factory_disabled: Presence::Value(serde_json::Value::Bool(factory_disabled)),
        uuid: if classify_stage_id(&pack_uuid).bridge_compatible {
            Presence::Value(pack_uuid.clone())
        } else {
            Presence::Absent
        },
        action_nodes,
        stage_nodes,
    };

    // Le quadrillage est nécessaire à l'affichage mais ne vient pas du pack FS :
    // le contexte le porte comme état d'éditeur `projection-derived` et le
    // document d'auteur ne le voit jamais.
    let context = StoryDocumentContext::imported_fs(&document, &pack_uuid);

    // Sérialiser le document plutôt qu'un objet ad hoc garantit que le dialecte
    // d'import suit `StoryDocument`.
    let story_json = serde_json::to_value(&document).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_FS_STORY_ENCODE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Sérialisation du story.json impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let identity = crate::native_pack::output_identity::for_story(
        &story_json,
        crate::native_pack::output_identity::OutputForm::Rewritten,
        None,
    )
    .map_err(user_message::UserMessage::into_transport)?;

    // Write output ZIP
    if let Some(parent) = output_zip.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_FS_OUTPUT_CREATE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de créer le répertoire de sortie : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
    }
    let file = std::fs::File::create(output_zip).map_err(|e| {
        let _msg_output_zip = (output_zip.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_FS_ARCHIVE_CREATE_FAILED)
            .param(
                "outputZip",
                user_message::transport_param(_msg_output_zip.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de créer {_msg_output_zip} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_output_zip = user_message::transport_detail(&_msg_output_zip)
            ))
            .into_transport()
    })?;
    let mut writer = zip::ZipWriter::new(cancellation::Writer {
        inner: file,
        cancel,
        stage: "zipWrite",
    });
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let text = serde_json::to_string_pretty(&story_json).map_err(|e| {
        user_message::UserMessage::new(codes::IMPORT_FS_JSON_ENCODE_FAILED)
            .param("error", e.to_string())
            .into_transport()
    })?;
    let story_bytes = identity.serialize(&text)?;
    writer.start_file("story.json", opts).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ZIP_STORY_JSON)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "ZIP story.json : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    story_bytes.copy_to(&mut writer, cancel).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_WRITING_STORY_JSON)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Écriture story.json : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    if let Some(cover) = options.cover {
        writer
            .start_file("thumbnail.png", opts)
            .map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut writer, cover).map_err(|e| e.to_string())?;
    }
    for (name, bytes) in &assets {
        writer
            .start_file(format!("assets/{}", name), opts)
            .map_err(|e| {
                let _msg_name = (name).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::FILES_ZIP_ASSET)
                    .param("name", user_message::transport_param(_msg_name.clone()))
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "ZIP asset {_msg_name} : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_name = user_message::transport_detail(&_msg_name)
                    ))
                    .into_transport()
            })?;
        cancellation::copy(&mut std::io::Cursor::new(bytes), &mut writer, cancel).map_err(|e| {
            let _msg_name = (name).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::FILES_WRITING_ASSET)
                .param("name", user_message::transport_param(_msg_name.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Écriture asset {_msg_name} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_name = user_message::transport_detail(&_msg_name)
                ))
                .into_transport()
        })?;
    }

    writer.finish().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_FINALIZING_ZIP)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Finalisation ZIP : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    Ok(context)
}

struct IndexHeader {
    version: i16,
    node_size: usize,
    stage_count: usize,
    factory_disabled: bool,
}
fn index_header(ni: &[u8]) -> Result<IndexHeader, String> {
    if ni.len() < 512 {
        return Err({
            let _msg_ni = (ni.len()).to_string();
            user_message::UserMessage::new(codes::IMPORT_FS_INDEX_TOO_SHORT)
                .param("byteCount", user_message::transport_param(_msg_ni.clone()))
                .with_detail(format!(
                    "Fichier ni trop court : {_msg_ni} octets",
                    _msg_ni = user_message::transport_detail(&_msg_ni)
                ))
                .into_transport()
        });
    }

    // ni header (little-endian)
    let version = i16::from_le_bytes([ni[2], ni[3]]);
    let node_size = u32::from_le_bytes([ni[8], ni[9], ni[10], ni[11]]) as usize;
    let stage_count = u32::from_le_bytes([ni[12], ni[13], ni[14], ni[15]]) as usize;
    let factory_disabled = ni[24] != 0;

    if node_size < 42 {
        return Err({
            let _msg_node_size = (node_size).to_string();
            user_message::UserMessage::new(codes::FILES_INVALID_NODESIZE)
                .param(
                    "nodeSize",
                    user_message::transport_param(_msg_node_size.clone()),
                )
                .with_detail(format!(
                    "nodeSize invalide : {_msg_node_size}",
                    _msg_node_size = user_message::transport_detail(&_msg_node_size)
                ))
                .into_transport()
        });
    }

    Ok(IndexHeader {
        version,
        node_size,
        stage_count,
        factory_disabled,
    })
}
/// Why a catalogue preview could not be produced. The catalogue maps these to
/// its own motifs; `Read` carries the transported reader message as detail.
#[derive(Debug)]
pub(crate) enum FsPreviewError {
    InvalidStructure,
    ReadLimitExceeded,
    /// Indexes unreadable both in clear and with the common key.
    UnknownKey,
    Read(String),
}

impl FsPreviewError {
    pub(crate) fn into_reason(self) -> String {
        match self {
            Self::InvalidStructure => "invalidPackStructure".into(),
            Self::ReadLimitExceeded => "readLimitExceeded".into(),
            Self::UnknownKey => fs_pack_unknown_key_message(),
            Self::Read(detail) => detail,
        }
    }
}

impl From<std::io::Error> for FsPreviewError {
    fn from(error: std::io::Error) -> Self {
        Self::Read(error.to_string())
    }
}

/// Catalogue metadata only: index header and first image locator, never media
/// conversion. The common index decoder and path confinement remain authoritative.
pub(crate) fn read_fs_pack_preview(pack_dir: &Path) -> Result<serde_json::Value, FsPreviewError> {
    use std::io::Read;
    let variant = detect_fs_pack_variant(pack_dir).ok_or(FsPreviewError::InvalidStructure)?;
    let file = std::fs::File::open(resolve_fs_path(pack_dir, "ni"))?;
    let byte_size = file.metadata()?.len();
    let mut ni = Vec::new();
    file.take(516).read_to_end(&mut ni)?;
    fs_pack_preview_with(
        variant,
        has_fs_pack_cleartext_marker(pack_dir),
        &ni,
        byte_size,
        |name, limit| {
            let mut bytes = Vec::new();
            std::fs::File::open(resolve_fs_path(pack_dir, name))?
                .take(limit + 1)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        },
        |name, variant| {
            resolve_asset_path(&resolve_fs_path(pack_dir, "rf"), name, variant, "bmp")
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        },
    )
}

/// Reads only the first node and the bounded image index through a caller's
/// storage adapter. Asset existence and confinement belong to that adapter.
pub(crate) fn fs_pack_preview_with(
    variant: FsPackVariant,
    cleartext_marker: bool,
    ni: &[u8],
    byte_size: u64,
    mut read: impl FnMut(&str, u64) -> Result<Vec<u8>, FsPreviewError>,
    asset: impl Fn(&str, FsPackVariant) -> Option<String>,
) -> Result<serde_json::Value, FsPreviewError> {
    const INDEX_LIMIT: u64 = 1024 * 1024;
    let header = index_header(ni).map_err(FsPreviewError::Read)?;
    let declared = (header.stage_count as u64).saturating_mul(header.node_size as u64);
    if header.stage_count > 20_000 || 512u64.saturating_add(declared) > byte_size {
        return Err(FsPreviewError::InvalidStructure);
    }
    let mut read_index = |name: &str| {
        let bytes = read(&variant.index_name(name), INDEX_LIMIT)?;
        if bytes.len() as u64 > INDEX_LIMIT {
            return Err(FsPreviewError::ReadLimitExceeded);
        }
        Ok(bytes)
    };
    let image = (header.stage_count > 0 && ni.len() >= 516)
        .then(|| i32::from_le_bytes([ni[512], ni[513], ni[514], ni[515]]))
        .filter(|image| *image >= 0);
    // Suffix-less indexes are always sampled: the same content rule as the
    // conversion tells a clear pack from an enciphered one, or an unknown key.
    let (variant, ri) = if variant == FsPackVariant::Plain {
        (variant, image.map(|_| read_index("ri")).transpose()?)
    } else {
        let ri = read_index("ri")?;
        let si = if index_names_readable(&ri).is_none() {
            read_index("si")?
        } else {
            Vec::new()
        };
        let resolved = resolve_fs_pack_index_variant(variant, cleartext_marker, &[&ri, &si])
            .map_err(|FsPackUnknownKey| FsPreviewError::UnknownKey)?;
        (resolved, Some(ri))
    };
    let mut cover = None;
    if let (Some(image), Some(bytes)) = (image, ri) {
        let index = variant.decode(&bytes);
        let offset = image as usize * 12;
        if let Some(raw) = index.get(offset..offset + 12) {
            let name = std::str::from_utf8(raw)
                .map_err(|_| FsPreviewError::InvalidStructure)?
                .trim_matches('\0')
                .replace('\\', "/");
            cover = asset(&name, variant);
        }
    }
    Ok(serde_json::json!({
        "version": header.version,
        "variant": variant.preview_name(),
        "cover": cover,
    }))
}

/// Fixtures de pack filesystem partagées par les tests du lecteur et par ceux
/// de la frontière d'import, qui doivent convertir le même pack pour vérifier
/// que son contexte survit à la conversion et à sa mise en cache.
#[cfg(test)]
pub(crate) mod fs_fixtures {
    use std::fs;
    use std::path::Path;

    // Nom du dossier de pack : c'est lui qui devient l'UUID racine et l'UUID du
    // stage d'entrée.
    pub(crate) const DIALECT_PACK_UUID: &str = "3f2c1d80-6a4b-4f0e-9c17-2b8d5e7a1c42";

    /// Encode un nœud `ni` de 44 octets dans l'ordre lu par la conversion.
    fn push_stage_node(
        ni: &mut Vec<u8>,
        image_index: i32,
        sound_index: i32,
        ok: (i32, i32, i32),
        home: (i32, i32, i32),
        controls: [u16; 5],
    ) {
        let mut node = [0_u8; 44];
        node[0..4].copy_from_slice(&image_index.to_le_bytes());
        node[4..8].copy_from_slice(&sound_index.to_le_bytes());
        node[8..12].copy_from_slice(&ok.0.to_le_bytes());
        node[12..16].copy_from_slice(&ok.1.to_le_bytes());
        node[16..20].copy_from_slice(&ok.2.to_le_bytes());
        node[20..24].copy_from_slice(&home.0.to_le_bytes());
        node[24..28].copy_from_slice(&home.1.to_le_bytes());
        node[28..32].copy_from_slice(&home.2.to_le_bytes());
        for (slot, value) in controls.iter().enumerate() {
            let offset = 32 + slot * 2;
            node[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        }
        ni.extend_from_slice(&node);
    }

    /// Pack filesystem couvrant tout ce que le dialecte doit rendre explicite :
    /// un stage d'entrée complet, un stage sans image, un stage sans audio, une
    /// transition OK absente, une transition HOME absente, un stage non
    /// `squareOne`, et un cycle `stage 1 → stage 2 → stage 1` refermé par le
    /// retour de `action-2` sur le stage d'entrée.
    pub(crate) fn write_dialect_fixture_pack(pack_dir: &Path) {
        fs::create_dir_all(pack_dir.join("rf/000")).expect("create image directory");
        fs::create_dir_all(pack_dir.join("sf/000")).expect("create audio directory");

        let mut ni = vec![0_u8; 512];
        ni[2..4].copy_from_slice(&1_i16.to_le_bytes());
        ni[8..12].copy_from_slice(&44_u32.to_le_bytes());
        ni[12..16].copy_from_slice(&3_u32.to_le_bytes());
        ni[24] = 1; // factoryDisabled
        push_stage_node(&mut ni, 0, 0, (0, 2, 0), (-1, -1, -1), [1, 1, 0, 0, 0]);
        push_stage_node(&mut ni, -1, 1, (2, 1, 0), (0, 2, 1), [1, 1, 1, 0, 0]);
        push_stage_node(&mut ni, 1, -1, (-1, -1, -1), (-1, -1, -1), [0, 0, 0, 0, 1]);
        fs::write(pack_dir.join("ni"), ni).expect("write node index");

        fs::write(pack_dir.join("ri.plain"), b"000\\IMAGE001000\\IMAGE002")
            .expect("write image index");
        fs::write(pack_dir.join("si.plain"), b"000\\SOUND001000\\SOUND002")
            .expect("write audio index");
        let li: Vec<u8> = [1_i32, 2, 0]
            .iter()
            .flat_map(|slot| slot.to_le_bytes())
            .collect();
        fs::write(pack_dir.join("li.plain"), li).expect("write link index");
        fs::write(pack_dir.join("nm"), []).expect("write night mode marker");

        fs::write(pack_dir.join("rf/000/IMAGE001.bmp"), b"BMentry-image").expect("write image 1");
        fs::write(pack_dir.join("rf/000/IMAGE002.bmp"), b"BMleaf-image").expect("write image 2");
        fs::write(pack_dir.join("sf/000/SOUND001.mp3"), b"ID3entry-audio").expect("write audio 1");
        fs::write(pack_dir.join("sf/000/SOUND002.mp3"), b"ID3menu-audio").expect("write audio 2");
    }

    /// Test-only inverse of `decipher_common_key`: an encrypted fixture can
    /// only be produced by enciphering, never by the decoder under test.
    pub(crate) fn encipher_common_key(data: &[u8]) -> Vec<u8> {
        let n = (data.len() / 4).min(128);
        if n < 2 {
            return data.to_vec();
        }
        let mut v: Vec<u32> = (0..n)
            .map(|i| u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap()))
            .collect();
        let k = super::xxtea_key();
        const DELTA: u32 = 0x9e3779b9;
        let rounds = 1u32 + 52 / n as u32;
        let mut sum = 0u32;
        let mut z = v[n - 1];
        for _ in 0..rounds {
            sum = sum.wrapping_add(DELTA);
            let e = ((sum >> 2) & 3) as usize;
            for p in 0..n {
                let y = v[(p + 1) % n];
                v[p] = v[p].wrapping_add(super::xxtea_mx(&k, e, p, y, z, sum));
                z = v[p];
            }
        }
        let mut result = data.to_vec();
        for (i, val) in v.iter().enumerate() {
            result[i * 4..i * 4 + 4].copy_from_slice(&val.to_le_bytes());
        }
        result
    }

    /// Image and sound of [`write_cleartext_pack`], long enough (more than
    /// two 32-bit words) for a wrong common-key deciphering to alter them.
    pub(crate) const CLEARTEXT_IMAGE: &[u8] = b"BMcleartext-image";
    pub(crate) const CLEARTEXT_AUDIO: &[u8] = b"ID3cleartext-audio";

    /// First bytes of the `ri` of a pack enciphered with a device key, as
    /// found in a real collection: opaque both in clear and once deciphered
    /// with the common key.
    pub(crate) const UNKNOWN_KEY_INDEX: [u8; 24] = [
        0x9c, 0x49, 0x75, 0xaa, 0x3c, 0x59, 0x73, 0x0f, 0xa9, 0x54, 0x7d, 0x61, 0xf0, 0xe7, 0xa3,
        0xcf, 0x6f, 0x9c, 0xdd, 0xff, 0xba, 0x1a, 0x1f, 0xd7,
    ];

    fn write_single_stage_ni(pack_dir: &Path) {
        let mut ni = vec![0_u8; 512];
        ni[2..4].copy_from_slice(&1_i16.to_le_bytes());
        ni[8..12].copy_from_slice(&44_u32.to_le_bytes());
        ni[12..16].copy_from_slice(&1_u32.to_le_bytes());
        push_stage_node(&mut ni, 0, 0, (-1, -1, -1), (-1, -1, -1), [1, 1, 0, 0, 0]);
        fs::write(pack_dir.join("ni"), ni).expect("write node index");
    }

    /// Device pack in the layout of the `.cleartext` packs met in the wild:
    /// suffix-less indexes, extensionless assets, everything stored in clear.
    pub(crate) fn write_cleartext_pack(pack_dir: &Path, marker: bool) {
        fs::create_dir_all(pack_dir.join("rf/000")).expect("create image directory");
        fs::create_dir_all(pack_dir.join("sf/000")).expect("create audio directory");
        write_single_stage_ni(pack_dir);
        fs::write(pack_dir.join("ri"), b"000\\IMAGE001").expect("write image index");
        fs::write(pack_dir.join("si"), b"000\\SOUND001").expect("write audio index");
        fs::write(pack_dir.join("li"), []).expect("write link index");
        fs::write(pack_dir.join("rf/000/IMAGE001"), CLEARTEXT_IMAGE).expect("write image");
        fs::write(pack_dir.join("sf/000/SOUND001"), CLEARTEXT_AUDIO).expect("write audio");
        if marker {
            fs::write(pack_dir.join(".cleartext"), []).expect("write cleartext marker");
        }
    }

    /// Same layout, indexes enciphered with a key that is not the common one.
    pub(crate) fn write_unknown_key_pack(pack_dir: &Path, marker: bool) {
        write_cleartext_pack(pack_dir, marker);
        fs::write(pack_dir.join("ri"), UNKNOWN_KEY_INDEX).expect("write image index");
        fs::write(pack_dir.join("si"), UNKNOWN_KEY_INDEX).expect("write audio index");
    }

    /// Encrypted pack (indexes and assets enciphered, no `.plain` names)
    /// whose entry stage shows `cover` as its image.
    pub(crate) fn write_encrypted_cover_pack(pack_dir: &Path, cover: &[u8]) {
        fs::create_dir_all(pack_dir.join("rf/000")).expect("create image directory");
        fs::create_dir_all(pack_dir.join("sf/000")).expect("create audio directory");
        let mut ni = vec![0_u8; 512];
        ni[2..4].copy_from_slice(&1_i16.to_le_bytes());
        ni[8..12].copy_from_slice(&44_u32.to_le_bytes());
        ni[12..16].copy_from_slice(&1_u32.to_le_bytes());
        push_stage_node(&mut ni, 0, 0, (-1, -1, -1), (-1, -1, -1), [1, 1, 0, 0, 0]);
        fs::write(pack_dir.join("ni"), ni).expect("write node index");
        fs::write(pack_dir.join("ri"), encipher_common_key(b"000\\IMAGE001"))
            .expect("write image index");
        fs::write(pack_dir.join("si"), encipher_common_key(b"000\\SOUND001"))
            .expect("write audio index");
        fs::write(pack_dir.join("li"), []).expect("write link index");
        fs::write(pack_dir.join("rf/000/IMAGE001"), encipher_common_key(cover))
            .expect("write image asset");
        fs::write(
            pack_dir.join("sf/000/SOUND001"),
            encipher_common_key(b"ID3entry-audio"),
        )
        .expect("write audio asset");
    }
}

#[cfg(test)]
mod tests {
    use super::fs_fixtures::{write_dialect_fixture_pack, DIALECT_PACK_UUID};
    use super::*;
    use std::fs;
    use std::io::Read;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "story_studio_fs_pack_reader_{name}_{}_{}",
            std::process::id(),
            nonce
        ))
    }

    fn write_common_pack_shape(pack_dir: &Path) {
        fs::create_dir_all(pack_dir.join("rf/000")).expect("create image directory");
        fs::create_dir_all(pack_dir.join("sf/000")).expect("create audio directory");
        fs::write(pack_dir.join("ni"), [0_u8; 512]).expect("write node index");
    }

    fn convert_dialect_fixture(name: &str) -> (std::path::PathBuf, serde_json::Value) {
        let dir = temp_dir(name);
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let output_zip = dir.join("converted.zip");
        write_dialect_fixture_pack(&pack_dir);
        read_fs_pack_to_studio_zip(&pack_dir, &output_zip, "Pack dialecte")
            .expect("convert dialect fixture");

        let file = fs::File::open(&output_zip).expect("open converted zip");
        let mut archive = zip::ZipArchive::new(file).expect("read converted zip");
        let mut raw = String::new();
        archive
            .by_name("story.json")
            .expect("story.json entry")
            .read_to_string(&mut raw)
            .expect("read story.json");
        let story = serde_json::from_str(&raw).expect("story.json is valid JSON");
        (dir, story)
    }

    fn write_plain_pack(pack_dir: &Path) -> (Vec<u8>, Vec<u8>) {
        write_common_pack_shape(pack_dir);

        let mut ni = vec![0_u8; 512 + 44];
        ni[2..4].copy_from_slice(&1_i16.to_le_bytes());
        ni[8..12].copy_from_slice(&44_u32.to_le_bytes());
        ni[12..16].copy_from_slice(&1_u32.to_le_bytes());
        let stage = &mut ni[512..];
        stage[0..4].copy_from_slice(&0_i32.to_le_bytes());
        stage[4..8].copy_from_slice(&0_i32.to_le_bytes());
        for offset in [8, 12, 16, 20, 24, 28] {
            stage[offset..offset + 4].copy_from_slice(&(-1_i32).to_le_bytes());
        }
        fs::write(pack_dir.join("ni"), ni).expect("write node index");
        fs::write(pack_dir.join("ri.plain"), b"000\\IMAGE001").expect("write image index");
        fs::write(pack_dir.join("si.plain"), b"000\\SOUND001").expect("write audio index");
        fs::write(pack_dir.join("li.plain"), []).expect("write link index");

        let image = b"BMsynthetic-image".to_vec();
        let audio = b"ID3synthetic-audio".to_vec();
        fs::write(pack_dir.join("rf/000/IMAGE001.bmp"), &image).expect("write image asset");
        fs::write(pack_dir.join("sf/000/SOUND001.mp3"), &audio).expect("write audio asset");
        (image, audio)
    }

    #[test]
    fn fs_pack_case_resolution_is_shared_by_preview_and_directory_import() {
        fn uppercase(dir: &Path) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    uppercase(&path);
                }
                let target = path.with_file_name(
                    path.file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_ascii_uppercase(),
                );
                if path != target {
                    fs::rename(&path, &target).unwrap();
                }
            }
        }
        let dir = temp_dir("uppercase_shared_import");
        let pack = dir.join(DIALECT_PACK_UUID);
        write_dialect_fixture_pack(&pack);
        uppercase(&pack);
        assert_eq!(detect_fs_pack_variant(&pack), Some(FsPackVariant::Plain));
        let preview = read_fs_pack_preview(&pack).unwrap();
        assert_eq!(
            fs::read(preview["cover"].as_str().unwrap()).unwrap(),
            b"BMentry-image"
        );
        let converted = crate::support::imported_pack::ensure_studio_pack_zip_from_dir(
            pack.to_str().unwrap(),
            &dir.join("cache"),
        )
        .unwrap();
        let mut archive =
            zip::ZipArchive::new(fs::File::open(converted.zip_path).unwrap()).unwrap();
        let story: serde_json::Value =
            serde_json::from_reader(archive.by_name("story.json").unwrap()).unwrap();
        assert_eq!(story["uuid"], DIALECT_PACK_UUID);
        assert_eq!(story["stageNodes"][0]["uuid"], DIALECT_PACK_UUID);
        assert!(pack.join("RF/000/IMAGE001.BMP").is_file());
        let actual_names = fs::read_dir(pack.join("RF/000"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert!(actual_names.contains(&std::ffi::OsString::from("IMAGE001.BMP")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detects_complete_encrypted_and_plain_pack_shapes() {
        let dir = temp_dir("detect_variants");
        let encrypted = dir.join("encrypted");
        let plain = dir.join("plain");
        let mixed = dir.join("mixed");
        let ambiguous = dir.join("ambiguous");
        for pack_dir in [&encrypted, &plain, &mixed, &ambiguous] {
            write_common_pack_shape(pack_dir);
        }
        for name in ["ri", "si", "li"] {
            fs::write(encrypted.join(name), []).expect("write encrypted index");
            fs::write(plain.join(format!("{name}.plain")), []).expect("write plain index");
            fs::write(ambiguous.join(name), []).expect("write ambiguous encrypted index");
            fs::write(ambiguous.join(format!("{name}.plain")), [])
                .expect("write ambiguous plain index");
        }
        fs::write(mixed.join("ri.plain"), []).expect("write mixed image index");
        fs::write(mixed.join("si.plain"), []).expect("write mixed audio index");
        fs::write(mixed.join("li"), []).expect("write mixed link index");

        assert_eq!(
            detect_fs_pack_variant(&encrypted),
            Some(FsPackVariant::Encrypted)
        );
        assert_eq!(detect_fs_pack_variant(&plain), Some(FsPackVariant::Plain));
        assert_eq!(detect_fs_pack_variant(&mixed), None);
        assert_eq!(detect_fs_pack_variant(&ambiguous), None);

        fs::remove_dir_all(dir).expect("cleanup variant fixtures");
    }

    #[test]
    fn encrypted_fixture_assets_decode_to_their_original_bytes() {
        use super::fs_fixtures::{encipher_common_key, write_encrypted_cover_pack};
        let original: Vec<u8> = (0..700u32).map(|i| (i * 7 % 251) as u8).collect();
        let enciphered = encipher_common_key(&original);
        assert_ne!(enciphered[..512], original[..512]);
        assert_eq!(enciphered[512..], original[512..]);
        assert_eq!(
            decode_fs_pack_asset(FsPackVariant::Encrypted, &enciphered),
            original
        );
        assert_eq!(
            decode_fs_pack_asset(FsPackVariant::Plain, &enciphered),
            enciphered
        );

        let dir = temp_dir("encrypted_cover_preview");
        let pack_dir = dir.join("pack");
        write_encrypted_cover_pack(&pack_dir, &original);
        let preview = read_fs_pack_preview(&pack_dir).expect("preview");
        assert_eq!(preview["variant"], "encrypted");
        assert_eq!(
            FsPackVariant::from_preview_name(preview["variant"].as_str().unwrap()),
            Some(FsPackVariant::Encrypted)
        );
        let cover = preview["cover"].as_str().expect("cover path");
        assert!(cover.ends_with("IMAGE001"));
        fs::remove_dir_all(dir).expect("cleanup encrypted cover fixture");
    }

    #[test]
    fn converts_plain_pack_without_deciphering_indexes_or_assets() {
        let dir = temp_dir("plain_conversion");
        let pack_dir = dir.join("synthetic-pack");
        let output_zip = dir.join("converted.zip");
        let (image, audio) = write_plain_pack(&pack_dir);

        read_fs_pack_to_studio_zip(&pack_dir, &output_zip, "Synthetic pack")
            .expect("convert plain pack");

        let file = fs::File::open(&output_zip).expect("open converted zip");
        let mut archive = zip::ZipArchive::new(file).expect("read converted zip");
        let image_name = format!("assets/{}.bmp", sha1_hex(&image));
        let audio_name = format!("assets/{}.mp3", sha1_hex(&audio));
        let mut image_bytes = Vec::new();
        archive
            .by_name(&image_name)
            .expect("image entry")
            .read_to_end(&mut image_bytes)
            .expect("read image entry");
        let mut audio_bytes = Vec::new();
        archive
            .by_name(&audio_name)
            .expect("audio entry")
            .read_to_end(&mut audio_bytes)
            .expect("read audio entry");

        assert_eq!(image_bytes, image);
        assert_eq!(audio_bytes, audio);

        fs::remove_dir_all(dir).expect("cleanup plain fixture");
    }

    fn converted_assets(zip_path: &Path) -> Vec<Vec<u8>> {
        let mut archive =
            zip::ZipArchive::new(fs::File::open(zip_path).expect("open converted zip"))
                .expect("read converted zip");
        let mut assets = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("converted entry");
            if entry.name().starts_with("assets/") {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).expect("read asset");
                assets.push(bytes);
            }
        }
        assets
    }

    #[test]
    fn index_variant_follows_the_content_the_marker_only_orders_the_probe() {
        use super::fs_fixtures::{encipher_common_key, UNKNOWN_KEY_INDEX};
        let clear = b"000\\IMAGE001000\\IMAGE002".to_vec();
        let enciphered = encipher_common_key(&clear);
        assert_ne!(enciphered, clear);
        let resolve = |marker, samples: &[&[u8]]| {
            resolve_fs_pack_index_variant(FsPackVariant::Encrypted, marker, samples)
        };
        for marker in [false, true] {
            assert_eq!(resolve(marker, &[&clear]), Ok(FsPackVariant::Cleartext));
            // Some marked packs are enciphered all the same.
            assert_eq!(
                resolve(marker, &[&enciphered]),
                Ok(FsPackVariant::Encrypted)
            );
            assert_eq!(
                resolve(marker, &[&UNKNOWN_KEY_INDEX]),
                Err(FsPackUnknownKey)
            );
            // An empty image index defers to the sound index.
            assert_eq!(
                resolve(marker, &[&[], &enciphered]),
                Ok(FsPackVariant::Encrypted)
            );
            assert_eq!(
                resolve_fs_pack_index_variant(FsPackVariant::Plain, marker, &[&UNKNOWN_KEY_INDEX]),
                Ok(FsPackVariant::Plain)
            );
        }
        // Nothing to judge: the marker decides, the historical reading stays.
        assert_eq!(resolve(true, &[&[], &[]]), Ok(FsPackVariant::Cleartext));
        assert_eq!(resolve(false, &[&[], &[]]), Ok(FsPackVariant::Encrypted));
    }

    #[test]
    fn cleartext_pack_is_previewed_and_converted_without_deciphering() {
        use super::fs_fixtures::{write_cleartext_pack, CLEARTEXT_AUDIO, CLEARTEXT_IMAGE};
        for marker in [true, false] {
            let dir = temp_dir("cleartext_conversion");
            let pack_dir = dir.join(DIALECT_PACK_UUID);
            write_cleartext_pack(&pack_dir, marker);
            assert_eq!(
                detect_fs_pack_variant(&pack_dir),
                Some(FsPackVariant::Encrypted),
                "the structure alone cannot tell a clear pack"
            );
            let preview = read_fs_pack_preview(&pack_dir).expect("preview");
            assert_eq!(preview["variant"], "cleartext");
            assert_eq!(
                fs::read(preview["cover"].as_str().expect("cover path")).unwrap(),
                CLEARTEXT_IMAGE
            );
            let output_zip = dir.join("converted.zip");
            read_fs_pack_to_studio_zip(&pack_dir, &output_zip, "Clear pack")
                .expect("convert cleartext pack");
            let assets = converted_assets(&output_zip);
            assert!(assets.iter().any(|a| a == CLEARTEXT_IMAGE), "{marker}");
            assert!(assets.iter().any(|a| a == CLEARTEXT_AUDIO), "{marker}");
            fs::remove_dir_all(dir).expect("cleanup cleartext fixture");
        }
    }

    #[test]
    fn clear_index_with_enciphered_media_fails_instead_of_a_wrong_pack() {
        use super::fs_fixtures::{
            encipher_common_key, write_cleartext_pack, CLEARTEXT_AUDIO, CLEARTEXT_IMAGE,
        };
        for (asset, original) in [
            ("rf/000/IMAGE001", CLEARTEXT_IMAGE),
            ("sf/000/SOUND001", CLEARTEXT_AUDIO),
        ] {
            let dir = temp_dir("cleartext_enciphered_media");
            let pack_dir = dir.join(DIALECT_PACK_UUID);
            write_cleartext_pack(&pack_dir, true);
            let enciphered = encipher_common_key(original);
            assert!(!enciphered.starts_with(b"BM") && !enciphered.starts_with(b"ID3"));
            fs::write(pack_dir.join(asset), enciphered).unwrap();
            let output_zip = dir.join("converted.zip");
            let error = read_fs_pack_to_studio_zip(&pack_dir, &output_zip, "Clear index")
                .expect_err("enciphered media");
            assert!(
                error.contains_any_code(&[codes::IMPORT_FS_ENCRYPTED_UNKNOWN_KEY]),
                "{asset}: {error}"
            );
            assert!(!output_zip.exists(), "{asset}");
            fs::remove_dir_all(dir).expect("cleanup enciphered media fixture");
        }
    }

    #[test]
    fn marked_but_enciphered_pack_still_uses_the_common_key() {
        use super::fs_fixtures::write_encrypted_cover_pack;
        let dir = temp_dir("marked_encrypted");
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let cover = b"BMmarked-but-enciphered".to_vec();
        write_encrypted_cover_pack(&pack_dir, &cover);
        fs::write(pack_dir.join(".cleartext"), []).unwrap();
        let preview = read_fs_pack_preview(&pack_dir).expect("preview");
        assert_eq!(preview["variant"], "encrypted");
        let output_zip = dir.join("converted.zip");
        read_fs_pack_to_studio_zip(&pack_dir, &output_zip, "Marked pack").expect("convert");
        let assets = converted_assets(&output_zip);
        assert!(assets.contains(&cover));
        assert!(assets.iter().any(|a| a == b"ID3entry-audio"));
        fs::remove_dir_all(dir).expect("cleanup marked fixture");
    }

    #[test]
    fn unknown_key_pack_is_reported_with_its_own_code() {
        use super::fs_fixtures::write_unknown_key_pack;
        for marker in [true, false] {
            let dir = temp_dir("unknown_key");
            let pack_dir = dir.join(DIALECT_PACK_UUID);
            write_unknown_key_pack(&pack_dir, marker);
            let reason = read_fs_pack_preview(&pack_dir)
                .expect_err("unknown key")
                .into_reason();
            assert!(
                reason.contains_any_code(&[codes::IMPORT_FS_ENCRYPTED_UNKNOWN_KEY]),
                "{reason}"
            );
            let error = read_fs_pack_to_studio_zip(&pack_dir, &dir.join("converted.zip"), "Locked")
                .expect_err("unknown key");
            assert!(
                error.contains_any_code(&[codes::IMPORT_FS_ENCRYPTED_UNKNOWN_KEY]),
                "{error}"
            );
            assert!(!dir.join("converted.zip").exists());
            fs::remove_dir_all(dir).expect("cleanup unknown key fixture");
        }
    }

    #[test]
    fn asset_paths_stay_confined_to_their_pack_folder() {
        let dir = temp_dir("asset_path_confinement");
        let asset_dir = dir.join("sf");
        let nested_dir = asset_dir.join("000");
        fs::create_dir_all(&nested_dir).expect("create asset directory");
        let expected = nested_dir.join("SOUND001.mp3");
        fs::write(&expected, b"audio").expect("write asset");

        let resolved = resolve_asset_path(&asset_dir, "000/SOUND001", FsPackVariant::Plain, "mp3")
            .expect("resolve asset inside pack");
        assert_eq!(
            resolved,
            fs::canonicalize(&expected).expect("canonical expected asset")
        );

        let traversal = resolve_asset_path(&asset_dir, "../evil.mp3", FsPackVariant::Plain, "mp3")
            .expect_err("parent traversal must be rejected");
        assert!(traversal.contains_any_code(&[codes::FILES_INVALID_ASSET_PATH_INDEX]));

        let absolute_name = if cfg!(windows) {
            "C:/evil.mp3"
        } else {
            "/tmp/x.mp3"
        };
        let absolute = resolve_asset_path(&asset_dir, absolute_name, FsPackVariant::Plain, "mp3")
            .expect_err("absolute asset path must be rejected");
        assert!(absolute.contains_any_code(&[codes::FILES_INVALID_ASSET_PATH_INDEX]));

        fs::remove_dir_all(dir).expect("cleanup confinement fixture");
    }

    #[test]
    fn import_dialect_clears_the_two_i4_bridge_signatures() {
        let (dir, story) = convert_dialect_fixture("i4_signatures");

        // Lunii.QT — `stories.py::get_ni_data` fait littéralement
        // `int(self.format_version[1:])`. « studio-import » y levait
        // `ValueError: invalid literal for int() with base 10: 'tudio-import'`.
        let format = story["format"].as_str().expect("format est une chaîne");
        let version_tail = format
            .strip_prefix('v')
            .unwrap_or_else(|| panic!("format '{format}' n'est pas de la forme vN"));
        assert!(
            version_tail.parse::<u32>().is_ok(),
            "int('{version_tail}') échouerait comme chez Lunii.QT"
        );

        // STUdio — `ArchiveStoryPackReader` déréférence `imageNode` sans garde et
        // levait `NullPointerException` dès qu'un stage n'avait pas de propriété
        // `image`. La propriété doit exister, y compris à `null`.
        let stages = story["stageNodes"].as_array().expect("stageNodes");
        for (index, stage) in stages.iter().enumerate() {
            assert!(
                stage.get("image").is_some(),
                "stageNodes[{index}] sans propriété 'image'"
            );
        }
        assert!(
            stages.iter().any(|stage| stage["image"].is_null()),
            "la fixture doit contenir un stage sans image"
        );

        fs::remove_dir_all(dir).expect("cleanup i4 signature fixture");
    }

    #[test]
    fn import_dialect_emits_every_optional_stage_field_explicitly() {
        let (dir, story) = convert_dialect_fixture("dialect_contract");

        assert_eq!(story["format"], serde_json::json!("v1"));

        let stages = story["stageNodes"].as_array().expect("stageNodes");
        assert_eq!(stages.len(), 3);
        for (index, stage) in stages.iter().enumerate() {
            for key in [
                "audio",
                "image",
                "okTransition",
                "homeTransition",
                "squareOne",
            ] {
                assert!(
                    stage.get(key).is_some(),
                    "stageNodes[{index}] sans propriété '{key}'"
                );
            }
            assert!(
                stage["squareOne"].is_boolean(),
                "stageNodes[{index}] : 'squareOne' doit être un booléen explicite"
            );
        }

        let square_ones = stages
            .iter()
            .filter(|stage| stage["squareOne"] == serde_json::json!(true))
            .count();
        assert_eq!(square_ones, 1, "exactement un stage d'entrée");
        assert_eq!(stages[0]["squareOne"], serde_json::json!(true));
        assert_eq!(stages[1]["squareOne"], serde_json::json!(false));

        // Ce que le pack n'a pas est émis à `null`, pas omis.
        assert!(stages[0]["homeTransition"].is_null());
        assert!(stages[1]["image"].is_null());
        assert!(stages[2]["audio"].is_null());
        assert!(stages[2]["okTransition"].is_null());
        assert!(stages[2]["homeTransition"].is_null());

        // Ce que le pack a est conservé tel quel.
        assert!(stages[0]["image"].as_str().is_some());
        assert!(stages[0]["audio"].as_str().is_some());
        assert!(stages[1]["audio"].as_str().is_some());
        assert!(stages[2]["image"].as_str().is_some());

        fs::remove_dir_all(dir).expect("cleanup dialect contract fixture");
    }

    #[test]
    fn import_dialect_preserves_the_graph_read_from_the_pack() {
        let (dir, story) = convert_dialect_fixture("dialect_graph");

        assert_eq!(story["title"], serde_json::json!("Pack dialecte"));
        assert_eq!(story["version"], serde_json::json!(1));
        assert_eq!(story["factoryDisabled"], serde_json::json!(true));
        assert_eq!(story["nightModeAvailable"], serde_json::json!(true));
        assert_eq!(story["uuid"], serde_json::json!(DIALECT_PACK_UUID));

        let document: StoryDocument =
            serde_json::from_value(story.clone()).expect("story.json désérialisable");
        let uuids: Vec<String> = document
            .stage_nodes
            .iter()
            .map(|stage| stage.uuid.clone())
            .collect();
        assert_eq!(uuids[0], DIALECT_PACK_UUID);

        assert_eq!(document.action_nodes.len(), 2);
        assert_eq!(document.action_nodes[0].id, "action-1");
        assert_eq!(
            document.action_nodes[0].options,
            vec![Some(uuids[1].clone()), Some(uuids[2].clone())]
        );
        assert_eq!(document.action_nodes[1].id, "action-2");
        // Le retour de `action-2` sur le stage d'entrée referme le cycle.
        assert_eq!(
            document.action_nodes[1].options,
            vec![Some(uuids[0].clone())]
        );

        let transition = |stage: &StageNode, ok: bool| {
            let value = if ok {
                stage.ok_transition.value()
            } else {
                stage.home_transition.value()
            };
            value.map(|t| (t.action_node.clone(), t.selection))
        };
        assert_eq!(
            transition(&document.stage_nodes[0], true),
            Some(("action-1".to_string(), OptionSelection::Fixed(0)))
        );
        assert_eq!(transition(&document.stage_nodes[0], false), None);
        assert_eq!(
            transition(&document.stage_nodes[1], true),
            Some(("action-2".to_string(), OptionSelection::Fixed(0)))
        );
        assert_eq!(
            transition(&document.stage_nodes[1], false),
            Some(("action-1".to_string(), OptionSelection::Fixed(1)))
        );
        assert_eq!(transition(&document.stage_nodes[2], true), None);
        assert_eq!(transition(&document.stage_nodes[2], false), None);

        let controls = &document.stage_nodes[2].control_settings;
        assert_eq!(
            (
                controls.wheel(),
                controls.ok(),
                controls.home(),
                controls.pause(),
                controls.autoplay()
            ),
            (false, false, false, false, true)
        );
        assert!(
            controls.is_complete(),
            "une projection FS renseigne toujours les cinq contrôles"
        );

        fs::remove_dir_all(dir).expect("cleanup dialect graph fixture");
    }

    #[test]
    #[ignore = "requires STORY_STUDIO_PLAIN_PACK_DIR"]
    fn converts_external_plain_pack_when_configured() {
        let pack_dir = std::env::var_os("STORY_STUDIO_PLAIN_PACK_DIR")
            .expect("STORY_STUDIO_PLAIN_PACK_DIR must point to an external plain pack");
        let dir = temp_dir("external_plain_conversion");
        let cache_dir = dir.join("cache");
        let output_zip = crate::support::imported_pack::ensure_studio_pack_zip_from_dir(
            Path::new(&pack_dir)
                .to_str()
                .expect("external pack path utf8"),
            &cache_dir,
        )
        .expect("convert configured external plain pack through folder import")
        .zip_path;
        let file = fs::File::open(&output_zip).expect("open converted external zip");
        let mut archive = zip::ZipArchive::new(file).expect("read converted external zip");
        assert!(archive.by_name("story.json").is_ok());
        drop(archive);

        let report = crate::services::pack_reader::classify_pack_editability(
            output_zip.to_str().expect("external zip path utf8"),
        )
        .expect("classify converted external pack");
        assert!(report.authoring_editable, "{}", report.reason);

        fs::remove_dir_all(dir).expect("cleanup external conversion output");
    }
    /// Les UUID de stage d'une projection FS sont tirés à chaque exécution :
    /// pour comparer des octets, on les remplace par leur rang de première
    /// apparition. Tout le reste du fichier est confronté tel quel.
    fn normalize_generated_uuids(raw: &str) -> String {
        let mut seen: Vec<String> = Vec::new();
        let bytes = raw.as_bytes();
        let mut out = String::with_capacity(raw.len());
        let mut index = 0;
        while index < bytes.len() {
            let candidate = raw.get(index..index + 36).filter(|slice| {
                slice.as_bytes().iter().enumerate().all(|(offset, byte)| {
                    if matches!(offset, 8 | 13 | 18 | 23) {
                        *byte == b'-'
                    } else {
                        byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
                    }
                })
            });
            match candidate {
                Some(uuid) => {
                    let rank = seen
                        .iter()
                        .position(|known| known == uuid)
                        .unwrap_or_else(|| {
                            seen.push(uuid.to_string());
                            seen.len() - 1
                        });
                    out.push_str(&format!("UUID-{rank}"));
                    index += 36;
                }
                None => {
                    let ch = raw[index..].chars().next().expect("caractère");
                    out.push(ch);
                    index += ch.len_utf8();
                }
            }
        }
        out
    }

    fn converted_story_bytes(fixture: &str) -> Vec<u8> {
        let dir = temp_dir(&format!("conversion_bytes_{fixture}"));
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let output_zip = dir.join("converted.zip");
        match fixture {
            "plain" => {
                write_plain_pack(&pack_dir);
            }
            _ => write_dialect_fixture_pack(&pack_dir),
        }
        read_fs_pack_to_studio_zip(&pack_dir, &output_zip, "Pack sonde")
            .expect("conversion du pack FS");
        let file = fs::File::open(&output_zip).expect("ouverture du ZIP converti");
        let mut archive = zip::ZipArchive::new(file).expect("lecture du ZIP converti");
        let mut raw = Vec::new();
        archive
            .by_name("story.json")
            .expect("story.json converti")
            .read_to_end(&mut raw)
            .expect("lecture du story.json converti");
        fs::remove_dir_all(&dir).ok();
        raw
    }

    /// Empreinte des octets de conversion FS, aux UUID générés près.
    ///
    /// Les documents d'auteur ne portent plus les positions synthétiques FS : les
    /// deux empreintes ci-dessous décrivent la sortie
    /// `v4-studio-v1-editor-layout-separated`, et la clé de cache a été
    /// incrémentée avec elle.
    #[test]
    fn fs_conversion_bytes_match_the_editor_layout_separated_dialect() {
        for (fixture, expected) in [
            (
                "dialect",
                "b91d1371c7444aeb5a812f93fffd57044b8daa2f900036916d49e941883f2aec",
            ),
            (
                "plain",
                "4fd0cf3531aa8e1b4070881a8d7d2d22cbcf5b60a7970f61dce5956884b1f3b6",
            ),
        ] {
            let raw = converted_story_bytes(fixture);
            let normalized =
                normalize_generated_uuids(std::str::from_utf8(&raw).expect("story.json UTF-8"));
            let digest = format!("{:x}", sha2::Sha256::digest(normalized.as_bytes()));
            assert_eq!(
                digest, expected,
                "les octets de conversion FS ont changé pour la fixture «{fixture}» : \
                 incrémenter CONVERSION_FORMAT_VERSION dans le même commit"
            );
        }
    }

    #[test]
    fn fs_layout_is_projection_derived_and_separate_from_the_author_document() {
        let dir = temp_dir("fs_projection_context");
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let output_zip = dir.join("converted.zip");
        write_dialect_fixture_pack(&pack_dir);

        let context = read_fs_pack_to_studio_zip_observed(
            &pack_dir,
            &output_zip,
            "Pack dialecte",
            &mut NoopObserver,
        )
        .expect("convert with provenance context");
        assert_eq!(
            context.document_origin,
            crate::native_pack::DocumentOrigin::ImportedFs
        );
        assert_eq!(
            context.default_value_origin,
            crate::native_pack::ValueOrigin::SourceNativeDerived
        );
        assert!(context.value_provenance.iter().any(|entry| {
            entry.path == "/version"
                && entry.origin == crate::native_pack::ValueOrigin::SourceNativeDerived
        }));
        assert!(!context.editor_positions.is_empty());
        assert!(context.editor_positions.iter().all(|entry| {
            entry.origin == crate::native_pack::ValueOrigin::ProjectionDerived
                && entry.path.ends_with("/position")
        }));

        let file = fs::File::open(&output_zip).expect("open converted zip");
        let mut archive = zip::ZipArchive::new(file).expect("read converted zip");
        let mut raw = String::new();
        archive
            .by_name("story.json")
            .expect("story.json")
            .read_to_string(&mut raw)
            .expect("read story.json");
        let story: serde_json::Value = serde_json::from_str(&raw).expect("valid story.json");
        assert!(story["stageNodes"]
            .as_array()
            .expect("stages")
            .iter()
            .all(|stage| stage.get("position").is_none()));
        assert!(story["actionNodes"]
            .as_array()
            .expect("actions")
            .iter()
            .all(|action| action.get("position").is_none()));

        fs::remove_dir_all(dir).ok();
    }

    /// Le lecteur fabrique tous les identifiants sauf celui du Stage d'entrée,
    /// qu'il lit sur le nom du dossier. Les identifiants fabriqués relèvent de
    /// `projection-derived` ; sans override, ils héritaient de
    /// `source-native-derived` comme si le format natif les portait.
    #[test]
    fn generated_fs_identifiers_are_projection_derived_but_the_entry_keeps_the_directory_identity()
    {
        let dir = temp_dir("fs_generated_identifiers");
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let output_zip = dir.join("converted.zip");
        write_dialect_fixture_pack(&pack_dir);

        let context = read_fs_pack_to_studio_zip_observed(
            &pack_dir,
            &output_zip,
            "Pack dialecte",
            &mut NoopObserver,
        )
        .expect("convert with provenance context");

        let origin_of = |path: &str| {
            context
                .value_provenance
                .iter()
                .find(|entry| entry.path == path)
                .map(|entry| entry.origin)
        };
        let uuid_paths = context
            .value_provenance
            .iter()
            .filter(|entry| entry.path.ends_with("/uuid"))
            .collect::<Vec<_>>();
        assert_eq!(uuid_paths.len(), 3, "un uuid qualifié par Stage");

        let entry_path = format!("/stageNodes/@uuid={DIALECT_PACK_UUID}#0/uuid");
        assert_eq!(
            origin_of(&entry_path),
            Some(crate::native_pack::ValueOrigin::SourceNativeDerived),
            "l'identité d'entrée vient du dossier du pack"
        );
        for entry in uuid_paths.iter().filter(|entry| entry.path != entry_path) {
            assert_eq!(
                entry.origin,
                crate::native_pack::ValueOrigin::ProjectionDerived,
                "{} : un UUID tiré par le lecteur n'est pas natif",
                entry.path
            );
        }

        // Les références fabriquées suivent leur cible.
        assert!(context.value_provenance.iter().any(|entry| {
            entry.path.ends_with("/okTransition/actionNode")
                && entry.origin == crate::native_pack::ValueOrigin::ProjectionDerived
        }));
        assert!(context.value_provenance.iter().any(|entry| {
            entry.path.ends_with("/homeTransition/actionNode")
                && entry.origin == crate::native_pack::ValueOrigin::ProjectionDerived
        }));
        assert_eq!(
            context
                .value_provenance
                .iter()
                .filter(|entry| entry.path.ends_with("/options")
                    && entry.origin == crate::native_pack::ValueOrigin::ProjectionDerived)
                .count(),
            2,
            "les options des deux Actions désignent des UUID fabriqués"
        );

        // L'identité stable du pack est celle du Stage d'entrée FS.
        assert_eq!(
            context.pack_identity.origin,
            crate::native_pack::PackIdentityOrigin::FsEntryStage
        );
        assert_eq!(
            context.pack_identity.value.as_deref(),
            Some(DIALECT_PACK_UUID)
        );

        fs::remove_dir_all(dir).ok();
    }

    /// Le contexte doit survivre au ZIP converti. Il n'est pas
    /// sérialisé à côté du cache : la projection le reconstruit sur le document
    /// relu. Ce test épingle l'égalité des deux, faute de quoi le raccord de la
    /// frontière d'import ne vaudrait rien.
    #[test]
    fn the_conversion_context_is_rebuilt_identically_from_the_converted_zip() {
        let dir = temp_dir("fs_context_rebuild");
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let output_zip = dir.join("converted.zip");
        write_dialect_fixture_pack(&pack_dir);

        let converted = read_fs_pack_to_studio_zip_observed(
            &pack_dir,
            &output_zip,
            "Pack dialecte",
            &mut NoopObserver,
        )
        .expect("convert with provenance context");

        let file = fs::File::open(&output_zip).expect("open converted zip");
        let mut archive = zip::ZipArchive::new(file).expect("read converted zip");
        let mut raw = String::new();
        archive
            .by_name("story.json")
            .expect("story.json")
            .read_to_string(&mut raw)
            .expect("read story.json");
        let decoded =
            crate::native_pack::decode_story_document(&raw).expect("decode converted story.json");
        let rebuilt = StoryDocumentContext::imported_fs(
            &decoded.document,
            &fs_pack_directory_identity(&pack_dir),
        );

        assert_eq!(rebuilt, converted);
        assert!(!rebuilt.editor_positions.is_empty());

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn fs_version_256_is_little_endian_source_native_derived() {
        let dir = temp_dir("fs_version_256_provenance");
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let output_zip = dir.join("converted.zip");
        write_dialect_fixture_pack(&pack_dir);
        let ni_path = pack_dir.join("ni");
        let mut ni = fs::read(&ni_path).expect("read ni");
        ni[2..4].copy_from_slice(&256_i16.to_le_bytes());
        fs::write(&ni_path, ni).expect("write ni version");

        let context = read_fs_pack_to_studio_zip_observed(
            &pack_dir,
            &output_zip,
            "Pack version 256",
            &mut NoopObserver,
        )
        .expect("convert version 256");
        assert!(context.value_provenance.iter().any(|entry| {
            entry.path == "/version"
                && entry.origin == crate::native_pack::ValueOrigin::SourceNativeDerived
        }));
        assert!(context.export_qualifications.iter().any(|qualification| {
            qualification.path == "/version"
                && qualification.status == crate::native_pack::InteroperabilityStatus::Untested
        }));

        let file = fs::File::open(&output_zip).expect("open converted zip");
        let mut archive = zip::ZipArchive::new(file).expect("read converted zip");
        let mut raw = String::new();
        archive
            .by_name("story.json")
            .expect("story.json")
            .read_to_string(&mut raw)
            .expect("read story.json");
        let story: serde_json::Value = serde_json::from_str(&raw).expect("valid story.json");
        assert_eq!(story["version"], serde_json::json!(256));

        fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
mod listening_document_tests {
    use super::*;
    fn index(stages: usize) -> Vec<u8> {
        let mut ni = vec![0; 512];
        ni[8..12].copy_from_slice(&44u32.to_le_bytes());
        ni[12..16].copy_from_slice(&(stages as u32).to_le_bytes());
        for _ in 0..stages {
            let mut node = vec![0; 44];
            node[4..8].copy_from_slice(&(-1i32).to_le_bytes());
            node[8..12].copy_from_slice(&(-1i32).to_le_bytes());
            ni.extend(node);
        }
        ni
    }
    #[test]
    fn listening_document_bounds_its_work_on_untrusted_indexes() {
        let read =
            |stages| listening_document(&index(stages), &[], &[], &[], FsPackVariant::Plain, false);
        assert!(read(20_000).is_some());
        assert!(read(20_001).is_none(), "beyond the preview's stage limit");
    }
}

#[cfg(test)]
mod slice_tests {
    use std::{fs, io::Read};
    #[test]
    fn native_list_slices_at_same_offset_keep_their_distinct_wheel_options() {
        let root = std::env::temp_dir().join(format!("fs-pack-slices-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let clear = root.join("00000000-0000-4000-8000-123456abcdef");
        crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&clear);
        let mut ni = fs::read(clear.join("ni")).unwrap();
        // Source fixture: entry OK uses li[0..2] = [stage1, stage2]. The
        // second stage's Home now uses li[0..1], independently of entry OK.
        ni[512 + 44 + 24..512 + 44 + 28].copy_from_slice(&1i32.to_le_bytes());
        ni[512 + 44 + 28..512 + 44 + 32].copy_from_slice(&0i32.to_le_bytes());
        fs::write(clear.join("ni"), ni).unwrap();
        let zip = root.join("slices.zip");
        crate::support::fs_pack_reader::read_fs_pack_to_studio_zip(&clear, &zip, "Tranches")
            .unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(&zip).unwrap()).unwrap();
        let mut raw = String::new();
        zip.by_name("story.json")
            .unwrap()
            .read_to_string(&mut raw)
            .unwrap();
        let doc = crate::native_pack::decode_story_document(&raw)
            .unwrap()
            .document;
        let action = |t: &crate::native_pack::Presence<crate::native_pack::Transition>| {
            let id = &t.value().unwrap().action_node;
            doc.action_nodes.iter().find(|a| &a.id == id).unwrap()
        };
        let ok = action(&doc.stage_nodes[0].ok_transition);
        let home = action(&doc.stage_nodes[1].home_transition);
        assert_eq!(ok.options.len(), 2);
        assert_eq!(home.options.len(), 1);
        assert_eq!(ok.option_target(0), Some(doc.stage_nodes[1].uuid.as_str()));
        assert_eq!(ok.option_target(1), Some(doc.stage_nodes[2].uuid.as_str()));
        assert_eq!(
            home.option_target(0),
            Some(doc.stage_nodes[1].uuid.as_str())
        );
        drop(zip);
        fs::remove_dir_all(root).unwrap();
    }
}
