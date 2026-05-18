use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

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

fn read_asset(index_data: &[u8], asset_folder: &Path, index: i32) -> Result<Vec<u8>, String> {
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
    let path = asset_folder.join(&name);
    let raw = std::fs::read(&path)
        .map_err(|e| format!("Asset introuvable {} : {}", path.display(), e))?;
    Ok(decipher_common_key(&raw))
}

pub fn read_fs_pack_to_studio_zip(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
) -> Result<(), String> {
    let dir_name = pack_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    let pack_uuid = dir_name.split('.').next().unwrap_or(dir_name).to_string();
    let night_mode = pack_dir.join("nm").exists();

    let ri = decipher_common_key(
        &std::fs::read(pack_dir.join("ri"))
            .map_err(|e| format!("Impossible de lire ri : {}", e))?,
    );
    let si = decipher_common_key(
        &std::fs::read(pack_dir.join("si"))
            .map_err(|e| format!("Impossible de lire si : {}", e))?,
    );
    let li_raw =
        std::fs::read(pack_dir.join("li")).map_err(|e| format!("Impossible de lire li : {}", e))?;
    let li = decipher_common_key(&li_raw);

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

    // Parse stage nodes (start at offset 512 in ni)
    let mut stages: Vec<StageRecord> = Vec::with_capacity(stage_count);
    let mut stage_uuids: Vec<String> = Vec::with_capacity(stage_count);

    for i in 0..stage_count {
        let off = 512 + i * node_size;
        if off + node_size > ni.len() {
            return Err(format!("ni tronqué au nœud {}", i));
        }
        let d = &ni[off..off + node_size];
        stages.push(StageRecord {
            image_index: i32::from_le_bytes([d[0], d[1], d[2], d[3]]),
            sound_index: i32::from_le_bytes([d[4], d[5], d[6], d[7]]),
            ok_li_offset: i32::from_le_bytes([d[8], d[9], d[10], d[11]]),
            ok_num_options: i32::from_le_bytes([d[12], d[13], d[14], d[15]]),
            ok_selected: i32::from_le_bytes([d[16], d[17], d[18], d[19]]),
            home_li_offset: i32::from_le_bytes([d[20], d[21], d[22], d[23]]),
            home_num_options: i32::from_le_bytes([d[24], d[25], d[26], d[27]]),
            home_selected: i32::from_le_bytes([d[28], d[29], d[30], d[31]]),
            wheel: i16::from_le_bytes([d[32], d[33]]) != 0,
            ok: i16::from_le_bytes([d[34], d[35]]) != 0,
            home: i16::from_le_bytes([d[36], d[37]]) != 0,
            pause: i16::from_le_bytes([d[38], d[39]]) != 0,
            autoplay: i16::from_le_bytes([d[40], d[41]]) != 0,
        });
        let stage_uuid = if i == 0 {
            pack_uuid.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        stage_uuids.push(stage_uuid);
    }

    if stages.is_empty() {
        return Err("Pack FS vide ou sans stages.".to_string());
    }

    // li as int32 array
    let li_ints: Vec<i32> = li
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();

    // Discover action nodes in stage iteration order (mirrors Java LinkedHashMap behaviour)
    let mut action_order: Vec<(i32, i32)> = Vec::new(); // (li_offset, num_options)
    let mut action_offset_to_idx: HashMap<i32, usize> = HashMap::new();
    for stage in &stages {
        for (li_off, num_opt) in [
            (stage.ok_li_offset, stage.ok_num_options),
            (stage.home_li_offset, stage.home_num_options),
        ] {
            if li_off != -1 && !action_offset_to_idx.contains_key(&li_off) {
                action_offset_to_idx.insert(li_off, action_order.len());
                action_order.push((li_off, num_opt));
            }
        }
    }

    let rf_dir = pack_dir.join("rf");
    let sf_dir = pack_dir.join("sf");
    let mut assets: HashMap<String, Vec<u8>> = HashMap::new();

    // Build action nodes JSON
    let mut action_nodes_json: Vec<serde_json::Value> = Vec::new();
    for (action_idx, (li_off, num_opt)) in action_order.iter().enumerate() {
        let li_start = *li_off as usize;
        let count = (*num_opt).max(0) as usize;
        let options: Vec<serde_json::Value> = (0..count)
            .filter_map(|j| {
                let stage_idx = *li_ints.get(li_start + j)?;
                let uuid = stage_uuids.get(stage_idx as usize)?;
                Some(serde_json::Value::String(uuid.clone()))
            })
            .collect();
        action_nodes_json.push(serde_json::json!({
            "id": format!("action-{}", action_idx + 1),
            "name": format!("Action {}", action_idx + 1),
            "options": options,
            "position": { "x": (action_idx + 1) * 120, "y": 0 }
        }));
    }

    // Build stage nodes JSON
    let mut stage_nodes_json: Vec<serde_json::Value> = Vec::new();
    let square_one_uuid = stage_uuids[0].clone();

    for (stage_idx, (stage, stage_uuid)) in stages.iter().zip(stage_uuids.iter()).enumerate() {
        let audio_name: Option<String> = if stage.sound_index >= 0 {
            let bytes = read_asset(&si, &sf_dir, stage.sound_index)
                .map_err(|e| format!("Audio stage {} : {}", stage_idx, e))?;
            let name = sha1_hex(&bytes) + ".mp3";
            assets.entry(name.clone()).or_insert(bytes);
            Some(name)
        } else {
            None
        };

        let image_name: Option<String> = if stage.image_index >= 0 {
            let img_bytes = read_asset(&ri, &rf_dir, stage.image_index)
                .map_err(|e| format!("Image stage {} : {}", stage_idx, e))?;
            let name = sha1_hex(&img_bytes) + ".bmp";
            assets.entry(name.clone()).or_insert(img_bytes);
            Some(name)
        } else {
            None
        };

        let mut stage_json = serde_json::json!({
            "uuid": stage_uuid,
            "name": format!("Stage {}", stage_idx + 1),
            "type": "stage",
            "controlSettings": {
                "wheel": stage.wheel,
                "ok": stage.ok,
                "home": stage.home,
                "pause": stage.pause,
                "autoplay": stage.autoplay,
            },
            "position": { "x": (stage_idx + 1) * 160, "y": 160 }
        });

        if *stage_uuid == square_one_uuid {
            stage_json["squareOne"] = serde_json::Value::Bool(true);
        }
        if let Some(audio) = audio_name {
            stage_json["audio"] = serde_json::Value::String(audio);
        }
        if let Some(img) = image_name {
            stage_json["image"] = serde_json::Value::String(img);
        }
        if stage.ok_li_offset != -1 {
            let a_idx = action_offset_to_idx[&stage.ok_li_offset];
            stage_json["okTransition"] = serde_json::json!({
                "actionNode": format!("action-{}", a_idx + 1),
                "optionIndex": stage.ok_selected
            });
        }
        if stage.home_li_offset != -1 {
            let a_idx = action_offset_to_idx[&stage.home_li_offset];
            stage_json["homeTransition"] = serde_json::json!({
                "actionNode": format!("action-{}", a_idx + 1),
                "optionIndex": stage.home_selected
            });
        }
        stage_nodes_json.push(stage_json);
    }

    let story_json = serde_json::json!({
        "title": fallback_title,
        "version": version,
        "description": "",
        "format": "studio-import",
        "factoryDisabled": factory_disabled,
        "nightModeAvailable": night_mode,
        "actionNodes": action_nodes_json,
        "stageNodes": stage_nodes_json,
    });

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
    Ok(())
}
