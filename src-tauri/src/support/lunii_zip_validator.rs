use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;

#[derive(Debug, Clone, Serialize)]
pub struct ValidationIssue {
    pub severity: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LuniiZipValidationReport {
    pub zip_path: String,
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
}

fn err(code: &str, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        severity: "error".into(),
        code: code.into(),
        message: message.into(),
    }
}

fn warn(code: &str, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        severity: "warning".into(),
        code: code.into(),
        message: message.into(),
    }
}

pub fn validate_lunii_zip(zip_path: &str) -> LuniiZipValidationReport {
    let mut issues = Vec::new();

    let file = match std::fs::File::open(zip_path) {
        Ok(f) => f,
        Err(e) => {
            return fatal(
                zip_path,
                "ZIP_OPEN_FAILED",
                format!("Impossible d'ouvrir le ZIP : {}", e),
            )
        }
    };

    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            return fatal(
                zip_path,
                "ZIP_INVALID",
                format!("Archive ZIP invalide : {}", e),
            )
        }
    };

    // Collect all non-directory entry names
    let mut names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            if !entry.is_dir() {
                names.push(entry.name().to_string());
            }
        }
    }

    // ── 1. story.json présent ────────────────────────────────────────────────
    if !names.iter().any(|n| n == "story.json") {
        issues.push(err(
            "MISSING_STORY_JSON",
            "story.json absent de la racine du ZIP.",
        ));
        return report(zip_path, issues);
    }

    // ── 2. Lecture et parsing story.json ─────────────────────────────────────
    let story_str = {
        let mut entry = match archive.by_name("story.json") {
            Ok(e) => e,
            Err(e) => {
                return fatal(
                    zip_path,
                    "STORY_JSON_READ_ERROR",
                    format!("Lecture story.json impossible : {}", e),
                )
            }
        };
        let mut s = String::new();
        if let Err(e) = entry.read_to_string(&mut s) {
            return fatal(
                zip_path,
                "STORY_JSON_READ_ERROR",
                format!("Lecture story.json impossible : {}", e),
            );
        }
        s
    };

    let story: serde_json::Value = match serde_json::from_str(&story_str) {
        Ok(v) => v,
        Err(e) => {
            issues.push(err(
                "STORY_JSON_INVALID",
                format!("story.json JSON invalide : {}", e),
            ));
            return report(zip_path, issues);
        }
    };

    // ── 3. Champs obligatoires ────────────────────────────────────────────────
    for field in &["format", "version", "title", "stageNodes", "actionNodes"] {
        if story.get(field).is_none() {
            issues.push(err(
                &format!("MISSING_FIELD_{}", field.to_uppercase()),
                format!("Champ obligatoire manquant dans story.json : '{}'", field),
            ));
        }
    }

    // ── 4. Champ format (ex: "v1") ────────────────────────────────────────────
    if let Some(fmt) = story.get("format").and_then(|v| v.as_str()) {
        let tail = fmt.strip_prefix('v').unwrap_or("");
        if tail.is_empty() || tail.parse::<u32>().is_err() {
            issues.push(err(
                "INVALID_FORMAT_FIELD",
                format!(
                    "Champ 'format' invalide : '{}' (attendu : 'v1', 'v2', …)",
                    fmt
                ),
            ));
        }
    }

    // ── 5. Index des assets présents dans le ZIP ──────────────────────────────
    let zip_assets: HashSet<String> = names
        .iter()
        .filter(|n| n.starts_with("assets/"))
        .map(|n| n[7..].to_string())
        .collect();

    if zip_assets.is_empty() {
        issues.push(warn(
            "NO_ASSETS_DIR",
            "Aucun fichier dans assets/ — le ZIP semble vide.",
        ));
    }

    // ── 6. Validation stageNodes ──────────────────────────────────────────────
    let mut referenced_audio: Vec<String> = Vec::new();

    if let Some(nodes) = story.get("stageNodes").and_then(|v| v.as_array()) {
        for (i, node) in nodes.iter().enumerate() {
            let id = node.get("uuid").and_then(|v| v.as_str()).unwrap_or("?");

            if node.get("uuid").and_then(|v| v.as_str()).is_none() {
                issues.push(err(
                    "SNODE_MISSING_UUID",
                    format!("stageNodes[{i}] : 'uuid' manquant."),
                ));
            }

            match node.get("audio") {
                None => issues.push(err(
                    "SNODE_MISSING_AUDIO",
                    format!("stageNodes[{i}] ({id}) : 'audio' manquant."),
                )),
                Some(value) if value.is_null() => {}
                Some(value) => {
                    let Some(audio) = value.as_str() else {
                        issues.push(err(
                            "SNODE_INVALID_AUDIO",
                            format!(
                                "stageNodes[{i}] ({id}) : 'audio' doit etre une chaine ou null."
                            ),
                        ));
                        continue;
                    };
                    if audio.is_empty() {
                        continue;
                    }
                    if !zip_assets.contains(audio) {
                        issues.push(err(
                            "MISSING_AUDIO_ASSET",
                            format!("stageNodes[{i}] ({id}) : assets/{audio} absent du ZIP."),
                        ));
                    } else {
                        referenced_audio.push(audio.to_string());
                    }
                }
            }

            if let Some(image) = node.get("image").and_then(|v| v.as_str()) {
                if !image.is_empty() && !zip_assets.contains(image) {
                    issues.push(err(
                        "MISSING_IMAGE_ASSET",
                        format!("stageNodes[{i}] ({id}) : assets/{image} absent du ZIP."),
                    ));
                }
            }

            if let Some(cs) = node.get("controlSettings") {
                for ctrl in &["wheel", "ok", "home", "pause", "autoplay"] {
                    if cs.get(ctrl).is_none() {
                        issues.push(warn(
                            "SNODE_MISSING_CONTROL",
                            format!("stageNodes[{i}] ({id}) controlSettings : '{ctrl}' manquant."),
                        ));
                    }
                }
            } else {
                issues.push(err(
                    "SNODE_MISSING_CONTROL_SETTINGS",
                    format!("stageNodes[{i}] ({id}) : 'controlSettings' manquant."),
                ));
            }
        }
    }

    // ── 7. Validation actionNodes ─────────────────────────────────────────────
    if let Some(nodes) = story.get("actionNodes").and_then(|v| v.as_array()) {
        for (i, node) in nodes.iter().enumerate() {
            if node.get("id").and_then(|v| v.as_str()).is_none() {
                issues.push(err(
                    "ANODE_MISSING_ID",
                    format!("actionNodes[{i}] : 'id' manquant."),
                ));
            }
            if node.get("options").and_then(|v| v.as_array()).is_none() {
                issues.push(err(
                    "ANODE_MISSING_OPTIONS",
                    format!("actionNodes[{i}] : 'options' manquant."),
                ));
            }
        }
    }

    // ── 8. Vérification headers MP3 ───────────────────────────────────────────
    for audio_name in &referenced_audio {
        let zip_entry_name = format!("assets/{}", audio_name);
        let bytes = {
            let mut entry = match archive.by_name(&zip_entry_name) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let mut buf = Vec::new();
            if entry.read_to_end(&mut buf).is_err() {
                continue;
            }
            buf
        };
        check_mp3_headers(&bytes, audio_name, &mut issues);
    }

    report(zip_path, issues)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn fatal(zip_path: &str, code: &str, message: String) -> LuniiZipValidationReport {
    LuniiZipValidationReport {
        zip_path: zip_path.to_string(),
        valid: false,
        issues: vec![err(code, message)],
    }
}

