use super::*;
use crate::domain::project::{
    AudioFieldProcessing, EntryControlSettings, GlobalOptions, Project, ProjectEntry,
};
use crate::support::ffmpeg::now_millis;
use std::collections::HashMap;
use std::fs;
use std::io::Write;

fn simple_story_controls() -> ControlSettings {
    ControlSettings {
        wheel: false,
        ok: false,
        home: true,
        pause: true,
        autoplay: false,
    }
}

fn sample_options() -> GlobalOptions {
    GlobalOptions {
        harmonize_loudness: true,
        add_silence: false,
        silence_mode: None,
        add_silence_duration_sec: 1.0,
        auto_next: false,
        select_next: false,
        night_mode: false,
    }
}

fn story(name: &str) -> ProjectEntry {
    ProjectEntry {
        entry_type: "story".to_string(),
        name: name.to_string(),
        audio: Some("story.mp3".to_string()),
        item_audio: Some("item.mp3".to_string()),
        item_image: Some("item.png".to_string()),
        zip_path: None,
        ..ProjectEntry::default()
    }
}

fn prepared_asset(role: &str, staged_asset_name: &str) -> PreparedAsset {
    PreparedAsset {
        role: role.to_string(),
        source_path: format!("source/{}", staged_asset_name),
        source_kind: "test".to_string(),
        staged_asset_name: staged_asset_name.to_string(),
        staged_asset_path: format!("stage/{}", staged_asset_name),
        transformed: false,
        deduplicated: false,
    }
}

fn imported_zip_bundle(
    role: &str,
    square_one_stage_id: &str,
    root_action_id: &str,
    post_root_stage_id: &str,
    entry_stage_id: &str,
    document: StoryDocument,
) -> ImportedZipBundle {
    ImportedZipBundle {
        role: role.to_string(),
        zip_path: format!("fixtures/{}.zip", role.replace('/', "_")),
        square_one_stage_id: square_one_stage_id.to_string(),
        root_action_id: root_action_id.to_string(),
        post_root_stage_id: post_root_stage_id.to_string(),
        entry_stage_id: entry_stage_id.to_string(),
        document,
    }
}

fn report_for(
    project: CanonicalProject,
    assets: Vec<PreparedAsset>,
    imported_zips: Vec<ImportedZipBundle>,
) -> NativeAssetPreparationReport {
    NativeAssetPreparationReport {
        project,
        stage_dir: "stage".to_string(),
        assets_dir: "stage/assets".to_string(),
        assets,
        imported_zips,
        stats: NativeAssetStats {
            requested_asset_count: 0,
            unique_asset_count: 0,
            transformed_audio_count: 0,
            imported_zip_count: 0,
        },
        notes: Vec::new(),
    }
}

fn resolve_night_return_stage<'a>(
    document: &'a StoryDocument,
    play_stage: &StageNode,
) -> &'a StageNode {
    let night_entry_action_id = play_stage
        .ok_transition
        .as_ref()
        .map(|t| t.action_node.clone())
        .expect("play ok transition");
    let night_stage_id = document
        .action_nodes
        .iter()
        .find(|action| action.id == night_entry_action_id)
        .and_then(|action| action.options.first())
        .expect("night stage id")
        .clone();
    let night_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == night_stage_id)
        .expect("night stage");
    let return_transition = night_stage
        .ok_transition
        .as_ref()
        .expect("night return transition");
    let return_action = document
        .action_nodes
        .iter()
        .find(|action| action.id == return_transition.action_node)
        .expect("night return action");
    let return_stage_id = return_action
        .options
        .get(return_transition.option_index as usize)
        .expect("night return target")
        .clone();
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == return_stage_id)
        .expect("night return stage")
}

mod compat;
mod document_builder;
mod fidelity;
mod names_and_assets;
mod night_mode;
mod root_and_imports;
mod roundtrip;
