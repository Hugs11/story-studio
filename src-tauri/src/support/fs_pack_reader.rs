use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

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
    Encrypted,
    Plain,
}

impl FsPackVariant {
    fn index_name(self, base: &str) -> String {
        match self {
            Self::Encrypted => base.to_string(),
            Self::Plain => format!("{base}.plain"),
        }
    }

    fn decode(self, bytes: &[u8]) -> Vec<u8> {
        match self {
            Self::Encrypted => decipher_common_key(bytes),
            Self::Plain => bytes.to_vec(),
        }
    }
}

pub(crate) fn detect_fs_pack_variant(pack_dir: &Path) -> Option<FsPackVariant> {
    if !pack_dir.join("ni").is_file()
        || !pack_dir.join("rf").is_dir()
        || !pack_dir.join("sf").is_dir()
    {
        return None;
    }

    let has_indexes = |suffix: &str| {
        ["ri", "si", "li"]
            .iter()
            .all(|name| pack_dir.join(format!("{name}{suffix}")).is_file())
    };

    match (has_indexes(""), has_indexes(".plain")) {
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

fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
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

fn read_asset(
    index_data: &[u8],
    asset_folder: &Path,
    index: i32,
    variant: FsPackVariant,
    plain_extension: &str,
) -> Result<Vec<u8>, String> {
    if index < 0 {
        return Err(format!("Index asset négatif : {}", index));
    }
    let start = index as usize * 12;
    if start + 12 > index_data.len() {
        return Err(format!("Index asset {} hors limites", index));
    }
    let name = std::str::from_utf8(&index_data[start..start + 12])
        .map_err(|e| format!("Nom asset invalide : {}", e))?
        .trim_matches('\0')
        .replace('\\', "/");
    let path = resolve_asset_path(asset_folder, &name, variant, plain_extension)?;
    let raw = std::fs::read(&path)
        .map_err(|e| format!("Asset introuvable {} : {}", path.display(), e))?;
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
        return Err(format!("Chemin d'asset invalide dans l'index : {name}"));
    }

    let mut path = asset_folder.join(relative);
    if variant == FsPackVariant::Plain && path.extension().is_none() {
        path.set_extension(plain_extension);
    }

    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|e| format!("Asset introuvable {} : {}", path.display(), e))?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "Asset refusé car il n'est pas un fichier régulier : {}",
            path.display()
        ));
    }

    let canonical_root = std::fs::canonicalize(asset_folder).map_err(|e| {
        format!(
            "Dossier d'assets inaccessible {} : {}",
            asset_folder.display(),
            e
        )
    })?;
    let canonical_path = std::fs::canonicalize(&path)
        .map_err(|e| format!("Asset inaccessible {} : {}", path.display(), e))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(format!(
            "Chemin d'asset hors du dossier autorisé : {}",
            path.display()
        ));
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
        format!(
            "Pack natif illisible : la transition {trigger} du stage {} porte un index d'option hors dialecte ({error}).",
            stage_index + 1
        )
    })
}

