//! Juge de fidélité (Étape 1, plan 12) — il MESURE, il ne change AUCUN comportement.
//!
//! Question binaire, par pack : « le chemin **canonique** (`StoryBuilder`, sans
//! parachute) régénère-t-il fidèlement le pack importé ? ». La réponse pilotera
//! l'éditabilité (Étape 4) puis la coupure du parachute (Étape 5). Ici, on se contente
//! de répondre — rien n'est encore branché dessus.
//!
//! Méthode : générer le document via le canonique en **ignorant** le `nativeGraph`,
//! puis comparer STRUCTURELLEMENT (UUID-agnostique) au snapshot `nativeGraph.document`
//! d'origine — l'oracle, vérité terrain du pack. Sans `nativeGraph`, le pack est déjà
//! pleinement modélisé : l'arbre EST la source de vérité, donc fidèle dès qu'il génère
//! un document STUdio-valide.
//!
//! Socle non encore consommé : branché à l'Étape 2 (classement) puis à l'Étape 4
//! (éditabilité). D'où l'`allow(dead_code)` (même statut que `preallocate.rs`).
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use super::assets::pipeline::{active_native_graph, collect_asset_requests, AssetSourceKind};
use super::canonical::CanonicalProject;
use super::document::{ActionNode, StageNode, StoryDocument, Transition};
use super::stats::NativeAssetStats;
use super::{build_canonical_story_document, NativeAssetPreparationReport, PreparedAsset};

/// Verdict du juge : fidèle ou non, avec le détail des écarts. Chaque écart = une
/// « forme » de stage dont le compte diffère entre la génération canonique et l'oracle
/// (un nœud / une arête présent d'un côté et pas de l'autre) → matière à combler (Étape 3).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct FidelityReport {
    pub(crate) faithful: bool,
    pub(crate) generated_stage_count: usize,
    pub(crate) oracle_stage_count: usize,
    pub(crate) gaps: Vec<String>,
}

impl FidelityReport {
    fn failed(reason: String) -> Self {
        Self {
            faithful: false,
            generated_stage_count: 0,
            oracle_stage_count: 0,
            gaps: vec![reason],
        }
    }

    /// Pack pleinement modélisé (aucun parachute) : aucun oracle ne peut le contredire.
    fn modeled(generated_stage_count: usize) -> Self {
        Self {
            faithful: true,
            generated_stage_count,
            oracle_stage_count: 0,
            gaps: Vec::new(),
        }
    }
}

/// Décide si la génération canonique d'un pack est fidèle à l'oracle.
///
/// - `Ok(report)` : le juge a tourné ; `report.faithful` tranche.
/// - `Err(_)` : le juge n'a PAS pu tourner (snapshot oracle illisible) — exceptionnel.
///
/// Un échec de génération canonique n'est pas une erreur du juge mais un verdict
/// (« non fidèle : ne génère même pas »), replié dans `FidelityReport::failed`.
pub(crate) fn canonical_roundtrip_is_faithful(
    canonical: &CanonicalProject,
) -> Result<FidelityReport, String> {
    let generated = match canonical_document_for_fidelity(canonical) {
        Ok(document) => document,
        Err(error) => {
            return Ok(FidelityReport::failed(format!(
                "échec de génération canonique : {error}"
            )))
        }
    };

    let Some(graph) = active_native_graph(canonical.native_graph.as_ref()) else {
        return Ok(FidelityReport::modeled(generated.stage_nodes.len()));
    };

    let oracle_value = graph
        .get("document")
        .cloned()
        .ok_or_else(|| "Graphe natif sans document story.json.".to_string())?;
    let oracle: StoryDocument = serde_json::from_value(oracle_value)
        .map_err(|error| format!("Graphe natif invalide : {error}"))?;

    Ok(compare_documents_structural(&generated, &oracle))
}

/// Construit le document canonique avec des assets **fictifs** (noms seulement) : le
/// juge compare des structures de graphe, jamais des octets — donc ni ffmpeg ni vrais
/// fichiers. Tous les rôles utiles sont couverts (`collect_asset_requests` est le
/// sur-ensemble des rôles de l'arbre ; les rôles `nativeGraph` en trop sont inoffensifs).
fn canonical_document_for_fidelity(
    canonical: &CanonicalProject,
) -> Result<StoryDocument, String> {
    let assets = placeholder_assets(canonical);
    let report = fidelity_report_for(canonical.clone(), assets);
    build_canonical_story_document(&report)
}

