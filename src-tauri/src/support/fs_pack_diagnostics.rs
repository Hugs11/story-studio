//! Instrumentation diagnostique du lecteur de packs filesystem.
//!
//! Le lecteur `fs_pack_reader` normalise ou abandonne certaines informations en
//! construisant le `story.json` d'import. Ce module expose un observateur qui les
//! capture **sans changer le comportement de production** : la seule implémentation
//! compilée hors test est [`NoopObserver`], dont toutes les méthodes sont vides.
//!
//! Les questions mesurées :
//!
//! - **collisions d'offset** (`q1_collisions`) — deux transitions partagent-elles
//!   un `li_offset` avec des `option_count` différents ? Le lecteur déduplique sur
//!   le seul offset et retient le premier compte.
//! - **options perdues** (`q2_dropped_options`) — des options disparaissent-elles
//!   dans le `filter_map` de résolution ?
//! - **fidélité par transition** (`q3`) — chaque transition native est-elle
//!   reconstructible depuis le `StoryDocument` ?
//! - **valeurs de contrôle brutes** (`q4_raw_controls`) — une valeur brute de
//!   contrôle sort-elle de `{0, 1}` ?
//! - **identifiants non UUID** (`q6_non_uuid_stage_ids`) — combien
//!   d'identifiants de Stage produits ne sont pas des UUID valides ?
//!
//! La fidélité reste une vérification **par transition**, au niveau du tuple
//! `(offset, count, selected)` et de sa liste ordonnée de destinations. Un
//! comparateur structurel général de graphes n'a pas sa place ici.

// Hors test, seule `NoopObserver` est instanciée : elle ne consulte aucun de ces
// champs, qui sont donc morts pour le compilateur alors qu'ils portent toute la
// mesure. L'alternative — dupliquer le parseur `ni`/`li` dans un outil séparé —
// mesurerait une copie du lecteur au lieu du lecteur.
/// Déclencheur natif d'une transition.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Trigger {
    Ok,
    Home,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Trigger {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Home => "home",
        }
    }
}

/// Valeurs brutes des cinq contrôles d'un stage, avant conversion en booléens.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct RawControls {
    pub wheel: u16,
    pub ok: u16,
    pub home: u16,
    pub pause: u16,
    pub autoplay: u16,
}

#[cfg_attr(not(test), allow(dead_code))]
impl RawControls {
    /// Les cinq champs, dans l'ordre du nœud `ni`.
    pub(crate) fn fields(self) -> [(&'static str, u16); 5] {
        [
            ("wheel", self.wheel),
            ("ok", self.ok),
            ("home", self.home),
            ("pause", self.pause),
            ("autoplay", self.autoplay),
        ]
    }
}

/// Réutilisation d'un `li_offset` déjà rattaché à un ActionNode.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug)]
pub(crate) struct ActionOffsetReuse {
    pub li_offset: i32,
    pub first_option_count: i32,
    pub reused_option_count: i32,
    pub stage_index: usize,
    pub trigger: Trigger,
}

/// Une position d'option d'un ActionNode, telle que le lecteur l'a résolue.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug)]
pub(crate) struct OptionSlot {
    pub action_index: usize,
    pub li_offset: i32,
    pub option_position: usize,
    /// Valeur lue dans `li`, absente si la slice dépasse la table.
    pub li_slot: Option<i32>,
    /// Indice de stage retenu, absent si le lecteur a supprimé l'option.
    pub resolved_stage_index: Option<usize>,
}

/// Transition native écrite dans le `story.json`.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug)]
pub(crate) struct NativeTransition {
    pub stage_index: usize,
    pub trigger: Trigger,
    pub li_offset: i32,
    pub option_count: i32,
    pub selected: i32,
    pub action_index: usize,
}

/// Points d'observation du lecteur. Toutes les méthodes sont des no-op par défaut :
/// la production passe [`NoopObserver`] et le code généré est inchangé.
pub(crate) trait FsPackObserver {
    fn on_pack_header(&mut self, _pack_uuid: &str, _stage_count: usize, _node_size: usize) {}
    fn on_link_table(&mut self, _li: &[i32], _stage_count: usize) {}
    fn on_stage_controls(&mut self, _stage_index: usize, _raw: RawControls) {}
    fn on_stage_id(&mut self, _stage_index: usize, _stage_id: &str) {}
    fn on_action_offset_reuse(&mut self, _reuse: ActionOffsetReuse) {}
    fn on_option_slot(&mut self, _slot: OptionSlot) {}
    fn on_native_transition(&mut self, _transition: NativeTransition) {}
}

/// Observateur de production : ne mesure rien et ne coûte rien.
pub(crate) struct NoopObserver;

impl FsPackObserver for NoopObserver {}

#[cfg(test)]
pub(crate) use recording::{read_fs_pack_with_diagnostics, FsPackV1Report};

#[cfg(test)]
mod recording {
    use std::collections::BTreeMap;
    use std::path::Path;

    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    use super::{
        ActionOffsetReuse, FsPackObserver, NativeTransition, OptionSlot, RawControls, Trigger,
    };