pub(crate) fn fs_pack_directory_identity(pack_dir: &Path) -> String {
    let dir_name = pack_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    dir_name.split('.').next().unwrap_or(dir_name).to_string()
}

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
pub(crate) fn read_fs_pack_to_studio_zip_observed<O: FsPackObserver>(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
    observer: &mut O,
) -> Result<StoryDocumentContext, String> {
    let pack_uuid = fs_pack_directory_identity(pack_dir);
    let night_mode = pack_dir.join("nm").exists();

    let variant = detect_fs_pack_variant(pack_dir).ok_or_else(|| {
        format!(
            "Dossier de pack filesystem non reconnu : {}",
            pack_dir.display()
        )
    })?;

    let read_index = |name: &str| {
        let index_name = variant.index_name(name);
        std::fs::read(pack_dir.join(&index_name))
            .map(|bytes| variant.decode(&bytes))
            .map_err(|e| format!("Impossible de lire {index_name} : {e}"))
    };
    let ri = read_index("ri")?;
    let si = read_index("si")?;
    let li = read_index("li")?;

    let ni =
        std::fs::read(pack_dir.join("ni")).map_err(|e| format!("Impossible de lire ni : {}", e))?;
    if ni.len() < 512 {
        return Err(format!("Fichier ni trop court : {} octets", ni.len()));
    }

    // ni header (little-endian)
    let version = i16::from_le_bytes([ni[2], ni[3]]);
    let node_size = u32::from_le_bytes([ni[8], ni[9], ni[10], ni[11]]) as usize;
    let stage_count = u32::from_le_bytes([ni[12], ni[13], ni[14], ni[15]]) as usize;
    let factory_disabled = ni[24] != 0;

    if node_size < 42 {
        return Err(format!("nodeSize invalide : {}", node_size));
    }

    observer.on_pack_header(&pack_uuid, stage_count, node_size);

    // Parse stage nodes (start at offset 512 in ni)
    let mut stages: Vec<StageRecord> = Vec::with_capacity(stage_count);
    let mut stage_uuids: Vec<String> = Vec::with_capacity(stage_count);

    for i in 0..stage_count {
        let off = 512 + i * node_size;
        if off + node_size > ni.len() {
            return Err(format!("ni tronqué au nœud {}", i));
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
        return Err("Pack FS vide ou sans stages.".to_string());
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
    let mut action_offset_to_idx: HashMap<i32, usize> = HashMap::new();
    for (stage_index, stage) in stages.iter().enumerate() {
        for (trigger, li_off, num_opt) in [
            (Trigger::Ok, stage.ok_li_offset, stage.ok_num_options),
            (Trigger::Home, stage.home_li_offset, stage.home_num_options),
        ] {
            if li_off == -1 {
                continue;
            }
            // La clé de déduplication reste le seul offset : l'observateur relève les
            // réutilisations sans changer le premier `num_options` retenu.
            match action_offset_to_idx.get(&li_off) {
                Some(index) => observer.on_action_offset_reuse(ActionOffsetReuse {
                    li_offset: li_off,
                    first_option_count: action_order[*index].1,
                    reused_option_count: num_opt,
                    stage_index,
                    trigger,
                }),
                None => {
                    action_offset_to_idx.insert(li_off, action_order.len());
                    action_order.push((li_off, num_opt));
                }
            }
        }
    }

    let rf_dir = pack_dir.join("rf");
    let sf_dir = pack_dir.join("sf");
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

    for (stage_idx, (stage, stage_uuid)) in stages.iter().zip(stage_uuids.iter()).enumerate() {
        let audio_name: Option<String> = if stage.sound_index >= 0 {
            let bytes = read_asset(&si, &sf_dir, stage.sound_index, variant, "mp3")
                .map_err(|e| format!("Audio stage {} : {}", stage_idx, e))?;
            let name = sha1_hex(&bytes) + ".mp3";
            assets.entry(name.clone()).or_insert(bytes);
            Some(name)
        } else {
            None
        };

        let image_name: Option<String> = if stage.image_index >= 0 {
            let img_bytes = read_asset(&ri, &rf_dir, stage.image_index, variant, "bmp")
                .map_err(|e| format!("Image stage {} : {}", stage_idx, e))?;
            let name = sha1_hex(&img_bytes) + ".bmp";
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
            let a_idx = action_offset_to_idx[&stage.ok_li_offset];
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
            let a_idx = action_offset_to_idx[&stage.home_li_offset];
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
    let story_json = serde_json::to_value(&document)
        .map_err(|e| format!("Sérialisation du story.json impossible : {}", e))?;

    // Write output ZIP
    if let Some(parent) = output_zip.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Impossible de créer le répertoire de sortie : {}", e))?;
    }
    let file = std::fs::File::create(output_zip)
        .map_err(|e| format!("Impossible de créer {} : {}", output_zip.display(), e))?;
    let mut writer = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let story_bytes = serde_json::to_string_pretty(&story_json)
        .map_err(|e| format!("Sérialisation JSON impossible : {}", e))?
        .into_bytes();
    writer
        .start_file("story.json", opts)
        .map_err(|e| format!("ZIP story.json : {}", e))?;
    writer
        .write_all(&story_bytes)
        .map_err(|e| format!("Écriture story.json : {}", e))?;

    for (name, bytes) in &assets {
        writer
            .start_file(format!("assets/{}", name), opts)
            .map_err(|e| format!("ZIP asset {} : {}", name, e))?;
        writer
            .write_all(bytes)
            .map_err(|e| format!("Écriture asset {} : {}", name, e))?;
    }

    writer
        .finish()
        .map_err(|e| format!("Finalisation ZIP : {}", e))?;
    Ok(context)
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
        assert!(traversal.contains("Chemin d'asset invalide"));

        let absolute_name = if cfg!(windows) {
            "C:/evil.mp3"
        } else {
            "/tmp/x.mp3"
        };
        let absolute = resolve_asset_path(&asset_dir, absolute_name, FsPackVariant::Plain, "mp3")
            .expect_err("absolute asset path must be rejected");
        assert!(absolute.contains("Chemin d'asset invalide"));

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
