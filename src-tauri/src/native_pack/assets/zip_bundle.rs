use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::super::simulation::SimulationMedia;
use super::super::{decode_story_document, ImportedZipBundle, PreparedAsset, StoryDocument};
use super::image::stage_binary_asset_bytes;
use crate::support::imported_pack::ensure_studio_pack_zip;

pub(crate) fn stage_imported_zip_bundle(
    role: &str,
    zip_path: &str,
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
) -> Result<(ImportedZipBundle, Vec<PreparedAsset>), String> {
    let imported = ensure_studio_pack_zip(zip_path)?;
    let zip_path_buf = imported.zip_path.clone();
    let zip_file =
        fs::File::open(&zip_path_buf).map_err(|e| format!("Ouverture ZIP impossible : {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    let mut story_json = String::new();
    archive
        .by_name("story.json")
        .map_err(|_| format!("story.json introuvable dans {}", zip_path_buf.display()))?
        .read_to_string(&mut story_json)
        .map_err(|e| format!("Lecture story.json impossible : {}", e))?;

    let decoded = decode_story_document(&story_json)
        .map_err(|error| format!("story.json import invalide : {error}"))?;
    let context = imported.conversion_context(&decoded.document);
    let decoded = decoded.with_conversion_context(context);
    decoded.context.log_warnings();
    let mut document = decoded.document;

    let (square_one_stage_id, root_action_id, post_root_stage_id) =
        imported_zip_anchors(&document, &zip_path_buf)?;
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
        if let Some(audio) = stage.audio.value_mut() {
            if let Some(mapped_audio) = asset_map.get(audio) {
                *audio = mapped_audio.clone();
            }
        }
        if let Some(image) = stage.image.value_mut() {
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

/// Les trois ancres qu'un pack importé doit porter pour être fusionné : son
/// Écran d'entrée, l'Action qui en part, et le premier Écran qu'elle atteint.
///
/// Partagées par l'étage de production et par la lecture d'écoute : les deux
/// doivent refuser exactement les mêmes archives, sinon une écoute réussirait
/// là où la production échoue.
fn imported_zip_anchors(
    document: &StoryDocument,
    zip_path_buf: &Path,
) -> Result<(String, String, String), String> {
    let square_one_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .ok_or_else(|| format!("ZIP importe sans squareOne : {}", zip_path_buf.display()))?;
    let square_one_stage_id = square_one_stage.uuid.clone();
    let root_action_id = square_one_stage
        .ok_transition
        .value()
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
        .option_target(0)
        .map(str::to_string)
        .ok_or_else(|| format!("Action racine vide dans {}", zip_path_buf.display()))?;
    Ok((square_one_stage_id, root_action_id, post_root_stage_id))
}

fn referenced_asset_names(document: &StoryDocument) -> Vec<String> {
    let mut assets = Vec::new();
    for stage in &document.stage_nodes {
        if let Some(audio) = stage.audio.value() {
            assets.push(audio.clone());
        }
        if let Some(image) = stage.image.value() {
            assets.push(image.clone());
        }
    }
    assets.sort();
    assets.dedup();
    assets
}

/// Lit un pack importé **pour l'écoute** : son document, sans extraire un seul
/// octet d'asset.
///
/// L'étage de production recopie chaque asset de l'archive sur le disque pour
/// le fusionner dans le pack final. Pour écouter, le lecteur sait déjà ouvrir
/// une archive (`get_pack_asset`) : les références sont donc simplement
/// renommées et pointées vers l'archive d'origine, et rien n'est écrit.
///
/// La conversion de conteneur (`ensure_studio_pack_zip`) reste nécessaire — un
/// `.7z` ne s'ouvre pas comme un zip — mais elle ne touche aucun média.
pub(crate) fn read_imported_zip_for_simulation(
    role: &str,
    entry_id: Option<&str>,
    zip_path: &str,
    name_offset: usize,
) -> Result<(ImportedZipBundle, Vec<SimulationMedia>), String> {
    let imported = ensure_studio_pack_zip(zip_path)?;
    let zip_path_buf = imported.zip_path.clone();
    let zip_file =
        fs::File::open(&zip_path_buf).map_err(|e| format!("Ouverture ZIP impossible : {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    let mut story_json = String::new();
    archive
        .by_name("story.json")
        .map_err(|_| format!("story.json introuvable dans {}", zip_path_buf.display()))?
        .read_to_string(&mut story_json)
        .map_err(|e| format!("Lecture story.json impossible : {}", e))?;

    let decoded = decode_story_document(&story_json)
        .map_err(|error| format!("story.json import invalide : {error}"))?;
    let context = imported.conversion_context(&decoded.document);
    let decoded = decoded.with_conversion_context(context);
    let mut document = decoded.document;

    let (square_one_stage_id, root_action_id, post_root_stage_id) =
        imported_zip_anchors(&document, &zip_path_buf)?;

    let zip_path_text = zip_path_buf.to_string_lossy().to_string();
    let mut media = Vec::new();
    let mut asset_map = HashMap::new();
    for (index, asset_name) in referenced_asset_names(&document).into_iter().enumerate() {
        let staged = format!("simzip{:06}_{}", name_offset + index, asset_name);
        media.push(SimulationMedia {
            asset_name: staged.clone(),
            role: format!("{} / imported {}", role, asset_name),
            // Tous les Écrans dépliés d'un pack importé appartiennent au nœud
            // qui le porte dans l'arbre : c'est lui que l'auteur voit.
            entry_id: entry_id.map(str::to_string),
            kind: "pack",
            path: None,
            zip_path: Some(zip_path_text.clone()),
            zip_asset_name: Some(format!("assets/{}", asset_name)),
        });
        asset_map.insert(asset_name, staged);
    }

    for stage in &mut document.stage_nodes {
        if let Some(audio) = stage.audio.value_mut() {
            if let Some(mapped) = asset_map.get(audio) {
                *audio = mapped.clone();
            }
        }
        if let Some(image) = stage.image.value_mut() {
            if let Some(mapped) = asset_map.get(image) {
                *image = mapped.clone();
            }
        }
    }

    Ok((
        ImportedZipBundle {
            role: role.to_string(),
            zip_path: zip_path_text,
            square_one_stage_id: square_one_stage_id.clone(),
            root_action_id,
            post_root_stage_id,
            entry_stage_id: square_one_stage_id,
            document,
        },
        media,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(path: &Path, story: &str) {
        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer
            .start_file("story.json", options)
            .expect("start story.json");
        writer
            .write_all(story.as_bytes())
            .expect("write story.json");
        writer.finish().expect("finish zip");
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "story_studio_a3_zip_bundle_{label}_{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn embedded_zip_uses_the_same_last_wins_decoder() {
        let dir = temp_dir("last_wins");
        let zip_path = dir.join("imported.zip");
        let assets_dir = dir.join("assets");
        fs::create_dir_all(&assets_dir).expect("create assets dir");
        write_zip(
            &zip_path,
            r#"{
              "title":"écartée","title":"retenue","version":1,"format":"v1",
              "stageNodes":[{
                "uuid":"entry","squareOne":true,"audio":null,"image":null,
                "controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":true},
                "okTransition":{"actionNode":"root","optionIndex":0},"homeTransition":null
              }],
              "actionNodes":[{"id":"root","options":["entry"]}]
            }"#,
        );

        let (bundle, prepared) = stage_imported_zip_bundle(
            "embedded",
            zip_path.to_str().expect("utf8"),
            &assets_dir,
            &mut HashMap::new(),
        )
        .expect("stage embedded zip");
        assert!(prepared.is_empty());
        assert_eq!(
            bundle.document.title.value().map(String::as_str),
            Some("retenue")
        );

        fs::remove_dir_all(dir).ok();
    }
}
