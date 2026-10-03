//! Vérification d'intégrité de la famille B (graphes synthétiques).
//!
//! Les graphes synthétiques sont construits par
//! un script externe de génération de cas et empaquetés directement
//! depuis leur `StoryDocument` : ils n'ont aucun ZIP d'import, et rien ne passe par
//! `ProjectEntry` ni par `StoryBuilder`.
//!
//! Ce point d'entrée vérifie l'intégrité interne de chaque cas. C'est un contrôle
//! de la batterie, sous `#[cfg(test)]`, pas un validateur de production. Le
//! verdict de `validate_document_for_studio_compat` est relevé comme
//! **diagnostic** et n'ouvre ni ne ferme aucune porte : le contrôle de structure
//! est hors critère d'interopérabilité.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::native_pack::{
    normalize_document_for_studio_compat, validate_document_for_studio_compat, StoryDocument,
};
use crate::services::pack_reader::load_pack_zip;

use super::family_a::{cycle_metrics, resolved_edges};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseRecord {
    pack_id: String,
    title: String,
    source_zip: PathBuf,
    source_zip_sha256: String,
    declared_stage_count: usize,
    declared_action_count: usize,
    declared_night_mode: bool,
    declared_asset_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrityRow {
    schema_version: u32,
    pack_id: String,
    title: String,
    source_zip: String,
    source_zip_sha256: String,
    stage_count: usize,
    action_count: usize,
    square_one_count: usize,
    night_mode_available: bool,
    asset_entry_count: usize,
    referenced_asset_count: usize,
    cyclic: bool,
    cyclic_stage_count: usize,
    cyclic_component_count: usize,
    self_loop_count: usize,
    non_uuid_stage_ids: Vec<String>,
    /// Manquements à l'intégrité interne. Une seule ligne non vide fait échouer le
    /// test : un cas synthétique incohérent ne mesure rien.
    integrity_issues: Vec<String>,
    /// Diagnostic : le validateur STUdio existant accepte-t-il le document **sans**
    /// normalisation ? Le normaliseur ne doit jamais être appliqué aux éditions
    /// de l'utilisateur ; ce compte dit si la surface MVP en aurait besoin.
    studio_compat_before_normalization: bool,
    studio_compat_before_message: Option<String>,
    studio_compat_after_normalization: bool,
    studio_compat_after_message: Option<String>,
    normalized_ok_forced: usize,
    normalized_home_forced: usize,
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("ouverture impossible {} : {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 64];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("lecture impossible {} : {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Noms de fichiers présents sous `assets/` dans le ZIP soumis.
fn zip_asset_names(path: &Path) -> Result<HashSet<String>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("ouverture impossible {} : {error}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("ZIP illisible {} : {error}", path.display()))?;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("entrée {index} illisible : {error}"))?;
        let name = entry.name().to_string();
        if let Some(stripped) = name.strip_prefix("assets/") {
            if !stripped.is_empty() {
                names.insert(stripped.to_string());
            }
        }
    }
    Ok(names)
}

/// Intégrité interne d'un `StoryDocument` synthétique, au sens suivant :
/// identifiants uniques et valides, exactement un `squareOne`, aucune référence
/// pendante, `optionIndex` dans les bornes, cohérence transition/contrôles.
fn integrity_issues(document: &StoryDocument, assets_in_zip: &HashSet<String>) -> Vec<String> {
    let mut issues = Vec::new();

    let mut seen_stage_ids = HashSet::new();
    for stage in &document.stage_nodes {
        if !seen_stage_ids.insert(stage.uuid.as_str()) {
            issues.push(format!("identifiant de stage dupliqué : {}", stage.uuid));
        }
        if uuid::Uuid::parse_str(&stage.uuid).is_err() {
            issues.push(format!("identifiant de stage non UUID : {}", stage.uuid));
        }
    }
    let mut seen_action_ids = HashSet::new();
    for action in &document.action_nodes {
        if !seen_action_ids.insert(action.id.as_str()) {
            issues.push(format!("identifiant d'action dupliqué : {}", action.id));
        }
    }

    let square_one = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.is_square_one())
        .count();
    if square_one != 1 {
        issues.push(format!("squareOne présent {square_one} fois, attendu 1"));
    }

    let actions: HashMap<&str, &Vec<Option<String>>> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), &action.options))
        .collect();
    for action in &document.action_nodes {
        for (position, option) in action.options.iter().enumerate() {
            let option = option.as_deref().unwrap_or_default();
            if !seen_stage_ids.contains(option) {
                issues.push(format!(
                    "action {} option {position} pointe vers un stage inexistant {option}",
                    action.id
                ));
            }
        }
    }

    for stage in &document.stage_nodes {
        for (label, transition) in [
            ("okTransition", stage.ok_transition.value()),
            ("homeTransition", stage.home_transition.value()),
        ] {
            let Some(transition) = transition else {
                continue;
            };
            let Some(options) = actions.get(transition.action_node.as_str()) else {
                issues.push(format!(
                    "stage {} : {label} désigne une action inexistante {}",
                    stage.uuid, transition.action_node
                ));
                continue;
            };
            // `< -1` n'est plus représentable : `OptionSelection` le refuse au
            // décodage. Reste la borne des options, qui vaut aussi pour une
            // sélection aléatoire sur une Action sans option.
            if !transition.selection.is_within_bounds(options.len()) {
                issues.push(format!(
                    "stage {} : {label} a une sélection {} hors des {} options",
                    stage.uuid,
                    transition.selection,
                    options.len()
                ));
            }
        }

        // Cohérence transition / contrôles : une transition déclarée doit exposer son
        // port. C'est la condition que le normaliseur force en mode canonique (le
        // normaliseur ne s'applique jamais aux éditions de l'utilisateur) ; un
        // cas synthétique doit donc la satisfaire par construction.
        if stage.ok_transition.is_value()
            && !stage.control_settings.ok()
            && !stage.control_settings.autoplay()
        {
            issues.push(format!(
                "stage {} : okTransition déclarée sans port ok ni autoplay",
                stage.uuid
            ));
        }
        if stage.home_transition.is_value() && !stage.control_settings.home() {
            issues.push(format!(
                "stage {} : homeTransition déclarée sans port home",
                stage.uuid
            ));
        }

        for (label, media) in [
            ("image", stage.image.value()),
            ("audio", stage.audio.value()),
        ] {
            if let Some(name) = media {
                if !assets_in_zip.contains(name.as_str()) {
                    issues.push(format!(
                        "stage {} : {label} {name} absent des assets du ZIP",
                        stage.uuid
                    ));
                }
            }
        }
    }

    issues
}