fn report(zip_path: &str, issues: Vec<ValidationIssue>) -> LuniiZipValidationReport {
    let valid = !issues.iter().any(|i| i.severity == "error");
    LuniiZipValidationReport {
        zip_path: zip_path.to_string(),
        valid,
        issues,
    }
}

// ── Analyse des headers MPEG ──────────────────────────────────────────────────

fn check_mp3_headers(bytes: &[u8], name: &str, issues: &mut Vec<ValidationIssue>) {
    if bytes.len() < 10 {
        issues.push(err(
            "AUDIO_TOO_SHORT",
            format!("{name} : fichier audio trop court."),
        ));
        return;
    }

    let Some(offset) = find_mpeg_sync(bytes) else {
        issues.push(warn(
            "AUDIO_NO_MPEG_FRAME",
            format!("{name} : aucun frame MPEG trouvé."),
        ));
        return;
    };

    if offset + 4 > bytes.len() {
        return;
    }

    let h = &bytes[offset..offset + 4];

    // h[1]: 111VVLLP  VV=version LL=layer P=protection
    // h[2]: BBBBSSXP  SS=sample rate index
    // h[3]: CCEEOCII  CC=channel mode
    let mpeg_version = (h[1] >> 3) & 0x03; // 3=MPEG1
    let _layer = (h[1] >> 1) & 0x03; // 1=Layer3
    let sample_rate_index = (h[2] >> 2) & 0x03;
    let channel_mode = (h[3] >> 6) & 0x03; // 3=mono

    // Sample rate
    let sample_rate: Option<u32> = match (mpeg_version, sample_rate_index) {
        (3, 0) => Some(44100),
        (3, 1) => Some(48000),
        (3, 2) => Some(32000),
        (2, 0) => Some(22050),
        (2, 1) => Some(24000),
        (2, 2) => Some(16000),
        _ => None,
    };
    if let Some(sr) = sample_rate {
        if sr != 44100 {
            issues.push(err(
                "AUDIO_WRONG_SAMPLE_RATE",
                format!("{name} : sample rate {sr}Hz (attendu 44100Hz)."),
            ));
        }
    }

    // Canal
    if channel_mode != 3 {
        let mode = match channel_mode {
            0 => "stereo",
            1 => "joint stereo",
            2 => "dual channel",
            _ => "?",
        };
        issues.push(err(
            "AUDIO_NOT_MONO",
            format!("{name} : audio {mode} (attendu mono)."),
        ));
    }
}