    pub(crate) const REPORT_SCHEMA_VERSION: u32 = 1;

    /// Deux transitions partagent un `li_offset` avec des `option_count` différents.
    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Q1Collision {
        pub li_offset: i32,
        pub first_option_count: i32,
        pub reused_option_count: i32,
        pub stage_index: usize,
        pub trigger: String,
    }

    /// Option supprimée silencieusement pendant la résolution de `li`.
    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Q2DroppedOption {
        pub action_index: usize,
        pub li_offset: i32,
        pub option_position: usize,
        pub li_slot: Option<i32>,
        /// `sliceHorsTable` ou `stageHorsPlage`.
        pub cause: String,
    }

    /// Écart entre une transition native et sa reconstruction dans le document.
    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Q3Mismatch {
        pub stage_index: usize,
        pub trigger: String,
        pub li_offset: i32,
        /// Index de l'ActionNode auquel le lecteur a rattaché la transition : deux
        /// transitions qui le partagent signalent une fusion de slices.
        pub native_action_index: usize,
        pub kinds: Vec<String>,
        pub native_option_count: i32,
        pub document_option_count: Option<usize>,
        pub native_targets: Vec<Option<usize>>,
        pub document_targets: Vec<Option<usize>>,
        pub native_selected: i32,
        pub document_selected: Option<i64>,
        pub native_selected_target: Option<usize>,
        pub document_selected_target: Option<usize>,
    }

    #[derive(Clone, Debug, Default, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Q3Report {
        pub checked_transition_count: usize,
        pub mismatch_count: usize,
        pub mismatches: Vec<Q3Mismatch>,
    }

    /// Valeur brute de contrôle hors `{0, 1}`.
    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Q4RawControl {
        pub stage_index: usize,
        pub field: String,
        pub raw_value: u16,
    }

    /// Identifiant de Stage produit par le lecteur qui n'est pas un UUID.
    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Q6StageId {
        pub stage_index: usize,
        pub stage_id: String,
    }

    /// Sortie diagnostique pour un pack filesystem.
    ///
    /// Aucun champ ne dépend des UUID aléatoires produits par le lecteur : les
    /// destinations sont des **positions de stage**, et l'identifiant conservé pour les
    /// identifiants non UUID est celui que le lecteur dérive du nom de dossier.
    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct FsPackV1Report {
        pub schema_version: u32,
        pub pack_uuid: String,
        pub stage_count: usize,
        pub action_count: usize,
        pub li_int_count: usize,
        pub native_transition_count: usize,
        pub shared_offset_reuse_count: usize,
        pub q1_collision_count: usize,
        pub q1_collisions: Vec<Q1Collision>,
        pub q2_dropped_option_count: usize,
        pub q2_dropped_options: Vec<Q2DroppedOption>,
        pub q3: Q3Report,
        pub q4_out_of_range_count: usize,
        pub q4_raw_controls: Vec<Q4RawControl>,
        pub q6_non_uuid_count: usize,
        pub q6_non_uuid_stage_ids: Vec<Q6StageId>,
    }

    /// Collecteur branché sur les points d'observation du lecteur.
    #[derive(Debug, Default)]
    pub(crate) struct FsPackDiagnostics {
        pack_uuid: String,
        stage_count: usize,
        li: Vec<i32>,
        stage_ids: Vec<(usize, String)>,
        raw_controls: Vec<(usize, RawControls)>,
        reuses: Vec<ActionOffsetReuse>,
        option_slots: Vec<OptionSlot>,
        transitions: Vec<NativeTransition>,
        action_option_counts: BTreeMap<usize, usize>,
    }

