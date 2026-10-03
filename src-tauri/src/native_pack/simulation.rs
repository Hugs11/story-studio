//! La projection d'écoute : le graphe à plat d'un projet hiérarchique, **sans
//! produire d'archive**.
//!
//! # Pourquoi elle existe
//!
//! Story Studio avait deux lecteurs : un pour l'arbre du mode Libre, un pour le
//! graphe à plat. Le second joue ce que le générateur produit ; le premier
//! *redérivait* la navigation au fur et à mesure, à l'aide du miroir JS
//! `generatedNavigation.js`. Deux navigations, donc deux entretiens, et deux
//! façons de diverger.
//!
//! Ce module supprime la seconde en donnant au lecteur de graphe une troisième
//! source : l'arbre du Libre, **projeté par le vrai générateur**. Il ne
//! réimplémente rien — `StoryBuilder` est appelé tel quel, et c'est tout
//! l'intérêt : ce que l'auteur entend est ce que la production fabriquera.
//!
//! # Ce qu'elle ne fait pas
//!
//! **Elle ne prépare aucun média.** La préparation de production réencode chaque
//! son avec FFmpeg, redimensionne chaque image et étage le tout dans un dossier
//! temporaire : plusieurs secondes par écoute, et une panne de FFmpeg
//! deviendrait une panne d'écoute. Ici les médias sont **nommés** sans être
//! touchés, et le lecteur ouvre les fichiers d'origine — ce que le lecteur du
//! mode Libre faisait déjà.
//!
//! Conséquence assumée : l'écoute ne rend pas le silence ajouté en tête ni
//! l'harmonisation du volume. La navigation, elle, est celle de la production.
//!
//! **Elle n'écrit rien.** Ni sur le disque, ni dans le projet.

use serde::Serialize;

use crate::domain::project::Project;

use super::assets::pipeline::{collect_asset_requests, AssetSourceKind};
use super::assets::zip_bundle::read_imported_zip_for_simulation;
use super::{
    canonicalize_project, ImportedZipBundle, NativeAssetPreparationReport, NativeAssetStats,
    PreparedAsset, StoryDocument,
};

/// Le nom réservé que porte un emplacement média dont le fichier n'existe pas.
///
/// Le générateur exige que chaque média annoncé soit préparé : une histoire sans
/// son fait échouer `asset_name`, et c'est ce que la porte « éléments à
/// corriger » vérifie avant de laisser produire. Un projet en cours d'écriture
/// n'a pas franchi cette porte — c'est même son état normal — et doit rester
/// écoutable. Ce nom tient donc la place, et le lecteur le reconnaît comme
/// « aucun fichier », exactement comme il traite une référence sans liaison
/// côté graphe.
///
/// Il ne peut pas entrer en collision avec un nom d'asset réel : ceux-ci sont
/// des empreintes hexadécimales suffixées par leur extension.
pub(crate) const SIMULATION_MISSING_ASSET: &str = "__simulation_absent__";

/// D'où le lecteur tire les octets d'un média.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationMedia {
    /// Le nom employé par le document projeté, tel que `stage.audio` le porte.
    pub(crate) asset_name: String,
    /// Le chemin de rôle du générateur, tel qu'il le construit.
    pub(crate) role: String,
    /// Premier usage d'auteur de ce média dédupliqué. L'identité de chaque
    /// Écran est portée séparément par `SimulationProjection.entry_id_by_stage`.
    /// Absent pour les médias de tête (couverture, mode nuit).
    pub(crate) entry_id: Option<String>,
    /// `disk` — un fichier du projet ; `pack` — un asset d'une archive importée.
    pub(crate) kind: &'static str,
    pub(crate) path: Option<String>,
    pub(crate) zip_path: Option<String>,
    pub(crate) zip_asset_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationProjection {
    pub(crate) story: StoryDocument,
    pub(crate) media: Vec<SimulationMedia>,
    pub(crate) entry_id_by_stage: std::collections::HashMap<String, String>,
}

