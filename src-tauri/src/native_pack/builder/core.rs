use uuid::Uuid;

use super::super::preparation::deterministic_stage_uuid;
use super::super::{
    display_label, named_option_targets, normalize_document_for_studio_compat,
    reorder_document_for_display, validate_document_for_studio_compat, ActionNode, ControlSettings,
    NativeAssetPreparationReport, Presence, StageNode, StoryDocument, Transition,
};
use super::refs::PendingRefOption;
use super::{menu::*, story::*, transitions::*};

pub(in crate::native_pack) struct StoryBuilder<'a> {
    pub(in crate::native_pack::builder) report: &'a NativeAssetPreparationReport,
    pub(in crate::native_pack::builder) action_nodes: Vec<ActionNode>,
    pub(in crate::native_pack::builder) stage_nodes: Vec<StageNode>,
    /// Identité d'auteur des Écrans, indépendante des fichiers dédupliqués.
    pub(in crate::native_pack) entry_id_by_stage: std::collections::HashMap<String, String>,
    pub(in crate::native_pack::builder) root_action_id: Option<String>,
    pub(in crate::native_pack::builder) night_bridge_cache:
        std::collections::HashMap<String, Transition>,
    pub(in crate::native_pack::builder) menu_prealloc:
        std::collections::HashMap<String, MenuPrealloc>,
    pub(in crate::native_pack::builder) story_prealloc:
        std::collections::HashMap<String, StoryPrealloc>,
    pub(in crate::native_pack::builder) pending_ref_options: Vec<PendingRefOption>,
    /// Actions de lecture émises pour un Écran combiné : utiles seulement si une
    /// transition les référence (`story_play:`), ce qu'on ne sait qu'une fois
    /// tout l'arbre construit.
    pub(in crate::native_pack::builder) combined_play_action_ids: Vec<String>,
    /// Identifiants de groupes enrichis déjà posés par un ZIP inclus : un autre
    /// ZIP qui réemploie le même identifiant reçoit le sien.
    pub(in crate::native_pack::builder) imported_group_ids: std::collections::HashSet<String>,
}

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack) fn new(report: &'a NativeAssetPreparationReport) -> Self {
        Self {
            report,
            action_nodes: Vec::new(),
            stage_nodes: Vec::new(),
            entry_id_by_stage: std::collections::HashMap::new(),
            root_action_id: None,
            night_bridge_cache: std::collections::HashMap::new(),
            menu_prealloc: std::collections::HashMap::new(),
            story_prealloc: std::collections::HashMap::new(),
            pending_ref_options: Vec::new(),
            combined_play_action_ids: Vec::new(),
            imported_group_ids: std::collections::HashSet::new(),
        }
    }

    pub(in crate::native_pack) fn build(&mut self) -> Result<StoryDocument, String> {
        let project = &self.report.project;
        let project_name = display_label(&project.name, "Story Studio");
        let cover_audio = self.asset_name("rootAudio")?;
        let cover_image = self.asset_name("rootImage")?;
        let cover_stage_id = self.entry_stage_id();
        let root_action_id = self.next_id();
        let shared_action_id = (!project.shared_entries.is_empty()).then(|| self.next_id());
        let shared_approach_action_ids: Vec<String> = project
            .shared_entries
            .iter()
            .map(|_| self.next_id())
            .collect();
        self.root_action_id = Some(root_action_id.clone());
        self.night_bridge_cache.clear();

        // Pré-alloue les action node IDs de tous les menus pour que returnAfterPlay
        // puisse référencer n'importe quel menu indépendamment de l'ordre de build.
        preallocate_menus(&project.entries, &root_action_id, &mut self.menu_prealloc);
        if let Some(action_id) = shared_action_id.as_deref() {
            preallocate_menus(&project.shared_entries, action_id, &mut self.menu_prealloc);
        }
        // Pré-alloue les play stage IDs de toutes les histoires pour les transitions story→story.
        preallocate_story_play_stages(
            &project.entries,
            project.options.auto_next,
            &mut self.story_prealloc,
        );
        preallocate_story_play_stages(
            &project.shared_entries,
            project.options.auto_next,
            &mut self.story_prealloc,
        );
        preallocate_story_approach_transitions(
            &project.entries,
            &root_action_id,
            &self.menu_prealloc,
            &mut self.story_prealloc,
        );
        if let Some(action_id) = shared_action_id.as_deref() {
            preallocate_story_approach_transitions(
                &project.shared_entries,
                action_id,
                &self.menu_prealloc,
                &mut self.story_prealloc,
            );
        }
        self.preallocate_shared_entry_approaches(
            &project.shared_entries,
            &shared_approach_action_ids,
        );

        let root_targets = if project.project_type == "simple" {
            vec![self.build_simple_story(project, &root_action_id)?]
        } else {
            self.build_root_entries(&project.entries, &root_action_id)?
        };

        if root_targets.is_empty() {
            return Err("Aucune entree native construite pour le projet.".to_string());
        }

        if let Some(action_id) = shared_action_id.as_deref() {
            let shared_targets = self.build_shared_entries(
                &project.shared_entries,
                action_id,
                &shared_approach_action_ids,
            )?;
            self.action_nodes.push(ActionNode {
                id: action_id.to_string(),
                name: action_node_name(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
                options: named_option_targets(shared_targets),
                position: no_authored_position(),
            });
        }

        self.action_nodes.push(ActionNode {
            id: root_action_id.clone(),
            name: action_node_name(),
            action_type: Presence::Absent,
            group_id: Presence::Absent,
            options: named_option_targets(root_targets),
            position: no_authored_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: cover_stage_id.clone(),
            name: Presence::Value("Cover node".to_string()),
            stage_type: default_stage_type(),
            square_one: Presence::Value(true),
            group_id: Presence::Absent,
            audio: Presence::Value(cover_audio),
            image: Presence::Value(cover_image),
            control_settings: Presence::Value(ControlSettings::authored(
                true, true, false, false, false,
            )),
            home_transition: Presence::Null,
            ok_transition: Presence::Value(Transition::fixed(root_action_id, 0)),
            position: no_authored_position(),
        });

        // Tout l'arbre est construit : les nœuds `ref` peuvent maintenant pointer vers
        // le vrai stage natif de leur cible (y compris les références « en avant »).
        self.resolve_pending_ref_options()?;
        self.drop_unreferenced_combined_play_actions();
        release_entry_identity(
            &mut self.stage_nodes,
            &mut self.action_nodes,
            &cover_stage_id,
        );

        // Le constructeur Libre choisit explicitement ces valeurs : ce sont des
        // présences d'auteur de son contrat, pas des replis de désérialisation.
        // `uuid` reste absent ici ; le writer le pose au moment d'écrire le pack.
        let mut document = StoryDocument {
            title: Presence::Value(project_name),
            version: Presence::Value(project.pack_version),
            description: Presence::Value(project.pack_description.clone()),
            format: Presence::Value("v1".to_string()),
            night_mode_available: Presence::Value(
                project.options.night_mode && !project.options.auto_next,
            ),
            uuid: Presence::Absent,
            factory_disabled: Presence::Absent,
            action_nodes: std::mem::take(&mut self.action_nodes),
            stage_nodes: std::mem::take(&mut self.stage_nodes),
        };
        normalize_document_for_studio_compat(&mut document);
        reorder_document_for_display(&mut document);
        validate_document_for_studio_compat(&document)?;
        Ok(document)
    }

    /// Un Écran combiné est la cible directe de sa liste : son Action de
    /// lecture ne sert que si une transition la référence. Orpheline, la
    /// readiness la refuserait (`ORPHAN_ACTION_AUTHORED_CONTENT`).
    fn drop_unreferenced_combined_play_actions(&mut self) {
        let combined = std::mem::take(&mut self.combined_play_action_ids);
        if combined.is_empty() {
            return;
        }
        let referenced: std::collections::HashSet<&str> = self
            .stage_nodes
            .iter()
            .flat_map(|stage| [stage.home_transition.value(), stage.ok_transition.value()])
            .flatten()
            .map(|transition| transition.action_node.as_str())
            .collect();
        let unreferenced: std::collections::HashSet<String> = combined
            .into_iter()
            .filter(|action_id| !referenced.contains(action_id.as_str()))
            .collect();
        self.action_nodes
            .retain(|action| !unreferenced.contains(&action.id));
    }

    pub(in crate::native_pack::builder) fn push_entry_stage(
        &mut self,
        entry_id: &str,
        stage: StageNode,
    ) {
        if self.report.for_simulation && !entry_id.is_empty() {
            self.entry_id_by_stage
                .insert(stage.uuid.clone(), entry_id.to_string());
        }
        self.stage_nodes.push(stage);
    }

    pub(in crate::native_pack::builder) fn asset_name(&self, role: &str) -> Result<String, String> {
        if let Some(asset) = self.report.assets.iter().find(|asset| asset.role == role) {
            return Ok(asset.staged_asset_name.clone());
        }
        // Écoute d'un projet en cours d'écriture : un média que l'auteur n'a pas
        // encore posé tient sa place au lieu d'arrêter la projection. Le lecteur
        // reconnaît ce nom et joue l'Écran en silence.
        //
        // **La production ne passe jamais ici** : elle ne pose pas ce drapeau,
        // et un média manquant y reste un refus. C'est la porte « éléments à
        // corriger » qui la protège en amont, et elle n'est pas déplacée.
        if self.report.for_simulation {
            return Ok(crate::native_pack::simulation::SIMULATION_MISSING_ASSET.to_string());
        }
        Err(format!("Asset prepare introuvable pour le role {}", role))
    }

    pub(in crate::native_pack::builder) fn next_id(&self) -> String {
        Uuid::new_v4().to_string()
    }

    /// L'UUID de l'Écran d'entrée est l'identité du pack sur l'appareil : les
    /// deux passerelles la lisent là, et ignorent le `uuid` de tête. Il
    /// reprend donc l'identité du projet, dans la graphie choisie, pour que deux
    /// exports du même projet remplacent le même pack.
    ///
    /// Sans identité — écoute, juge de fidélité —, aucun pack n'est livré et un
    /// UUID neuf suffit. La production refuse ce cas avant d'arriver ici.
    fn entry_stage_id(&self) -> String {
        let identity = self.report.pack_uuid.trim();
        if identity.is_empty() {
            self.next_id()
        } else {
            identity.to_string()
        }
    }
}

