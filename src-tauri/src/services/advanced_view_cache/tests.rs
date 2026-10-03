//! Le cache de vue éprouvé sur un disque réel, dans un dossier temporaire.
//!
//! Les contre-exemples sont ici, chacun nommé par le cas qu'il refuse.

use std::fs;
use std::path::PathBuf;

use super::*;

fn temporary_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "story_studio_view_cache_{}_{}_{}",
        name,
        std::process::id(),
        now_ms()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("dossier d'essai");
    root
}

fn saved(identity: &str, path: &str) -> ViewCacheProject {
    ViewCacheProject {
        pack_identity: Some(identity.to_string()),
        save_path: Some(path.to_string()),
        session_dir: None,
    }
}

fn session(identity: &str, dir: &str) -> ViewCacheProject {
    ViewCacheProject {
        pack_identity: Some(identity.to_string()),
        save_path: None,
        session_dir: Some(dir.to_string()),
    }
}

fn view() -> ViewState {
    ViewState {
        viewport: Some(Viewport {
            x: -240.0,
            y: 118.5,
            zoom: 0.75,
        }),
        selection: Selection {
            stages: vec!["/stageNodes/@uuid=s1#0".to_string()],
            actions: vec!["/actionNodes/@id=a1#0".to_string()],
        },
        last_focused_path: Some("/stageNodes/@uuid=s1#0".to_string()),
    }
}