fn placeholder_assets(canonical: &CanonicalProject) -> Vec<PreparedAsset> {
    collect_asset_requests(canonical, 1.0)
        .into_iter()
        .enumerate()
        .map(|(index, request)| {
            let extension = match request.source_kind {
                AssetSourceKind::Image => "bmp",
                _ => "mp3",
            };
            PreparedAsset {
                role: request.role,
                source_path: String::new(),
                source_kind: "fidelity".to_string(),
                staged_asset_name: format!("fidelity-{index}.{extension}"),
                staged_asset_path: String::new(),
                transformed: false,
                deduplicated: false,
            }
        })
        .collect()
}

fn fidelity_report_for(
    project: CanonicalProject,
    assets: Vec<PreparedAsset>,
) -> NativeAssetPreparationReport {
    NativeAssetPreparationReport {
        project,
        stage_dir: String::new(),
        assets_dir: String::new(),
        assets,
        imported_zips: Vec::new(),
        stats: NativeAssetStats {
            requested_asset_count: 0,
            unique_asset_count: 0,
            transformed_audio_count: 0,
            imported_zip_count: 0,
        },
        notes: Vec::new(),
    }
}

/// Compare deux documents par **multiset de formes de stages** (UUID-agnostique).
/// Une forme = les contrôles/assets d'un stage + les formes de ses cibles OK/Home
/// (arêtes à 1 niveau de profondeur). Un écart de compte révèle une structure présente
/// d'un côté seulement (nœud/arête perdu ou ajouté). Même métrique que le harnais
/// `assert_fidelity` éprouvé, ici promue en code de production.
fn compare_documents_structural(
    generated: &StoryDocument,
    oracle: &StoryDocument,
) -> FidelityReport {
    let mut gaps = Vec::new();

    if !generated.stage_nodes.iter().any(|stage| stage.square_one) {
        gaps.push("stage squareOne manquant dans la génération canonique".to_string());
    }
    if generated.night_mode_available != oracle.night_mode_available {
        gaps.push(format!(
            "nightModeAvailable : généré={} oracle={}",
            generated.night_mode_available, oracle.night_mode_available
        ));
    }

    let generated_shapes = stage_shapes(generated);
    let oracle_shapes = stage_shapes(oracle);
    let mut keys: BTreeSet<&StageShape> = generated_shapes.keys().collect();
    keys.extend(oracle_shapes.keys());
    for key in keys {
        let in_generated = generated_shapes.get(key).copied().unwrap_or(0);
        let in_oracle = oracle_shapes.get(key).copied().unwrap_or(0);
        if in_generated != in_oracle {
            gaps.push(format!(
                "forme généré={in_generated} oracle={in_oracle} : {key:?}"
            ));
        }
    }

    FidelityReport {
        faithful: gaps.is_empty(),
        generated_stage_count: generated.stage_nodes.len(),
        oracle_stage_count: oracle.stage_nodes.len(),
        gaps,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ControlShape {
    square_one: bool,
    has_audio: bool,
    has_image: bool,
    wheel: bool,
    ok: bool,
    home: bool,
    pause: bool,
    autoplay: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct StageShape {
    node: ControlShape,
    ok_target: Option<ControlShape>,
    home_target: Option<ControlShape>,
}

fn control_shape(stage: &StageNode) -> ControlShape {
    ControlShape {
        square_one: stage.square_one,
        has_audio: stage.audio.is_some(),
        has_image: stage.image.is_some(),
        wheel: stage.control_settings.wheel,
        ok: stage.control_settings.ok,
        home: stage.control_settings.home,
        pause: stage.control_settings.pause,
        autoplay: stage.control_settings.autoplay,
    }
}

fn transition_target_shape(
    transition: Option<&Transition>,
    actions: &HashMap<&str, &ActionNode>,
    stages: &HashMap<&str, &StageNode>,
) -> Option<ControlShape> {
    let transition = transition?;
    if transition.option_index < 0 {
        return None;
    }
    let action = actions.get(transition.action_node.as_str())?;
    let stage_id = action.options.get(transition.option_index as usize)?;
    stages.get(stage_id.as_str()).copied().map(control_shape)
}

fn stage_shapes(document: &StoryDocument) -> BTreeMap<StageShape, usize> {
    let actions: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let stages: HashMap<&str, &StageNode> = document
        .stage_nodes
        .iter()
        .map(|stage| (stage.uuid.as_str(), stage))
        .collect();

    let mut shapes = BTreeMap::new();
    for stage in &document.stage_nodes {
        let shape = StageShape {
            node: control_shape(stage),
            ok_target: transition_target_shape(stage.ok_transition.as_ref(), &actions, &stages),
            home_target: transition_target_shape(stage.home_transition.as_ref(), &actions, &stages),
        };
        *shapes.entry(shape).or_insert(0) += 1;
    }
    shapes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_pack::{
        CanonicalEntry, CanonicalMenu, CanonicalOptions, CanonicalRef, CanonicalStory,
    };

    fn story(id: &str, name: &str, audio: &str) -> CanonicalEntry {
        CanonicalEntry::Story(CanonicalStory {
            id: id.to_string(),
            name: name.to_string(),
            audio: Some(audio.to_string()),
            ..Default::default()
        })
    }

    /// Type d'architecture : un menu (carrefour) hébergeant deux histoires. Pleinement
    /// modélisable → génération canonique propre. Pas de `nativeGraph` (l'appelant en
    /// injecte un dans certains tests pour jouer l'oracle).
    fn sample_project() -> CanonicalProject {
        CanonicalProject {
            name: "Juge".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("cover.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions::default(),
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "carrefour".to_string(),
                name: "Carrefour".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: vec![
                    story("story-a", "Histoire A", "a.mp3"),
                    story("story-b", "Histoire B", "b.mp3"),
                ],
                ..Default::default()
            })],
        }
    }

    fn wrap_oracle(document: &StoryDocument) -> serde_json::Value {
        serde_json::json!({
            "preserveForRoundTrip": true,
            "document": serde_json::to_value(document).expect("serialize oracle"),
        })
    }

    /// Fidèle : l'oracle EST la génération canonique du même arbre. Le juge régénère
    /// (UUIDs frais, donc différents de l'oracle) et compare : même structure → fidèle.
    /// Prouve du même coup que la comparaison est UUID-agnostique.
    #[test]
    fn judge_passes_when_native_graph_matches_canonical_build() {
        let project = sample_project();
        let oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let mut with_oracle = project.clone();
        with_oracle.native_graph = Some(wrap_oracle(&oracle));

        let report = canonical_roundtrip_is_faithful(&with_oracle).expect("judge runs");
        assert!(report.faithful, "écarts inattendus : {:?}", report.gaps);
        assert!(report.gaps.is_empty());
        assert_eq!(report.generated_stage_count, report.oracle_stage_count);
    }

    /// Non fidèle : l'oracle porte une structure que l'arbre ne reproduit plus (édition
    /// de structure perdue / import lossy) — modélisée ici par un stage supplémentaire.
    /// Le juge doit la signaler. C'est exactement la « perte silencieuse » à éliminer.
    #[test]
    fn judge_flags_structure_absent_from_the_tree() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let extra = oracle.stage_nodes[0].clone();
        oracle.stage_nodes.push(extra);
        let mut with_oracle = project.clone();
        with_oracle.native_graph = Some(wrap_oracle(&oracle));

        let report = canonical_roundtrip_is_faithful(&with_oracle).expect("judge runs");
        assert!(!report.faithful, "le juge aurait dû détecter le nœud en trop");
        assert!(!report.gaps.is_empty());
        assert_eq!(
            report.oracle_stage_count,
            report.generated_stage_count + 1,
            "l'oracle a un stage de plus que la génération canonique",
        );
    }

    /// Pleinement modélisé (aucun parachute) : l'arbre est la source de vérité, donc
    /// fidèle dès qu'il génère un document valide. Aucun oracle à comparer.
    #[test]
    fn judge_passes_for_fully_modeled_pack_without_native_graph() {
        let project = sample_project();
        let report = canonical_roundtrip_is_faithful(&project).expect("judge runs");
        assert!(report.faithful);
        assert_eq!(report.oracle_stage_count, 0);
        assert!(report.generated_stage_count > 0);
    }

    /// Génération impossible (ref vers une cible inexistante → échec bloquant de
    /// `resolve_pending_ref_options`) : verdict « non fidèle », pas une erreur du juge.
    #[test]
    fn judge_reports_unfaithful_when_canonical_build_fails() {
        let project = CanonicalProject {
            name: "Ref cassée".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("cover.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions::default(),
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "carrefour".to_string(),
                name: "Carrefour".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: vec![
                    story("story-a", "Histoire A", "a.mp3"),
                    CanonicalEntry::Ref(CanonicalRef {
                        id: "lien".to_string(),
                        target: "story:cible-inexistante".to_string(),
                        ref_kind: Some("continue".to_string()),
                    }),
                ],
                ..Default::default()
            })],
        };

        let report = canonical_roundtrip_is_faithful(&project).expect("judge runs");
        assert!(!report.faithful);
        assert!(
            report
                .gaps
                .iter()
                .any(|gap| gap.contains("génération canonique")),
            "le verdict doit mentionner l'échec de génération : {:?}",
            report.gaps,
        );
    }
}
