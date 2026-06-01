use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::super::{ImportedZipBundle, PreparedAsset, StoryDocument};
use super::image::stage_binary_asset_bytes;
use crate::support::imported_pack::ensure_studio_pack_zip;

pub(crate) fn stage_imported_zip_bundle(
    role: &str,
    zip_path: &str,
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
) -> Result<(ImportedZipBundle, Vec<PreparedAsset>), String> {
    let zip_path_buf = ensure_studio_pack_zip(zip_path)?;
    let zip_file =
        fs::File::open(&zip_path_buf).map_err(|e| format!("Ouverture ZIP impossible : {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    let mut story_json = String::new();
    archive
        .by_name("story.json")
        .map_err(|_| format!("story.json introuvable dans {}", zip_path_buf.display()))?
        .read_to_string(&mut story_json)
        .map_err(|e| format!("Lecture story.json impossible : {}", e))?;

    let mut document: StoryDocument = serde_json::from_str(&story_json)
        .map_err(|e| format!("story.json import invalide : {}", e))?;

    let square_one_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .ok_or_else(|| format!("ZIP importe sans squareOne : {}", zip_path_buf.display()))?;
    let square_one_stage_id = square_one_stage.uuid.clone();
    let root_action_id = square_one_stage
        .ok_transition
        .as_ref()
        .map(|transition| transition.action_node.clone())
        .ok_or_else(|| {
            format!(
                "ZIP importe sans action racine : {}",
                zip_path_buf.display()
            )
        })?;
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.id == root_action_id)
        .ok_or_else(|| format!("Action racine introuvable dans {}", zip_path_buf.display()))?;
    let post_root_stage_id = root_action
        .options
        .first()
        .cloned()
        .ok_or_else(|| format!("Action racine vide dans {}", zip_path_buf.display()))?;
    let entry_stage_id = square_one_stage_id.clone();

    let mut prepared_assets = Vec::new();
    let mut asset_map = HashMap::new();
    let referenced_assets = referenced_asset_names(&document);
    for asset_name in referenced_assets {
        let mut zip_entry = archive
            .by_name(&format!("assets/{}", asset_name))
            .map_err(|_| format!("Asset importe introuvable : {}", asset_name))?;
        let mut bytes = Vec::new();
        zip_entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Lecture asset importe impossible {} : {}", asset_name, e))?;

        let prepared = stage_binary_asset_bytes(
            &format!("{} / imported {}", role, asset_name),
            &asset_name,
            &bytes,
            assets_dir,
            seen_assets,
        )?;
        asset_map.insert(asset_name, prepared.staged_asset_name.clone());
        prepared_assets.push(prepared);
    }

    for stage in &mut document.stage_nodes {
        if let Some(audio) = stage.audio.as_mut() {
            if let Some(mapped_audio) = asset_map.get(audio) {
                *audio = mapped_audio.clone();
            }
        }
        if let Some(image) = stage.image.as_mut() {
            if let Some(mapped_image) = asset_map.get(image) {
                *image = mapped_image.clone();
            }
        }
    }

    Ok((
        ImportedZipBundle {
            role: role.to_string(),
            zip_path: zip_path_buf.to_string_lossy().to_string(),
            square_one_stage_id,
            root_action_id,
            post_root_stage_id,
            entry_stage_id,
            document,
        },
        prepared_assets,
    ))
}

fn referenced_asset_names(document: &StoryDocument) -> Vec<String> {
    let mut assets = Vec::new();
    for stage in &document.stage_nodes {
        if let Some(audio) = &stage.audio {
            assets.push(audio.clone());
        }
        if let Some(image) = &stage.image {
            assets.push(image.clone());
        }
    }
    assets.sort();
    assets.dedup();
    assets
}
