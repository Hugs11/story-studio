//! Use the strict production builder with supplied media, without I/O.
use super::{reconstruct, Recipe};
use crate::domain::project::Project;
use crate::native_pack::assets::pipeline::collect_asset_requests;
use crate::native_pack::{
    build_story_document, canonicalize_project, NativeAssetPreparationReport, NativeAssetStats,
    PreparedAsset, StoryDocument,
};
use std::collections::HashMap;

pub(crate) fn build_role_model(
    recipe: &Recipe,
) -> Option<(StoryDocument, HashMap<String, String>)> {
    let project = reconstruct(recipe, |role| Some(format!("recipe-role/{role}"))).ok()?;
    let roles = collect_asset_requests(&canonicalize_project(&project), 0.0, 0.0)
        .into_iter()
        .map(|request| {
            let role = request.source_path.strip_prefix("recipe-role/")?.to_owned();
            Some((request.source_path, role))
        })
        .collect::<Option<HashMap<_, _>>>()?;
    Some((build_project_model(&project)?, roles))
}

pub(crate) fn build_project_model(project: &Project) -> Option<StoryDocument> {
    let project = canonicalize_project(project);
    let mut assets = Vec::new();
    for request in collect_asset_requests(&project, 0.0, 0.0) {
        assets.push(PreparedAsset {
            role: request.role,
            staged_asset_name: request.source_path.clone(),
            source_path: request.source_path,
            source_kind: "recipe".into(),
            staged_asset_path: String::new(),
            transformed: false,
            deduplicated: false,
        });
    }
    let report = NativeAssetPreparationReport {
        project,
        pack_uuid: String::new(),
        stage_dir: String::new(),
        assets_dir: String::new(),
        assets,
        imported_zips: vec![],
        stats: NativeAssetStats {
            requested_asset_count: 0,
            unique_asset_count: 0,
            transformed_audio_count: 0,
            imported_zip_count: 0,
        },
        notes: vec![],
        warnings: vec![],
        for_simulation: false,
    };
    build_story_document(&report).ok()
}