/// Rend l'identité du pack à l'Écran d'entrée seul.
///
/// STUdio fusionne sans le dire deux Écrans de même UUID. Aucun Écran Libre ne
/// reprend un identifiant existant — tous, y compris ceux d'un ZIP embarqué,
/// sont tirés à neuf —, la collision n'est donc qu'une garde. Si elle se
/// produit, l'autre Écran est renuméroté de façon déterministe, avec la
/// dérivation de l'export du graphe, et les options qui le visent le suivent :
/// aucune option Libre ne vise l'Écran d'entrée, elles ne sont pas ambiguës.
pub(in crate::native_pack) fn release_entry_identity(
    stage_nodes: &mut [StageNode],
    action_nodes: &mut [ActionNode],
    identity: &str,
) {
    let colliding = stage_nodes
        .iter()
        .position(|stage| stage.uuid == identity && !stage.is_square_one());
    let Some(index) = colliding else {
        return;
    };
    let used = stage_nodes
        .iter()
        .map(|stage| stage.uuid.clone())
        .collect::<std::collections::HashSet<_>>();
    let renamed = deterministic_stage_uuid(identity, identity, &used);
    stage_nodes[index].uuid = renamed.clone();
    for target in action_nodes
        .iter_mut()
        .flat_map(|action| action.options.iter_mut().flatten())
    {
        if target == identity {
            *target = renamed.clone();
        }
    }
}
