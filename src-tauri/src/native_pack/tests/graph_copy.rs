//! Copie graphe d'un projet par menus : même structure de pack, mêmes fichiers.
//!
//! Chaque projet couvre un réglage sensible de l'arbre. La preuve est toujours
//! la même : la copie passe la garde de fidélité, et ses liaisons désignent
//! exactement les fichiers que l'original emploie.

use super::*;
use crate::native_pack::graph_copy::{
    bound_files, graph_copy_of_project, verify_graph_copy, GraphCopy,
};
use crate::native_pack::persistence::{
    decode_authoring_payload, encode_authoring_payload, AdvancedMediaBinding, MediaBindingStatus,
};
use crate::native_pack::simulation::project_story_for_simulation;
use serde_json::{json, Value};

const PACK_UUID: &str = "3f2b9c1e-8a47-4d2e-9b61-0c5d7e8f9a10";

fn free_project(entries: Value, options: Value) -> Project {
    let mut global = json!({
        "harmonizeLoudness": true,
        "silenceMode": "add",
        "autoNext": false,
        "nightMode": false,
        "endMessageAutoplay": true,
    });
    for (key, value) in options.as_object().expect("options") {
        global[key] = value.clone();
    }
    serde_json::from_value(json!({
        "name": "Toudou",
        "projectType": "pack",
        "rootAudio": "/travail/accueil.mp3",
        "rootImage": "/travail/accueil.png",
        "packUuid": PACK_UUID,
        "packVersion": 3,
        "packDescription": "Des histoires",
        "rootEntries": entries,
        "globalOptions": global,
    }))
    .expect("projet d'essai")
}

fn story(id: &str, extra: Value) -> Value {
    let mut story = json!({
        "id": id,
        "type": "story",
        "name": format!("Histoire {id}"),
        "audio": format!("/travail/{id}.mp3"),
        "itemAudio": format!("/travail/{id}-titre.mp3"),
        "itemImage": format!("/travail/{id}-titre.png"),
    });
    for (key, value) in extra.as_object().expect("champs") {
        story[key] = value.clone();
    }
    story
}

fn menu(id: &str, children: Value, extra: Value) -> Value {
    let mut menu = json!({
        "id": id,
        "type": "menu",
        "name": format!("Dossier {id}"),
        "audio": format!("/travail/{id}.mp3"),
        "image": format!("/travail/{id}.png"),
        "itemAudio": null,
        "itemImage": null,
        "children": children,
    });
    for (key, value) in extra.as_object().expect("champs") {
        menu[key] = value.clone();
    }
    menu
}

/// Le fichier de chaque média que le document de l'original fait jouer. La
/// projection nomme aussi des médias qu'aucun Écran n'emploie (un son de nuit
/// sans Écran de nuit, par exemple) : la copie, elle, ne lie que les siens.
fn projected_files(project: &Project) -> Vec<String> {
    let projection = project_story_for_simulation(project).expect("projection");
    let used: std::collections::HashSet<&str> = projection
        .story
        .stage_nodes
        .iter()
        .flat_map(|stage| [stage.audio.value(), stage.image.value()])
        .flatten()
        .map(String::as_str)
        .collect();
    let mut files: Vec<String> = projection
        .media
        .iter()
        .filter(|media| used.contains(media.asset_name.as_str()))
        .filter_map(|media| media.path.clone())
        .collect();
    files.sort();
    files.dedup();
    files
}

/// La copie passe la garde, et ses liaisons désignent exactement les fichiers
/// de l'original : ni copie, ni oubli.
fn assert_faithful_copy(project: &Project) -> GraphCopy {
    let copy = graph_copy_of_project(project).expect("copie graphe");
    verify_graph_copy(project, &copy.payload).expect("même structure de pack");
    assert_eq!(bound_files(&copy), projected_files(project));
    copy
}