    impl FsPackObserver for FsPackDiagnostics {
        fn on_pack_header(&mut self, pack_uuid: &str, stage_count: usize, _node_size: usize) {
            self.pack_uuid = pack_uuid.to_string();
            self.stage_count = stage_count;
        }

        fn on_link_table(&mut self, li: &[i32], stage_count: usize) {
            self.li = li.to_vec();
            self.stage_count = stage_count;
        }

        fn on_stage_controls(&mut self, stage_index: usize, raw: RawControls) {
            self.raw_controls.push((stage_index, raw));
        }

        fn on_stage_id(&mut self, stage_index: usize, stage_id: &str) {
            self.stage_ids.push((stage_index, stage_id.to_string()));
        }

        fn on_action_offset_reuse(&mut self, reuse: ActionOffsetReuse) {
            self.reuses.push(reuse);
        }

        fn on_option_slot(&mut self, slot: OptionSlot) {
            if slot.resolved_stage_index.is_some() {
                *self
                    .action_option_counts
                    .entry(slot.action_index)
                    .or_default() += 1;
            }
            self.option_slots.push(slot);
        }

        fn on_native_transition(&mut self, transition: NativeTransition) {
            self.transitions.push(transition);
        }
    }

    impl FsPackDiagnostics {
        /// Destinations natives d'une transition, lues directement dans `li` et
        /// donc indépendantes de la déduplication d'ActionNodes que mesurent
        /// les collisions d'offset.
        fn native_targets(&self, transition: &NativeTransition) -> Vec<Option<usize>> {
            let start = transition.li_offset.max(0) as usize;
            (0..transition.option_count.max(0) as usize)
                .map(|position| {
                    let slot = self.li.get(start + position)?;
                    let index = usize::try_from(*slot).ok()?;
                    (index < self.stage_count).then_some(index)
                })
                .collect()
        }

        fn q1_collisions(&self) -> Vec<Q1Collision> {
            self.reuses
                .iter()
                .filter(|reuse| reuse.first_option_count != reuse.reused_option_count)
                .map(|reuse| Q1Collision {
                    li_offset: reuse.li_offset,
                    first_option_count: reuse.first_option_count,
                    reused_option_count: reuse.reused_option_count,
                    stage_index: reuse.stage_index,
                    trigger: reuse.trigger.as_str().to_string(),
                })
                .collect()
        }

        fn q2_dropped_options(&self) -> Vec<Q2DroppedOption> {
            self.option_slots
                .iter()
                .filter(|slot| slot.resolved_stage_index.is_none())
                .map(|slot| Q2DroppedOption {
                    action_index: slot.action_index,
                    li_offset: slot.li_offset,
                    option_position: slot.option_position,
                    li_slot: slot.li_slot,
                    cause: if slot.li_slot.is_none() {
                        "sliceHorsTable"
                    } else {
                        "stageHorsPlage"
                    }
                    .to_string(),
                })
                .collect()
        }