fn disk_media(
    asset_name: String,
    role: String,
    entry_id: Option<String>,
    path: String,
) -> SimulationMedia {
    SimulationMedia {
        asset_name,
        role,
        entry_id,
        kind: "disk",
        path: Some(path),
        zip_path: None,
        zip_asset_name: None,
    }
}

/// Un nom d'asset stable et unique par **fichier source**.
///
/// La production déduplique par empreinte du contenu converti ; ici la
/// conversion n'a pas lieu, donc la déduplication se fait par chemin. Deux
/// fichiers différents au contenu identique restent deux assets : cela ne change
/// rien à ce qu'on entend, et cela évite de lire les octets.
fn simulation_asset_name(index: usize, source_path: &str) -> String {
    let extension = std::path::Path::new(source_path)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "bin".to_string());
    format!("sim{index:06}.{extension}")
}

/// Projette un projet hiérarchique dans le graphe à plat que le lecteur joue.
///
/// Le générateur est appelé **inchangé** : les refus qu'il oppose à un projet
/// non générable ressortent tels quels, sans être réécrits.
pub(crate) fn project_story_for_simulation(
    project: &Project,
) -> Result<SimulationProjection, String> {
    let canonical = canonicalize_project(project);
    let requests = collect_asset_requests(
        &canonical,
        project.global_options.leading_silence_duration_sec(),
        project.global_options.trailing_silence_duration_sec(),
    );

    let mut assets: Vec<PreparedAsset> = Vec::new();
    let mut media: Vec<SimulationMedia> = Vec::new();
    let mut imported_zips: Vec<ImportedZipBundle> = Vec::new();
    // Déduplication par chemin source : le même fichier employé par trois
    // histoires reste un seul asset, comme en production.
    let mut names_by_source: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for (index, request) in requests.iter().enumerate() {
        match request.source_kind {
            AssetSourceKind::Zip => {
                let (bundle, zip_media) = read_imported_zip_for_simulation(
                    &request.role,
                    request.entry_id.as_deref(),
                    &request.source_path,
                    media.len(),
                )?;
                imported_zips.push(bundle);
                media.extend(zip_media);
            }
            AssetSourceKind::Audio | AssetSourceKind::Image => {
                let asset_name = names_by_source
                    .entry(request.source_path.clone())
                    .or_insert_with(|| simulation_asset_name(index, &request.source_path))
                    .clone();
                if !media.iter().any(|entry| entry.asset_name == asset_name) {
                    media.push(disk_media(
                        asset_name.clone(),
                        request.role.clone(),
                        request.entry_id.clone(),
                        request.source_path.clone(),
                    ));
                }
                assets.push(PreparedAsset {
                    role: request.role.clone(),
                    source_path: request.source_path.clone(),
                    source_kind: match request.source_kind {
                        AssetSourceKind::Audio => "audio".to_string(),
                        AssetSourceKind::Image => "image".to_string(),
                        AssetSourceKind::Zip => "zip".to_string(),
                    },
                    staged_asset_name: asset_name,
                    staged_asset_path: String::new(),
                    transformed: false,
                    deduplicated: false,
                });
            }
        }
    }

    let stats = NativeAssetStats {
        requested_asset_count: requests.len(),
        unique_asset_count: assets.len(),
        transformed_audio_count: 0,
        imported_zip_count: imported_zips.len(),
    };

    let report = NativeAssetPreparationReport {
        project: canonical,
        pack_uuid: String::new(),
        stage_dir: String::new(),
        assets_dir: String::new(),
        assets,
        imported_zips,
        stats,
        notes: Vec::new(),
        warnings: Vec::new(),
        // Le seul effet de ce drapeau : `StoryBuilder::asset_name` tient la
        // place d'un média absent au lieu de refuser. La production ne le pose
        // jamais, et son résultat est donc inchangé.
        for_simulation: true,
    };

    let mut builder = super::builder::StoryBuilder::new(&report);
    let story = builder.build()?;
    Ok(SimulationProjection {
        story,
        media,
        entry_id_by_stage: builder.entry_id_by_stage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_pack::builder::StoryBuilder;
    use serde_json::json;

    fn project_json(stories: serde_json::Value, root_audio: Option<&str>) -> Project {
        serde_json::from_value(json!({
            "name": "Essai",
            "projectType": "pack",
            "rootAudio": root_audio,
            "rootImage": "/travail/couverture.png",
            "rootEntries": stories,
            "globalOptions": {
                "harmonizeLoudness": false,
                "addSilence": false,
                "autoNext": false,
                "nightMode": false,
                "endMessageAutoplay": true,
            },
        }))
        .expect("projet d'essai")
    }

    fn story(id: &str, name: &str, audio: Option<&str>) -> serde_json::Value {
        json!({
            "id": id,
            "type": "story",
            "name": name,
            "audio": audio,
            "itemAudio": null,
            "itemImage": null,
        })
    }

    #[test]
    fn un_projet_complet_se_projette_avec_ses_medias_sur_disque() {
        let project = project_json(
            json!([story("s1", "Première", Some("/travail/une.mp3"))]),
            Some("/travail/couverture.mp3"),
        );
        let projection = project_story_for_simulation(&project).expect("projection");

        // Le graphe vient du vrai générateur : il porte un Écran d'entrée.
        assert!(projection
            .story
            .stage_nodes
            .iter()
            .any(|stage| stage.is_square_one()));

        // Chaque média projeté pointe un fichier d'origine, jamais un asset
        // converti : aucune préparation n'a eu lieu.
        let une = projection
            .media
            .iter()
            .find(|entry| entry.path.as_deref() == Some("/travail/une.mp3"))
            .expect("le son de l'histoire est projeté");
        assert_eq!(une.kind, "disk");
        // Le média est rattaché à son entrée d'auteur : c'est par là que
        // l'interface retrouve le nœud de l'arbre à sélectionner pendant
        // l'écoute. L'identifiant est rendu **exact**, pas assaini.
        assert_eq!(une.entry_id.as_deref(), Some("s1"));

        // Les médias de tête n'appartiennent à aucune entrée, et le disent.
        let couverture = projection
            .media
            .iter()
            .find(|entry| entry.path.as_deref() == Some("/travail/couverture.mp3"))
            .expect("la couverture est projetée");
        assert_eq!(couverture.entry_id, None);

        // Et le nom projeté est bien celui que le document emploie.
        assert!(projection.story.stage_nodes.iter().any(|stage| {
            stage.audio.value().map(String::as_str) == Some(une.asset_name.as_str())
        }));
    }

    #[test]
    fn un_projet_que_la_production_refuserait_reste_ecoutable() {
        // Une histoire sans son : l'état le plus courant d'un travail en cours.
        let project = project_json(
            json!([story("s1", "Sans son", None)]),
            Some("/travail/couverture.mp3"),
        );

        let projection = project_story_for_simulation(&project)
            .expect("l'écoute ne refuse pas un travail en cours");
        let muet = projection
            .story
            .stage_nodes
            .iter()
            .find(|stage| stage.audio.value().map(String::as_str) == Some(SIMULATION_MISSING_ASSET))
            .expect("l'emplacement sans fichier tient sa place");
        // La place est tenue, mais aucun média ne lui est associé : le lecteur
        // joue l'Écran en silence.
        assert!(!projection
            .media
            .iter()
            .any(|entry| entry.asset_name == SIMULATION_MISSING_ASSET));
        assert_eq!(
            projection
                .entry_id_by_stage
                .get(&muet.uuid)
                .map(String::as_str),
            Some("s1")
        );
    }

    #[test]
    fn la_production_refuse_toujours_le_meme_projet() {
        // Le contre-essai de la ligne au-dessus. Sans lui, rien ne prouverait que le
        // drapeau d'écoute est ce qui fait la différence — ni que la production
        // conserve exactement son refus.
        let project = project_json(
            json!([story("s1", "Sans son", None)]),
            Some("/travail/couverture.mp3"),
        );
        let canonical = canonicalize_project(&project);
        let assets = vec![
            PreparedAsset {
                role: "rootAudio".to_string(),
                source_path: "/travail/couverture.mp3".to_string(),
                source_kind: "audio".to_string(),
                staged_asset_name: "aaa.mp3".to_string(),
                staged_asset_path: String::new(),
                transformed: false,
                deduplicated: false,
            },
            PreparedAsset {
                role: "rootImage".to_string(),
                source_path: "/travail/couverture.png".to_string(),
                source_kind: "image".to_string(),
                staged_asset_name: "bbb.png".to_string(),
                staged_asset_path: String::new(),
                transformed: false,
                deduplicated: false,
            },
        ];
        let report = NativeAssetPreparationReport {
            project: canonical,
            pack_uuid: String::new(),
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
            warnings: Vec::new(),
            for_simulation: false,
        };
        let refusal = StoryBuilder::new(&report)
            .build()
            .expect_err("la production refuse une histoire sans son");
        assert!(
            refusal.contains("storyAudio"),
            "refus inattendu : {refusal}"
        );
    }

    #[test]
    fn un_meme_fichier_employe_deux_fois_reste_un_seul_media() {
        let project = project_json(
            json!([
                story("s1", "Première", Some("/travail/commun.mp3")),
                story("s2", "Seconde", Some("/travail/commun.mp3")),
            ]),
            Some("/travail/couverture.mp3"),
        );
        let projection = project_story_for_simulation(&project).expect("projection");
        let communs = projection
            .media
            .iter()
            .filter(|entry| entry.path.as_deref() == Some("/travail/commun.mp3"))
            .count();
        assert_eq!(communs, 1);
    }

    #[test]
    fn shared_media_keeps_each_stage_entry_identity() {
        for shared_audio in [true, false] {
            let stories = ["s1", "s2"].map(|id| {
                let mut entry = story(id, "Même titre", Some("/travail/commun.mp3"));
                entry["itemImage"] = json!("/travail/commun.png");
                if shared_audio {
                    entry["itemAudio"] = json!("/travail/commun.mp3");
                }
                entry
            });
            let project = project_json(json!(stories), Some("/travail/commun.mp3"));
            let projection = project_story_for_simulation(&project).expect("projection");
            let value = serde_json::to_value(&projection).expect("sérialisation");
            let cover = projection
                .story
                .stage_nodes
                .iter()
                .find(|s| s.is_square_one())
                .unwrap();
            let root_action = projection
                .story
                .action_nodes
                .iter()
                .find(|a| a.id == cover.ok_transition.value().unwrap().action_node)
                .unwrap();
            for (index, id) in ["s1", "s2"].iter().enumerate() {
                let title_id = root_action.options[index].as_ref().unwrap();
                let title = projection
                    .story
                    .stage_nodes
                    .iter()
                    .find(|s| &s.uuid == title_id)
                    .unwrap();
                assert_eq!(value["entryIdByStage"][title_id], *id);
                let play_action = projection
                    .story
                    .action_nodes
                    .iter()
                    .find(|a| a.id == title.ok_transition.value().unwrap().action_node)
                    .unwrap();
                assert_eq!(
                    value["entryIdByStage"][play_action.options[0].as_ref().unwrap()],
                    *id
                );
            }
            assert!(value["entryIdByStage"][&cover.uuid].is_null());
            for path in ["/travail/commun.mp3", "/travail/commun.png"] {
                assert_eq!(
                    projection
                        .media
                        .iter()
                        .filter(|m| m.path.as_deref() == Some(path))
                        .count(),
                    1
                );
            }
        }
    }

    #[test]
    fn le_document_projete_est_jouable_de_bout_en_bout() {
        let project = project_json(
            json!([
                story("s1", "Première", Some("/travail/une.mp3")),
                story("s2", "Seconde", Some("/travail/deux.mp3")),
            ]),
            Some("/travail/couverture.mp3"),
        );
        let projection = project_story_for_simulation(&project).expect("projection");
        let story = &projection.story;

        // Exactement une entrée : le lecteur sait par où commencer.
        assert_eq!(
            story
                .stage_nodes
                .iter()
                .filter(|stage| stage.is_square_one())
                .count(),
            1
        );

        // Toute transition désigne une Action qui existe, et toute option une
        // cible qui existe : le lecteur ne peut pas tomber dans le vide.
        let stage_ids: std::collections::HashSet<&str> = story
            .stage_nodes
            .iter()
            .map(|stage| stage.uuid.as_str())
            .collect();
        let action_ids: std::collections::HashSet<&str> = story
            .action_nodes
            .iter()
            .map(|action| action.id.as_str())
            .collect();
        for stage in &story.stage_nodes {
            for transition in [stage.ok_transition.value(), stage.home_transition.value()]
                .into_iter()
                .flatten()
            {
                assert!(
                    action_ids.contains(transition.action_node.as_str()),
                    "transition vers une Action inconnue : {}",
                    transition.action_node
                );
            }
        }
        for action in &story.action_nodes {
            for option in action.options.iter().flatten() {
                assert!(
                    stage_ids.contains(option.as_str()),
                    "option vers un Écran inconnu : {option}"
                );
            }
        }

        // Tout média cité est soit dans la table, soit le nom réservé. Aucun
        // Écran ne désigne un fichier que le lecteur ne saurait pas ouvrir.
        let known: std::collections::HashSet<&str> = projection
            .media
            .iter()
            .map(|entry| entry.asset_name.as_str())
            .collect();
        for stage in &story.stage_nodes {
            for slot in [stage.audio.value(), stage.image.value()]
                .into_iter()
                .flatten()
            {
                assert!(
                    known.contains(slot.as_str()) || slot == SIMULATION_MISSING_ASSET,
                    "média projeté inconnu : {slot}"
                );
            }
        }
    }

    #[test]
    fn la_projection_serialisee_porte_les_noms_que_le_lecteur_attend() {
        // Le contrat de fil entre Rust et le lecteur. Les essais JavaScript
        // lisent une projection écrite à la main ; sans cette vérification,
        // renommer un champ ici les laisserait verts et casserait l'écoute.
        let project = project_json(
            json!([story("s1", "Première", Some("/travail/une.mp3"))]),
            Some("/travail/couverture.mp3"),
        );
        let projection = project_story_for_simulation(&project).expect("projection");
        let value = serde_json::to_value(&projection).expect("sérialisation");

        assert!(value["story"]["stageNodes"].is_array());
        assert!(value["story"]["actionNodes"].is_array());
        let stage = &value["story"]["stageNodes"][0];
        assert!(stage["uuid"].is_string());
        assert!(stage["controlSettings"].is_object());

        let media = value["media"]
            .as_array()
            .expect("table des médias")
            .iter()
            .find(|entry| entry["path"] == "/travail/une.mp3")
            .expect("le son de l'histoire");
        assert!(media["assetName"].is_string());
        assert_eq!(media["kind"], "disk");
        assert_eq!(media["entryId"], "s1");
        assert!(media["role"].is_string());
        // Les deux champs d'archive existent et valent `null` pour un fichier
        // du disque : le lecteur teste `kind`, jamais leur présence.
        assert!(media["zipPath"].is_null());
        assert!(media["zipAssetName"].is_null());
    }

    #[test]
    fn un_nom_d_asset_de_simulation_garde_l_extension_source() {
        assert_eq!(simulation_asset_name(3, "/a/b/voix.FLAC"), "sim000003.flac");
        assert_eq!(
            simulation_asset_name(0, "/a/b/sans-extension"),
            "sim000000.bin"
        );
    }
}