#[test]
fn une_vue_ecrite_se_relit_a_l_identique() {
    let root = temporary_root("aller_retour");
    let project = saved("pack-1", "/home/user/recit.mbah");
    let fingerprint = document_fingerprint("{\"payloadVersion\":1}");
    write_entry(&root, &project, &fingerprint, &view()).expect("écriture");
    let read = read_entry(&root, &project, &fingerprint)
        .expect("lecture")
        .expect("entrée présente");
    assert_eq!(read.view, view());
    assert!(read.fingerprint_matches);
    assert!(!read.viewport_rejected);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn deux_projets_de_meme_identite_ne_partagent_jamais_leur_vue() {
    let root = temporary_root("save_as");
    let fingerprint = document_fingerprint("payload");
    let source = saved("pack-1", "/home/user/recit.mbah");
    let copie = saved("pack-1", "/home/user/recit-copie.mbah");
    // Jamais `packIdentity` seule. Deux Save As du même projet
    // partagent légitimement l'identité.
    assert_ne!(
        source.cache_key().expect("clé"),
        copie.cache_key().expect("clé")
    );
    write_entry(&root, &source, &fingerprint, &view()).expect("écriture");
    assert!(read_entry(&root, &copie, &fingerprint)
        .expect("lecture")
        .is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn une_entree_qui_ne_decrit_pas_le_projet_ouvert_est_ignoree() {
    let root = temporary_root("collision");
    let fingerprint = document_fingerprint("payload");
    let project = saved("pack-1", "/home/user/recit.mbah");
    let key = write_entry(&root, &project, &fingerprint, &view()).expect("écriture");
    // Ceinture de sécurité : l'entrée porte `savePath` et `packIdentity`
    // verbatim, et une entrée qui ne correspond pas est écartée même si la clé
    // du fichier a été atteinte.
    let path = root.join(format!("{key}.json"));
    let mut entry: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("relecture")).expect("JSON");
    entry["project"]["packIdentity"] = serde_json::Value::from("un-autre-pack");
    fs::write(&path, entry.to_string()).expect("réécriture");
    assert!(read_entry(&root, &project, &fingerprint)
        .expect("lecture")
        .is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn la_promotion_d_une_session_renomme_l_entree_sans_la_recreer() {
    let root = temporary_root("promotion");
    let fingerprint = document_fingerprint("payload");
    let ephemere = session("pack-1", "/tmp/story_studio_session_42");
    let enregistre = saved("pack-1", "/home/user/recit.mbah");
    write_entry(&root, &ephemere, &fingerprint, &view()).expect("écriture");
    let renamed = rename_entry(&root, &ephemere, &enregistre)
        .expect("renommage")
        .expect("entrée déplacée");
    assert_eq!(renamed, enregistre.cache_key().expect("clé"));
    // Une seule entrée subsiste : la session n'a pas laissé de doublon.
    let count = fs::read_dir(&root).expect("dossier").flatten().count();
    assert_eq!(count, 1);
    let read = read_entry(&root, &enregistre, &fingerprint)
        .expect("lecture")
        .expect("entrée présente");
    assert_eq!(read.view, view());
    // L'ancienne clé ne rend plus rien.
    assert!(read_entry(&root, &ephemere, &fingerprint)
        .expect("lecture")
        .is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn un_renommage_sans_source_n_invente_aucune_entree() {
    let root = temporary_root("promotion_vide");
    let ephemere = session("pack-1", "/tmp/story_studio_session_7");
    let enregistre = saved("pack-1", "/home/user/recit.mbah");
    assert_eq!(
        rename_entry(&root, &ephemere, &enregistre).expect("renommage"),
        None
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn un_viewport_hors_domaine_est_ecarte_sans_perdre_la_selection() {
    let root = temporary_root("domaine");
    let fingerprint = document_fingerprint("payload");
    let project = saved("pack-1", "/home/user/recit.mbah");
    let key = write_entry(&root, &project, &fingerprint, &view()).expect("écriture");
    let path = root.join(format!("{key}.json"));
    let mut entry: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("relecture")).expect("JSON");
    entry["view"]["viewport"]["zoom"] = serde_json::Value::from(0);
    fs::write(&path, entry.to_string()).expect("réécriture");
    let read = read_entry(&root, &project, &fingerprint)
        .expect("lecture")
        .expect("entrée présente");
    assert!(read.viewport_rejected);
    assert_eq!(read.view.viewport, None);
    // Seul le `viewport` tombe : la sélection reste utilisable.
    assert_eq!(read.view.selection, view().selection);
    assert_eq!(read.view.last_focused_path, view().last_focused_path);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn une_modification_externe_du_fichier_conserve_la_camera() {
    let root = temporary_root("empreinte");
    let project = saved("pack-1", "/home/user/recit.mbah");
    write_entry(&root, &project, &document_fingerprint("avant"), &view()).expect("écriture");
    let read = read_entry(&root, &project, &document_fingerprint("après"))
        .expect("lecture")
        .expect("entrée présente");
    // Une caméra ne s'ancre à aucun nœud : elle survit à la divergence.
    assert!(!read.fingerprint_matches);
    assert_eq!(read.view.viewport, view().viewport);
    // Les ancrages sont rendus tels quels : c'est l'affichage qui les
    // revalide, et les entrées orphelines sont ignorées **sans purge**.
    assert_eq!(read.view.selection, view().selection);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn une_version_inconnue_est_ignoree_sans_etre_reecrite() {
    let root = temporary_root("version");
    let fingerprint = document_fingerprint("payload");
    let project = saved("pack-1", "/home/user/recit.mbah");
    let key = write_entry(&root, &project, &fingerprint, &view()).expect("écriture");
    let path = root.join(format!("{key}.json"));
    let mut entry: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("relecture")).expect("JSON");
    entry["cacheVersion"] = serde_json::Value::from(2);
    let stored = entry.to_string();
    fs::write(&path, &stored).expect("réécriture");
    assert!(read_entry(&root, &project, &fingerprint)
        .expect("lecture")
        .is_none());
    // Rien n'est réécrit du fait de la lecture.
    assert_eq!(fs::read_to_string(&path).expect("relecture"), stored);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn les_champs_inconnus_d_une_version_connue_sont_conserves_verbatim() {
    let root = temporary_root("inconnus");
    let fingerprint = document_fingerprint("payload");
    let project = saved("pack-1", "/home/user/recit.mbah");
    let key = write_entry(&root, &project, &fingerprint, &view()).expect("écriture");
    let path = root.join(format!("{key}.json"));
    let mut entry: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("relecture")).expect("JSON");
    entry["futur"] = serde_json::Value::from("à conserver");
    entry["view"]["collapsed"] = serde_json::json!(["/stageNodes/@uuid=s1#0"]);
    fs::write(&path, entry.to_string()).expect("réécriture");

    let mut moved = view();
    moved.viewport = Some(Viewport {
        x: 12.0,
        y: 34.0,
        zoom: 2.0,
    });
    write_entry(&root, &project, &fingerprint, &moved).expect("réécriture de vue");
    let stored: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("relecture")).expect("JSON");
    assert_eq!(stored["futur"], serde_json::Value::from("à conserver"));
    assert_eq!(
        stored["view"]["collapsed"],
        serde_json::json!(["/stageNodes/@uuid=s1#0"])
    );
    assert_eq!(stored["view"]["viewport"]["zoom"], serde_json::json!(2.0));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn le_dossier_reste_borne_par_l_ecrivain() {
    let root = temporary_root("elagage");
    let fingerprint = document_fingerprint("payload");
    for index in 0..(MAX_ENTRIES + 5) {
        let project = saved("pack-1", &format!("/home/user/recit-{index}.mbah"));
        write_entry(&root, &project, &fingerprint, &view()).expect("écriture");
    }
    let count = fs::read_dir(&root)
        .expect("dossier")
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|value| value == "json")
        })
        .count();
    assert_eq!(count, MAX_ENTRIES);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn une_panne_de_cache_ne_fait_jamais_echouer_une_lecture() {
    // Dossier inexistant : la vue est reconstruite, sans erreur et sans
    // dialogue.
    let root = std::env::temp_dir().join("story_studio_view_cache_absent_totalement");
    let _ = fs::remove_dir_all(&root);
    let project = saved("pack-1", "/home/user/recit.mbah");
    assert_eq!(
        read_entry(&root, &project, &document_fingerprint("payload")).expect("lecture"),
        None
    );
}

#[test]
fn un_projet_sans_ancrage_refuse_de_fabriquer_une_cle() {
    let orphelin = ViewCacheProject {
        pack_identity: Some("pack-1".to_string()),
        save_path: None,
        session_dir: None,
    };
    assert!(orphelin.cache_key().is_err());
    // Un chemin vide n'est pas un ancrage : il ferait converger tous les
    // projets sans chemin sur la même entrée.
    let vide = ViewCacheProject {
        pack_identity: Some("pack-1".to_string()),
        save_path: Some("   ".to_string()),
        session_dir: None,
    };
    assert!(vide.cache_key().is_err());
}

#[test]
fn la_cle_respecte_la_sensibilite_a_la_casse_de_posix() {
    let minuscule = saved("pack-1", "/home/user/recit.mbah");
    let majuscule = saved("pack-1", "/home/User/Recit.mbah");
    // Deux fichiers distincts sous POSIX : deux vues distinctes.
    assert_ne!(
        minuscule.cache_key().expect("clé"),
        majuscule.cache_key().expect("clé")
    );
    // Le même fichier Windows écrit de deux façons : une seule vue.
    let windows = saved("pack-1", r"C:\Users\User\Recit.mbah");
    let windows_autre = saved("pack-1", "c:/users/user/recit.mbah");
    assert_eq!(
        windows.cache_key().expect("clé"),
        windows_autre.cache_key().expect("clé")
    );
}

#[test]
fn l_empreinte_suit_les_octets_exacts_du_payload() {
    assert_eq!(document_fingerprint("a"), document_fingerprint("a"));
    assert_ne!(document_fingerprint("a"), document_fingerprint("b"));
    assert!(document_fingerprint("a").starts_with("sha256:"));
}