#[test]
fn une_copie_garde_la_structure_les_fichiers_et_l_identite() {
    let project = free_project(
        json!([story("s1", json!({})), story("s2", json!({}))]),
        json!({}),
    );
    let copy = assert_faithful_copy(&project);
    let decoded = decode_authoring_payload(&copy.payload).expect("payload relu");
    assert_eq!(
        decoded.context.pack_identity.value.as_deref(),
        Some(PACK_UUID),
        "la copie remplace le même pack sur l'appareil"
    );
    assert_eq!(decoded.document.version.value().copied(), Some(3));
    assert_eq!(
        decoded.document.description.value().map(String::as_str),
        Some("Des histoires")
    );
}

#[test]
fn les_menus_en_lecture_automatique_restent_fideles() {
    let autoplay = json!({ "controlSettings": {
        "autoplay": true, "wheel": false, "pause": false, "ok": false, "home": true,
    }});
    let project = free_project(
        json!([menu(
            "m1",
            json!([story("s1", json!({})), story("s2", json!({}))]),
            autoplay
        )]),
        json!({}),
    );
    assert_faithful_copy(&project);
}

#[test]
fn les_retours_de_fin_et_l_histoire_suivante_restent_fideles() {
    let project = free_project(
        json!([menu(
            "m1",
            json!([
                story(
                    "s1",
                    json!({ "returnAfterPlay": "next_story", "returnOnHome": "root" })
                ),
                story("s2", json!({ "returnAfterPlay": "current_menu" })),
                story(
                    "s3",
                    json!({ "returnAfterPlay": "story:s1", "returnOnHomeNone": true })
                ),
            ]),
            json!({}),
        )]),
        json!({}),
    );
    assert_faithful_copy(&project);
}

#[test]
fn la_lecture_enchainee_reste_fidele() {
    let project = free_project(
        json!([story("s1", json!({})), story("s2", json!({}))]),
        json!({ "autoNext": true }),
    );
    assert_faithful_copy(&project);
}

#[test]
fn le_mode_nuit_et_le_message_de_fin_restent_fideles() {
    let mut project = free_project(
        json!([
            story(
                "s1",
                json!({
                    "afterPlaybackPromptAudio": "/travail/fin.mp3",
                    "afterPlaybackPromptOkTarget": "next_story",
                    "afterPlaybackPromptHomeTarget": "root",
                })
            ),
            story(
                "s2",
                json!({ "afterPlaybackPromptAudio": "/travail/fin.mp3" })
            ),
        ]),
        json!({ "nightMode": true }),
    );
    project.night_mode_audio = Some("/travail/nuit.mp3".to_string());
    let copy = assert_faithful_copy(&project);
    let decoded = decode_authoring_payload(&copy.payload).expect("payload relu");
    assert!(decoded.document.night_mode_available.is_true());
}

#[test]
fn un_projet_incomplet_se_copie_avec_des_medias_manquants_distincts() {
    let project = free_project(
        json!([
            story("s1", json!({ "audio": null })),
            story("s2", json!({ "audio": null })),
        ]),
        json!({}),
    );
    let copy = graph_copy_of_project(&project).expect("un travail en cours se copie");
    verify_graph_copy(&project, &copy.payload).expect("même structure de pack");
    let absents: Vec<&AdvancedMediaBinding> = copy
        .media_bindings
        .iter()
        .filter(|binding| binding.asset_ref.starts_with("absent"))
        .collect();
    assert_eq!(absents.len(), 2, "un emplacement manquant par Écran");
    assert!(absents
        .iter()
        .all(|binding| binding.path.is_none() && binding.status == MediaBindingStatus::Missing));
}

#[test]
fn un_media_partage_n_a_qu_une_liaison() {
    let shared = json!({ "itemImage": "/travail/commun.png" });
    let project = free_project(
        json!([story("s1", shared.clone()), story("s2", shared)]),
        json!({}),
    );
    let copy = assert_faithful_copy(&project);
    let bound = copy
        .media_bindings
        .iter()
        .filter(|binding| binding.path.as_deref() == Some("/travail/commun.png"))
        .count();
    assert_eq!(bound, 1);
}