/// Trouve le premier mot de synchronisation MPEG (0xFF suivi de 0xEx ou 0xFx),
/// en sautant le tag ID3v2 s'il est présent.
fn find_mpeg_sync(bytes: &[u8]) -> Option<usize> {
    let start = if bytes.starts_with(b"ID3") && bytes.len() >= 10 {
        // Taille syncsafe sur 4 octets (bits 7 ignorés)
        let size = ((bytes[6] as usize) << 21)
            | ((bytes[7] as usize) << 14)
            | ((bytes[8] as usize) << 7)
            | (bytes[9] as usize);
        10 + size
    } else {
        0
    };

    let search = bytes.get(start..)?;
    for i in 0..search.len().saturating_sub(1) {
        if search[i] == 0xFF && (search[i + 1] & 0xE0) == 0xE0 {
            return Some(start + i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::validate_lunii_zip;

    #[test]
    fn explicit_null_audio_is_valid_but_missing_audio_field_is_not() {
        let dir = std::env::temp_dir().join(format!(
            "story_studio_lunii_zip_validator_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("current time")
                .as_nanos(),
        ));
        fs::create_dir_all(&dir).expect("create temp dir");

        let explicit_null_path = dir.join("explicit-null.zip");
        write_stage_zip(&explicit_null_path, true);
        let explicit_null_report = validate_lunii_zip(&explicit_null_path.to_string_lossy());
        for code in [
            "SNODE_MISSING_AUDIO",
            "SNODE_INVALID_AUDIO",
            "MISSING_AUDIO_ASSET",
        ] {
            assert!(
                !explicit_null_report
                    .issues
                    .iter()
                    .any(|issue| issue.code == code),
                "{code} ne doit pas signaler audio: null: {:?}",
                explicit_null_report.issues
            );
        }

        let missing_audio_path = dir.join("missing-audio.zip");
        write_stage_zip(&missing_audio_path, false);
        let missing_audio_report = validate_lunii_zip(&missing_audio_path.to_string_lossy());
        assert!(
            missing_audio_report
                .issues
                .iter()
                .any(|issue| issue.code == "SNODE_MISSING_AUDIO"),
            "audio absent doit rester invalide: {:?}",
            missing_audio_report.issues
        );

        fs::remove_dir_all(dir).expect("cleanup temp dir");
    }

    fn write_stage_zip(path: &std::path::Path, include_audio_field: bool) {
        let mut stage = serde_json::json!({
            "uuid": "title",
            "name": "Titre silencieux",
            "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": true,
                "pause": false,
                "autoplay": false
            }
        });
        if include_audio_field {
            stage["audio"] = serde_json::Value::Null;
        }
        let story = serde_json::json!({
            "format": "v1",
            "version": 1,
            "title": "Test",
            "stageNodes": [stage],
            "actionNodes": []
        });

        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file("story.json", options)
            .expect("start story");
        writer
            .write_all(
                serde_json::to_string(&story)
                    .expect("serialize story")
                    .as_bytes(),
            )
            .expect("write story");
        writer.finish().expect("finish zip");
    }
}