fn normalization_deltas(document: &StoryDocument) -> (usize, usize) {
    let mut normalized = document.clone();
    normalize_document_for_studio_compat(&mut normalized);
    let ok_forced = document
        .stage_nodes
        .iter()
        .zip(normalized.stage_nodes.iter())
        .filter(|(before, after)| !before.control_settings.ok() && after.control_settings.ok())
        .count();
    let home_forced = document
        .stage_nodes
        .iter()
        .zip(normalized.stage_nodes.iter())
        .filter(|(before, after)| !before.control_settings.home() && after.control_settings.home())
        .count();
    (ok_forced, home_forced)
}

#[test]
#[ignore = "batterie famille B explicite : demande les ZIP synthétiques déjà générés"]
fn verify_family_b_sources() {
    let work_dir = std::env::var_os("STORY_STUDIO_D0B_FAMILY_B_WORK_DIR")
        .map(PathBuf::from)
        .expect("STORY_STUDIO_D0B_FAMILY_B_WORK_DIR requis");
    let cases_path = work_dir.join("cas.jsonl");
    let content = fs::read_to_string(&cases_path)
        .unwrap_or_else(|error| panic!("{} : {error}", cases_path.display()));
    let cases: Vec<CaseRecord> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("ligne de cas"))
        .collect();
    assert!(!cases.is_empty(), "batterie vide");

    let mut rows = Vec::with_capacity(cases.len());
    let mut broken = Vec::new();
    for case in &cases {
        let digest = sha256_file(&case.source_zip).expect("sha256 du ZIP");
        assert_eq!(
            digest, case.source_zip_sha256,
            "{} : le ZIP a changé depuis la génération",
            case.pack_id
        );
        let assets = zip_asset_names(&case.source_zip).expect("assets du ZIP");
        let story = load_pack_zip(case.source_zip.to_string_lossy().as_ref())
            .unwrap_or_else(|error| panic!("{} : story.json : {error}", case.pack_id));
        let document: StoryDocument = serde_json::from_str(&story)
            .unwrap_or_else(|error| panic!("{} : StoryDocument : {error}", case.pack_id));

        assert_eq!(
            document.stage_nodes.len(),
            case.declared_stage_count,
            "{} : compte de stages déclaré",
            case.pack_id
        );
        assert_eq!(
            document.action_nodes.len(),
            case.declared_action_count,
            "{} : compte d'actions déclaré",
            case.pack_id
        );
        assert_eq!(
            document.night_mode_available.is_true(),
            case.declared_night_mode,
            "{} : nightModeAvailable déclaré",
            case.pack_id
        );
        assert_eq!(
            assets.len(),
            case.declared_asset_count,
            "{} : compte d'assets déclaré",
            case.pack_id
        );

        let issues = integrity_issues(&document, &assets);
        if !issues.is_empty() {
            broken.push(case.pack_id.clone());
        }
        let (ok_forced, home_forced) = normalization_deltas(&document);
        let before = validate_document_for_studio_compat(&document);
        let mut normalized = document.clone();
        normalize_document_for_studio_compat(&mut normalized);
        let after = validate_document_for_studio_compat(&normalized);

        let edges = resolved_edges(&document);
        let (cyclic, cyclic_stage_count, cyclic_component_count, self_loop_count) =
            cycle_metrics(&edges);
        let referenced = document
            .stage_nodes
            .iter()
            .flat_map(|stage| {
                [
                    stage.image.as_deref().map(str::to_string),
                    stage.audio.as_deref().map(str::to_string),
                ]
            })
            .flatten()
            .collect::<HashSet<_>>();

        println!(
            "{} : {} stages, {} actions, cyclique={}, self-loops={}, intégrité={}, \
             studioCompat={}",
            case.pack_id,
            document.stage_nodes.len(),
            document.action_nodes.len(),
            cyclic,
            self_loop_count,
            if issues.is_empty() {
                "OK".to_string()
            } else {
                issues.join(" | ")
            },
            before.is_ok(),
        );

        rows.push(IntegrityRow {
            schema_version: 1,
            pack_id: case.pack_id.clone(),
            title: case.title.clone(),
            source_zip: case.source_zip.display().to_string(),
            source_zip_sha256: digest,
            stage_count: document.stage_nodes.len(),
            action_count: document.action_nodes.len(),
            square_one_count: document
                .stage_nodes
                .iter()
                .filter(|stage| stage.is_square_one())
                .count(),
            night_mode_available: document.night_mode_available.is_true(),
            asset_entry_count: assets.len(),
            referenced_asset_count: referenced.len(),
            cyclic,
            cyclic_stage_count,
            cyclic_component_count,
            self_loop_count,
            non_uuid_stage_ids: document
                .stage_nodes
                .iter()
                .filter(|stage| uuid::Uuid::parse_str(&stage.uuid).is_err())
                .map(|stage| stage.uuid.clone())
                .collect(),
            integrity_issues: issues,
            studio_compat_before_normalization: before.is_ok(),
            studio_compat_before_message: before.err(),
            studio_compat_after_normalization: after.is_ok(),
            studio_compat_after_message: after.err(),
            normalized_ok_forced: ok_forced,
            normalized_home_forced: home_forced,
        });
    }

    let output = work_dir.join("integrite.jsonl");
    let mut lines = rows
        .iter()
        .map(|row| serde_json::to_string(row).expect("ligne JSON"))
        .collect::<Vec<_>>()
        .join("\n");
    lines.push('\n');
    fs::write(&output, lines).expect("écriture de integrite.jsonl");
    println!("{} cas -> {}", rows.len(), output.display());
    assert!(
        broken.is_empty(),
        "intégrité interne en défaut : {}",
        broken.join(", ")
    );
}