#[test]
fn un_pack_inclus_refuse_la_copie() {
    let project = free_project(
        json!([
            story("s1", json!({})),
            { "id": "z1", "type": "zip", "name": "Pack inclus", "zipPath": "/travail/inclus.zip",
              "audio": null, "image": null, "itemAudio": null, "itemImage": null },
        ]),
        json!({}),
    );
    let refusal = graph_copy_of_project(&project).expect_err("pack inclus");
    assert!(crate::support::user_message::contains_code(
        &refusal,
        "GRAPH_COPY_INCLUDED_PACK"
    ));
}

#[test]
fn une_identite_illisible_refuse_la_copie() {
    let mut project = free_project(json!([story("s1", json!({}))]), json!({}));
    project.pack_uuid = "pas une identité".to_string();
    assert!(crate::support::user_message::contains_code(
        &graph_copy_of_project(&project).expect_err("identité"),
        "GRAPH_COPY_INVALID_IDENTITY"
    ));
}

#[test]
fn la_garde_refuse_une_copie_qui_ne_produirait_pas_le_meme_pack() {
    let project = free_project(
        json!([story("s1", json!({})), story("s2", json!({}))]),
        json!({}),
    );
    let copy = graph_copy_of_project(&project).expect("copie graphe");
    let mut decoded = decode_authoring_payload(&copy.payload).expect("payload relu");
    let stage = decoded
        .document
        .stage_nodes
        .iter_mut()
        .find(|stage| !stage.is_square_one() && stage.ok_transition.is_value())
        .expect("un Écran avec une suite");
    stage.ok_transition = Presence::Null;
    let altered = encode_authoring_payload(&decoded).expect("payload réécrit");
    let refusal = verify_graph_copy(&project, &altered).expect_err("écart de structure");
    assert!(
        crate::support::user_message::contains_code(&refusal, "GRAPH_COPY_UNFAITHFUL_DETAIL"),
        "{refusal}"
    );
}

/// Lit le `story.json` d'une archive produite.
fn story_of_zip(zip_path: &Path) -> StoryDocument {
    let file = fs::File::open(zip_path).expect("archive lisible");
    let mut archive = zip::ZipArchive::new(file).expect("archive ZIP");
    let mut entry = archive.by_name("story.json").expect("story.json présent");
    let mut text = String::new();
    std::io::Read::read_to_string(&mut entry, &mut text).expect("story.json lisible");
    serde_json::from_str(&text).expect("story.json décodable")
}

fn media_entry_count(zip_path: &Path) -> usize {
    let file = fs::File::open(zip_path).expect("archive lisible");
    let archive = zip::ZipArchive::new(file).expect("archive ZIP");
    archive
        .file_names()
        .filter(|name| name.starts_with("assets/"))
        .count()
}

