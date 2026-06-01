use uuid::Uuid;

use super::super::{
    display_label, normalize_document_for_studio_compat, reorder_document_for_display,
    validate_document_for_studio_compat, ActionNode, ControlSettings, NativeAssetPreparationReport,
    StageNode, StoryDocument, Transition,
};
use super::{menu::*, story::*, transitions::*};

pub(in crate::native_pack) struct StoryBuilder<'a> {
    pub(in crate::native_pack::builder) report: &'a NativeAssetPreparationReport,
    pub(in crate::native_pack::builder) action_nodes: Vec<ActionNode>,
    pub(in crate::native_pack::builder) stage_nodes: Vec<StageNode>,
    pub(in crate::native_pack::builder) root_action_id: Option<String>,
    pub(in crate::native_pack::builder) night_bridge_cache:
        std::collections::HashMap<String, Transition>,
    pub(in crate::native_pack::builder) menu_prealloc:
        std::collections::HashMap<String, MenuPrealloc>,
    pub(in crate::native_pack::builder) story_prealloc:
        std::collections::HashMap<String, StoryPrealloc>,
}

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack) fn new(report: &'a NativeAssetPreparationReport) -> Self {
        Self {
            report,
            action_nodes: Vec::new(),
            stage_nodes: Vec::new(),
            root_action_id: None,
            night_bridge_cache: std::collections::HashMap::new(),
            menu_prealloc: std::collections::HashMap::new(),
            story_prealloc: std::collections::HashMap::new(),
        }
    }

    pub(in crate::native_pack) fn build(&mut self) -> Result<StoryDocument, String> {
        let project = &self.report.project;
        let project_name = display_label(&project.name, "Story Studio");
        let cover_audio = self.asset_name("rootAudio")?;
        let cover_image = self.asset_name("rootImage")?;
        let cover_stage_id = self.next_id();
        let root_action_id = self.next_id();
        self.root_action_id = Some(root_action_id.clone());
        self.night_bridge_cache.clear();

        // Pré-alloue les action node IDs de tous les menus pour que returnAfterPlay
        // puisse référencer n'importe quel menu indépendamment de l'ordre de build.
        preallocate_menus(&project.entries, &root_action_id, &mut self.menu_prealloc);
        // Pré-alloue les play stage IDs de toutes les histoires pour les transitions story→story.
        preallocate_story_play_stages(&project.entries, &mut self.story_prealloc);
        preallocate_story_approach_transitions(
            &project.entries,
            &root_action_id,
            &self.menu_prealloc,
            &mut self.story_prealloc,
        );

        let root_targets = if project.project_type == "simple" {
            vec![self.build_simple_story(project, &root_action_id)?]
        } else {
            self.build_root_entries(&project.entries, &root_action_id)?
        };

        if root_targets.is_empty() {
            return Err("Aucune entree native construite pour le projet.".to_string());
        }

        self.action_nodes.push(ActionNode {
            id: root_action_id.clone(),
            name: action_node_name(),
            options: root_targets,
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: cover_stage_id,
            name: "Cover node".to_string(),
            stage_type: "stage".to_string(),
            square_one: true,
            audio: Some(cover_audio),
            image: Some(cover_image),
            control_settings: ControlSettings {
                wheel: true,
                ok: true,
                home: false,
                pause: false,
                autoplay: false,
            },
            home_transition: None,
            ok_transition: Some(Transition {
                action_node: root_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });

        let mut document = StoryDocument {
            title: project_name,
            version: project.pack_version,
            description: project.pack_description.clone(),
            format: "v1".to_string(),
            night_mode_available: project.options.night_mode,
            action_nodes: std::mem::take(&mut self.action_nodes),
            stage_nodes: std::mem::take(&mut self.stage_nodes),
        };
        normalize_document_for_studio_compat(&mut document);
        reorder_document_for_display(&mut document);
        validate_document_for_studio_compat(&document)?;
        Ok(document)
    }

    pub(in crate::native_pack::builder) fn asset_name(&self, role: &str) -> Result<String, String> {
        self.report
            .assets
            .iter()
            .find(|asset| asset.role == role)
            .map(|asset| asset.staged_asset_name.clone())
            .ok_or_else(|| format!("Asset prepare introuvable pour le role {}", role))
    }

    pub(in crate::native_pack::builder) fn next_id(&self) -> String {
        Uuid::new_v4().to_string()
    }
}