        fn q4_raw_controls(&self) -> Vec<Q4RawControl> {
            self.raw_controls
                .iter()
                .flat_map(|(stage_index, raw)| {
                    raw.fields()
                        .into_iter()
                        .filter(|(_, value)| !matches!(value, 0 | 1))
                        .map(|(field, raw_value)| Q4RawControl {
                            stage_index: *stage_index,
                            field: field.to_string(),
                            raw_value,
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        }

        fn q6_non_uuid_stage_ids(&self) -> Vec<Q6StageId> {
            self.stage_ids
                .iter()
                .filter(|(_, stage_id)| uuid::Uuid::parse_str(stage_id).is_err())
                .map(|(stage_index, stage_id)| Q6StageId {
                    stage_index: *stage_index,
                    stage_id: stage_id.clone(),
                })
                .collect()
        }

        /// Fidélité : chaque transition native se retrouve-t-elle à l'identique dans le
        /// document produit ? Vérification par tuple, ancrée sur les positions de stage.
        fn q3_report(&self, document: &Value) -> Q3Report {
            let stage_position: BTreeMap<&str, usize> = document
                .get("stageNodes")
                .and_then(Value::as_array)
                .map(|stages| {
                    stages
                        .iter()
                        .enumerate()
                        .filter_map(|(position, stage)| {
                            Some((stage.get("uuid")?.as_str()?, position))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let action_options: BTreeMap<&str, Vec<Option<usize>>> = document
                .get("actionNodes")
                .and_then(Value::as_array)
                .map(|actions| {
                    actions
                        .iter()
                        .filter_map(|action| {
                            let id = action.get("id")?.as_str()?;
                            let options = action
                                .get("options")?
                                .as_array()?
                                .iter()
                                .map(|option| {
                                    option
                                        .as_str()
                                        .and_then(|uuid| stage_position.get(uuid).copied())
                                })
                                .collect();
                            Some((id, options))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let stages = document
                .get("stageNodes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let mut report = Q3Report {
                checked_transition_count: self.transitions.len(),
                ..Q3Report::default()
            };
            for transition in &self.transitions {
                let native_targets = self.native_targets(transition);
                let native_selected_target = usize::try_from(transition.selected)
                    .ok()
                    .and_then(|index| native_targets.get(index).copied())
                    .flatten();
                let mut kinds = Vec::new();

                let field = match transition.trigger {
                    Trigger::Ok => "okTransition",
                    Trigger::Home => "homeTransition",
                };
                let declared = stages
                    .get(transition.stage_index)
                    .and_then(|stage| stage.get(field));
                let action_id = declared
                    .and_then(|value| value.get("actionNode"))
                    .and_then(Value::as_str);
                let document_selected = declared
                    .and_then(|value| value.get("optionIndex"))
                    .and_then(Value::as_i64);
                let document_targets = action_id
                    .and_then(|id| action_options.get(id))
                    .cloned()
                    .unwrap_or_default();
                let document_selected_target = document_selected
                    .and_then(|index| usize::try_from(index).ok())
                    .and_then(|index| document_targets.get(index).copied())
                    .flatten();

                if declared.is_none() {
                    kinds.push("TRANSITION_ABSENTE".to_string());
                } else if action_id
                    .map(|id| !action_options.contains_key(id))
                    .unwrap_or(true)
                {
                    kinds.push("ACTION_INTROUVABLE".to_string());
                }
                if declared.is_some() && document_targets.len() != native_targets.len() {
                    kinds.push("NOMBRE_OPTIONS".to_string());
                }
                if declared.is_some() && document_targets != native_targets {
                    kinds.push("DESTINATIONS".to_string());
                }
                if document_selected != Some(i64::from(transition.selected)) {
                    kinds.push("OPTION_INDEX".to_string());
                }
                if document_selected_target != native_selected_target {
                    kinds.push("DESTINATION_SELECTIONNEE".to_string());
                }

                if !kinds.is_empty() {
                    report.mismatches.push(Q3Mismatch {
                        stage_index: transition.stage_index,
                        trigger: transition.trigger.as_str().to_string(),
                        li_offset: transition.li_offset,
                        native_action_index: transition.action_index,
                        kinds,
                        native_option_count: transition.option_count,
                        document_option_count: declared.map(|_| document_targets.len()),
                        native_targets,
                        document_targets,
                        native_selected: transition.selected,
                        document_selected,
                        native_selected_target,
                        document_selected_target,
                    });
                }
            }
            report.mismatch_count = report.mismatches.len();
            report
        }

        fn into_report(self, document: &Value) -> FsPackV1Report {
            let q3 = self.q3_report(document);
            let q1_collisions = self.q1_collisions();
            let q2_dropped_options = self.q2_dropped_options();
            let q4_raw_controls = self.q4_raw_controls();
            let q6_non_uuid_stage_ids = self.q6_non_uuid_stage_ids();
            FsPackV1Report {
                schema_version: REPORT_SCHEMA_VERSION,
                pack_uuid: self.pack_uuid.clone(),
                stage_count: self.stage_count,
                action_count: self.action_option_counts.len(),
                li_int_count: self.li.len(),
                native_transition_count: self.transitions.len(),
                shared_offset_reuse_count: self.reuses.len(),
                q1_collision_count: q1_collisions.len(),
                q1_collisions,
                q2_dropped_option_count: q2_dropped_options.len(),
                q2_dropped_options,
                q3,
                q4_out_of_range_count: q4_raw_controls.len(),
                q4_raw_controls,
                q6_non_uuid_count: q6_non_uuid_stage_ids.len(),
                q6_non_uuid_stage_ids,
            }
        }
    }

    /// Lit un pack filesystem avec l'instrumentation active et renvoie le rapport
    /// ainsi que le `story.json` produit.
    ///
    /// Le ZIP est écrit dans `output_zip` comme en production : le chemin mesuré est
    /// exactement celui de l'import, sans cache de conversion interposé.
    pub(crate) fn read_fs_pack_with_diagnostics(
        pack_dir: &Path,
        output_zip: &Path,
        fallback_title: &str,
    ) -> Result<(FsPackV1Report, Value), String> {
        let mut diagnostics = FsPackDiagnostics::default();
        crate::support::fs_pack_reader::read_fs_pack_to_studio_zip_observed(
            pack_dir,
            output_zip,
            fallback_title,
            &mut diagnostics,
        )?;
        let file = std::fs::File::open(output_zip)
            .map_err(|error| format!("ZIP diagnostique illisible : {error}"))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|error| format!("ZIP diagnostique invalide : {error}"))?;
        let mut story = String::new();
        {
            use std::io::Read;
            archive
                .by_name("story.json")
                .map_err(|error| format!("story.json absent du ZIP diagnostique : {error}"))?
                .read_to_string(&mut story)
                .map_err(|error| format!("story.json illisible : {error}"))?;
        }
        let document: Value = serde_json::from_str(&story)
            .map_err(|error| format!("story.json diagnostique invalide : {error}"))?;
        Ok((diagnostics.into_report(&document), document))
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use std::fs;
    use std::path::Path;

    /// Description d'un stage synthétique, au grain du nœud `ni`.
    #[derive(Clone, Copy, Debug)]
    pub(crate) struct FixtureStage {
        pub image_index: i32,
        pub sound_index: i32,
        /// `(li_offset, num_options, selected)`.
        pub ok: Option<(i32, i32, i32)>,
        pub home: Option<(i32, i32, i32)>,
        /// Valeurs brutes `wheel, ok, home, pause, autoplay`.
        pub controls: [u16; 5],
    }

    impl Default for FixtureStage {
        fn default() -> Self {
            Self {
                image_index: -1,
                sound_index: -1,
                ok: None,
                home: None,
                controls: [0, 1, 0, 0, 0],
            }
        }
    }

    impl FixtureStage {
        pub(crate) fn with_ok(li_offset: i32, num_options: i32, selected: i32) -> Self {
            Self {
                ok: Some((li_offset, num_options, selected)),
                ..Self::default()
            }
        }
    }

    const NODE_SIZE: usize = 44;

    /// Écrit un pack filesystem `plain` minimal, sans asset, prêt pour le lecteur.
    pub(crate) fn write_fixture_pack(pack_dir: &Path, stages: &[FixtureStage], li: &[i32]) {
        fs::create_dir_all(pack_dir.join("rf/000")).expect("dossier images");
        fs::create_dir_all(pack_dir.join("sf/000")).expect("dossier audios");

        let mut ni = vec![0_u8; 512 + stages.len() * NODE_SIZE];
        ni[2..4].copy_from_slice(&1_i16.to_le_bytes());
        ni[8..12].copy_from_slice(&(NODE_SIZE as u32).to_le_bytes());
        ni[12..16].copy_from_slice(&(stages.len() as u32).to_le_bytes());
        for (index, stage) in stages.iter().enumerate() {
            let node = &mut ni[512 + index * NODE_SIZE..512 + (index + 1) * NODE_SIZE];
            let (ok_offset, ok_count, ok_selected) = stage.ok.unwrap_or((-1, -1, -1));
            let (home_offset, home_count, home_selected) = stage.home.unwrap_or((-1, -1, -1));
            for (offset, value) in [
                (0, stage.image_index),
                (4, stage.sound_index),
                (8, ok_offset),
                (12, ok_count),
                (16, ok_selected),
                (20, home_offset),
                (24, home_count),
                (28, home_selected),
            ] {
                node[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
            for (position, raw) in stage.controls.iter().enumerate() {
                let offset = 32 + position * 2;
                node[offset..offset + 2].copy_from_slice(&raw.to_le_bytes());
            }
        }
        fs::write(pack_dir.join("ni"), ni).expect("écriture ni");

        let li_bytes: Vec<u8> = li.iter().flat_map(|value| value.to_le_bytes()).collect();
        fs::write(pack_dir.join("li.plain"), li_bytes).expect("écriture li");
        fs::write(pack_dir.join("ri.plain"), []).expect("écriture ri");
        fs::write(pack_dir.join("si.plain"), []).expect("écriture si");
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{write_fixture_pack, FixtureStage};
    use super::read_fs_pack_with_diagnostics;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("horloge après epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "story_studio_fs_pack_diagnostics_{name}_{}_{}",
            std::process::id(),
            nonce
        ))
    }

    /// Construit le pack, le lit avec instrumentation, puis nettoie.
    fn diagnose(
        name: &str,
        pack_name: &str,
        stages: &[FixtureStage],
        li: &[i32],
    ) -> super::FsPackV1Report {
        let dir = temp_dir(name);
        let pack_dir = dir.join(pack_name);
        write_fixture_pack(&pack_dir, stages, li);
        let (report, _document) =
            read_fs_pack_with_diagnostics(&pack_dir, &dir.join("out.zip"), "Pack synthétique")
                .expect("lecture instrumentée");
        fs::remove_dir_all(&dir).expect("nettoyage fixture");
        report
    }

    fn uuid_pack_name() -> &'static str {
        "11111111-2222-3333-4444-555555555555"
    }

    #[test]
    fn q1_reports_shared_offset_with_diverging_option_counts() {
        // Deux stages pointent sur l'offset 0 avec 2 puis 3 options : le lecteur
        // retient le premier compte et la seconde transition perd une destination.
        let stages = [
            FixtureStage::with_ok(0, 2, 0),
            FixtureStage::with_ok(0, 3, 0),
            FixtureStage::default(),
            FixtureStage::default(),
        ];
        let report = diagnose("q1", uuid_pack_name(), &stages, &[1, 2, 3]);

        assert_eq!(report.q1_collision_count, 1, "{report:?}");
        let collision = &report.q1_collisions[0];
        assert_eq!(collision.li_offset, 0);
        assert_eq!(collision.first_option_count, 2);
        assert_eq!(collision.reused_option_count, 3);
        assert_eq!(collision.stage_index, 1);
        assert_eq!(collision.trigger, "ok");
    }

    #[test]
    fn q1_stays_silent_when_a_shared_offset_keeps_the_same_option_count() {
        let stages = [
            FixtureStage::with_ok(0, 2, 0),
            FixtureStage::with_ok(0, 2, 1),
            FixtureStage::default(),
            FixtureStage::default(),
        ];
        let report = diagnose("q1_stable", uuid_pack_name(), &stages, &[2, 3]);

        assert_eq!(report.q1_collision_count, 0, "{report:?}");
        assert_eq!(report.shared_offset_reuse_count, 1);
        assert_eq!(report.q3.mismatch_count, 0, "{report:?}");
    }

    #[test]
    fn q2_reports_options_dropped_by_the_reader() {
        // Position 1 : la slice dépasse `li`. Position 0 : l'indice de stage n'existe pas.
        let stages = [FixtureStage::with_ok(0, 2, 0), FixtureStage::default()];
        let report = diagnose("q2", uuid_pack_name(), &stages, &[7]);

        assert_eq!(report.q2_dropped_option_count, 2, "{report:?}");
        let causes: Vec<&str> = report
            .q2_dropped_options
            .iter()
            .map(|option| option.cause.as_str())
            .collect();
        assert_eq!(causes, ["stageHorsPlage", "sliceHorsTable"]);
        assert_eq!(report.q2_dropped_options[0].li_slot, Some(7));
        assert_eq!(report.q2_dropped_options[1].li_slot, None);
    }

    #[test]
    fn q2_stays_silent_when_every_option_resolves() {
        let stages = [
            FixtureStage::with_ok(0, 2, 1),
            FixtureStage::default(),
            FixtureStage::default(),
        ];
        let report = diagnose("q2_clean", uuid_pack_name(), &stages, &[1, 2]);

        assert_eq!(report.q2_dropped_option_count, 0, "{report:?}");
    }

    #[test]
    fn q3_accepts_a_faithfully_reconstructed_transition() {
        let stages = [
            FixtureStage::with_ok(0, 3, 2),
            FixtureStage::default(),
            FixtureStage::default(),
            FixtureStage::default(),
        ];
        let report = diagnose("q3_ok", uuid_pack_name(), &stages, &[1, 2, 3]);

        assert_eq!(report.q3.checked_transition_count, 1);
        assert_eq!(report.q3.mismatch_count, 0, "{report:?}");
    }

    #[test]
    fn q3_reports_the_transition_degraded_by_a_shared_offset() {
        // Même montage que pour les collisions d'offset : la seconde transition
        // déclare trois destinations, l'ActionNode dédupliqué n'en porte que
        // deux.
        let stages = [
            FixtureStage::with_ok(0, 2, 0),
            FixtureStage::with_ok(0, 3, 2),
            FixtureStage::default(),
            FixtureStage::default(),
        ];
        let report = diagnose("q3_ko", uuid_pack_name(), &stages, &[1, 2, 3]);

        assert_eq!(report.q3.checked_transition_count, 2);
        assert_eq!(report.q3.mismatch_count, 1, "{report:?}");
        let mismatch = &report.q3.mismatches[0];
        assert_eq!(mismatch.stage_index, 1);
        assert_eq!(
            mismatch.native_action_index, 0,
            "ActionNode partagé avec le stage 0"
        );
        assert_eq!(mismatch.native_option_count, 3);
        assert_eq!(mismatch.document_option_count, Some(2));
        assert_eq!(mismatch.native_targets, [Some(1), Some(2), Some(3)]);
        assert_eq!(mismatch.document_targets, [Some(1), Some(2)]);
        assert_eq!(mismatch.native_selected_target, Some(3));
        assert_eq!(mismatch.document_selected_target, None);
        assert!(mismatch.kinds.contains(&"NOMBRE_OPTIONS".to_string()));
        assert!(mismatch.kinds.contains(&"DESTINATIONS".to_string()));
        assert!(mismatch
            .kinds
            .contains(&"DESTINATION_SELECTIONNEE".to_string()));
    }

    #[test]
    fn q4_reports_raw_control_values_outside_zero_and_one() {
        let stage = FixtureStage {
            controls: [2, 1, 0, 0, 0xFFFF],
            ..FixtureStage::default()
        };
        let report = diagnose("q4", uuid_pack_name(), &[stage], &[]);

        assert_eq!(report.q4_out_of_range_count, 2, "{report:?}");
        assert_eq!(report.q4_raw_controls[0].field, "wheel");
        assert_eq!(report.q4_raw_controls[0].raw_value, 2);
        assert_eq!(report.q4_raw_controls[1].field, "autoplay");
        assert_eq!(report.q4_raw_controls[1].raw_value, 0xFFFF);
    }

    #[test]
    fn q4_stays_silent_on_boolean_controls() {
        let report = diagnose(
            "q4_clean",
            uuid_pack_name(),
            &[FixtureStage::default()],
            &[],
        );

        assert_eq!(report.q4_out_of_range_count, 0, "{report:?}");
    }

    #[test]
    fn q6_reports_the_entry_stage_id_derived_from_a_non_uuid_folder() {
        let report = diagnose(
            "q6",
            "Mon pack sans uuid",
            &[FixtureStage::default(), FixtureStage::default()],
            &[],
        );

        assert_eq!(report.q6_non_uuid_count, 1, "{report:?}");
        assert_eq!(report.q6_non_uuid_stage_ids[0].stage_index, 0);
        assert_eq!(
            report.q6_non_uuid_stage_ids[0].stage_id,
            "Mon pack sans uuid"
        );
    }

    #[test]
    fn q6_stays_silent_when_the_folder_is_a_uuid() {
        let report = diagnose(
            "q6_clean",
            uuid_pack_name(),
            &[FixtureStage::default(), FixtureStage::default()],
            &[],
        );

        assert_eq!(report.q6_non_uuid_count, 0, "{report:?}");
        assert_eq!(report.pack_uuid, uuid_pack_name());
    }
}