/// Projets témoins, sur la machine de l'auteur : chacun est copié vers le
/// graphe, puis **les deux packs sont réellement produits** — par la chaîne
/// par menus et par l'export graphe — et leurs `story.json` comparés.
#[test]
#[ignore = "projets privés : STORY_STUDIO_GRAPH_COPY_PROJECTS pointe vers des exports JSON temporaires"]
fn les_projets_temoins_produisent_le_meme_pack_depuis_leur_copie_graphe() {
    let input = std::path::PathBuf::from(
        std::env::var("STORY_STUDIO_GRAPH_COPY_PROJECTS")
            .expect("STORY_STUDIO_GRAPH_COPY_PROJECTS requis"),
    );
    let mut projects = fs::read_dir(&input)
        .expect("dossier des projets exportés")
        .map(|entry| entry.expect("entrée lisible").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    projects.sort();
    assert!(!projects.is_empty(), "aucun projet témoin");

    let output = std::env::temp_dir().join(format!("graph-copy-witnesses-{}", now_millis()));
    let mut failures = Vec::new();
    for path in &projects {
        let label = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let project: Project =
            serde_json::from_slice(&fs::read(path).expect("projet lisible")).expect("projet");
        let copy = assert_faithful_copy(&project);

        let free_dir = output.join(format!("{label}-menus"));
        let free = crate::native_pack::generate_native_pack_v1_with_cancel(
            &project,
            free_dir.to_str().expect("chemin UTF-8"),
            &|_| {},
            &|| false,
        )
        .unwrap_or_else(|error| panic!("[{label}] génération par menus : {error}"));

        let graph_dir = output.join(format!("{label}-graphe"));
        let options = crate::native_pack::advanced_export::AdvancedAudioOptions {
            silence_mode: project.global_options.silence_mode(),
            harmonize_loudness: project.global_options.harmonize_loudness,
            leading_silence_sec: project.global_options.leading_silence_duration_sec(),
            trailing_silence_sec: project.global_options.trailing_silence_duration_sec(),
        };
        let graph = crate::native_pack::advanced_export::export_advanced_pack_with_cancel(
            &copy.payload,
            &copy.media_bindings,
            &graph_dir,
            &options,
            None,
            None,
            Some(&project.name),
            project.thumbnail_image.as_deref().map(Path::new),
            &|_| {},
            &|| false,
        )
        .unwrap_or_else(|error| panic!("[{label}] export graphe : {error:?}"));

        let free_zip = Path::new(&free.zip_path);
        let graph_zip = Path::new(&graph.zip_path);
        let report = crate::native_pack::fidelity_judge::compare_documents_structural(
            &story_of_zip(graph_zip),
            &story_of_zip(free_zip),
        );
        println!(
            "[{label}] Écrans {} / {} ; médias {} / {} ; même structure : {}",
            report.generated_stage_count,
            report.oracle_stage_count,
            media_entry_count(graph_zip),
            media_entry_count(free_zip),
            report.faithful,
        );
        if !report.faithful {
            failures.push(format!("[{label}] {}", report.gaps.join(" ; ")));
        }
    }
    let _ = fs::remove_dir_all(&output);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// La copie est rangée avant d'être écrite, par les deux gestes du rangement
/// de l'atelier. Ce rangement ne touche que des positions : la garde doit
/// toujours voir le même pack.
#[test]
fn le_rangement_avant_ecriture_garde_la_meme_structure() {
    use crate::native_pack::editing::{apply_advanced_gesture, AdvancedGesture};

    let project = free_project(
        json!([menu(
            "m1",
            json!([story("s1", json!({})), story("s2", json!({}))]),
            json!({})
        )]),
        json!({}),
    );
    let copy = graph_copy_of_project(&project).expect("copie graphe");
    let decoded = decode_authoring_payload(&copy.payload).expect("payload relu");
    let stages = decoded
        .document
        .stage_nodes
        .iter()
        .map(|stage| ("stage", stage.uuid.clone()));
    let actions = decoded
        .document
        .action_nodes
        .iter()
        .map(|action| ("action", action.id.clone()));
    let positions: Vec<Value> = stages
        .chain(actions)
        .enumerate()
        .map(|(index, (kind, id))| {
            json!({ "node": { "kind": kind, "id": id }, "position": { "x": index * 40, "y": 0 } })
        })
        .collect();

    let staged: AdvancedGesture =
        serde_json::from_value(json!({ "gesture": "apply-view-layout", "positions": positions }))
            .expect("geste de disposition");
    let promoted: AdvancedGesture = serde_json::from_value(
        json!({ "gesture": "apply-layout-to-authoring", "nodes": [], "outOfRange": "refuse" }),
    )
    .expect("geste de promotion");
    let first = apply_advanced_gesture(&copy.payload, copy.media_bindings.clone(), &staged)
        .expect("disposition acceptée");
    let arranged = apply_advanced_gesture(&first.payload, first.media_bindings, &promoted)
        .expect("promotion acceptée");

    assert_ne!(
        arranged.payload, copy.payload,
        "le rangement a bien écrit des positions"
    );
    verify_graph_copy(&project, &arranged.payload).expect("même structure après rangement");
}

#[test]
fn official_graph_copy_only_refuses_flattened_foreign_origins() {
    use crate::domain::official_provenance::OfficialProvenance;
    use crate::native_pack::output_identity::for_context;
    for origin in [PACK_UUID, "00000000-0000-4000-8000-00000000000c"] {
        let mut project = free_project(
            json!([story(
                "s1",
                json!({"officialProvenance":"official", "officialOriginUuid":origin})
            )]),
            json!({}),
        );
        project.official_provenance = OfficialProvenance::Official;
        project.official_origin_uuid = Some(PACK_UUID.into());
        let copy = assert_faithful_copy(&project);
        let decoded = decode_authoring_payload(&copy.payload).unwrap();
        let decision = for_context(&decoded.context, PACK_UUID, None);
        if origin == PACK_UUID {
            let mut story = json!({"uuid":PACK_UUID});
            decision.unwrap().apply(&mut story);
            assert_eq!(story["official"], true);
            assert_eq!(story["uuid"], PACK_UUID);
            assert!(!decoded.context.contains_official_content);
        } else {
            assert_eq!(
                decision.unwrap_err().code,
                "OFFICIAL_CONTENT_OUTPUT_REFUSED"
            );
            assert!(decoded.context.contains_official_content);
        }
    }
}

#[test]
fn unknown_graph_copy_origins_are_recognized_again_at_each_export() {
    use crate::native_pack::output_identity::{for_context, for_project};
    use crate::services::official_packs::OfficialCatalogue;
    use crate::support::user_message::UserMessage;
    const C: &str = "00000000-0000-4000-8000-00000000000c";
    struct Catalogue;
    impl OfficialCatalogue for Catalogue {
        type Error = UserMessage;
        fn contains_official(&self, uuid: &str) -> Result<bool, UserMessage> {
            Ok(uuid == C || uuid == PACK_UUID)
        }
    }
    for origin in [PACK_UUID, C] {
        let project = free_project(
            json!([story(
                "s1",
                json!({"officialProvenance":"unknown", "packUuid":origin})
            )]),
            json!({}),
        );
        let copy = assert_faithful_copy(&project);
        let decoded = decode_authoring_payload(&copy.payload).unwrap();
        assert!(!decoded.context.contains_official_content);
        assert!(for_context(&decoded.context, PACK_UUID, None).is_ok());
        if origin == C {
            assert_eq!(decoded.context.foreign_pack_uuids, vec![C]);
            assert_eq!(
                UserMessage::from(for_project(&project, Some(&Catalogue)).unwrap_err()).code,
                "OFFICIAL_CONTENT_OUTPUT_REFUSED"
            );
            assert_eq!(
                for_context(&decoded.context, PACK_UUID, Some(&Catalogue))
                    .unwrap_err()
                    .code,
                "OFFICIAL_CONTENT_OUTPUT_REFUSED"
            );
        } else {
            assert!(decoded.context.foreign_pack_uuids.is_empty());
            assert!(for_context(&decoded.context, PACK_UUID, Some(&Catalogue)).is_ok());
        }
    }
    // Old persisted contexts carried only the boolean.
    let mut context = crate::native_pack::StoryDocumentContext::created();
    context.contains_official_content = true;
    let context: crate::native_pack::StoryDocumentContext =
        serde_json::from_value(serde_json::to_value(context).unwrap()).unwrap();
    assert_eq!(
        for_context(&context, PACK_UUID, None).unwrap_err().code,
        "OFFICIAL_CONTENT_OUTPUT_REFUSED"
    );
}
