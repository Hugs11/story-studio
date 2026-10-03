//! Validation avant génération selon les réglages actifs.
//!
//! Le constructeur ne lit pas un champ que le réglage courant rend inutile :
//! la validation ne doit donc ni l'exiger ni vérifier son fichier. À l'inverse,
//! tout média qu'il lit est vérifié sur disque, et une destination du message
//! de fin global qui ne mène plus nulle part bloque.

use super::*;
use crate::domain::project::{AfterPlaybackSequenceStep, EntryControlSettings, GlobalOptions};
use std::fs;
use std::path::PathBuf;

/// Dossier temporaire dont les fichiers existent vraiment : la validation
/// disque ne se simule pas.
struct Disk {
    dir: PathBuf,
}

impl Disk {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ss-validation-activity-{tag}-{}-{}",
            std::process::id(),
            crate::support::ffmpeg::now_millis()
        ));
        fs::create_dir_all(&dir).expect("dossier temporaire");
        Self { dir }
    }

    fn file(&self, name: &str) -> String {
        let path = self.dir.join(name);
        fs::write(&path, b"x").expect("fichier temporaire");
        path.to_string_lossy().to_string()
    }

    fn missing(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().to_string()
    }
}

impl Drop for Disk {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn options(auto_next: bool, night_mode: bool) -> GlobalOptions {
    GlobalOptions {
        harmonize_loudness: true,
        add_silence: false,
        silence_mode: None,
        add_silence_duration_sec: crate::domain::project::AudioEdgeSilenceDuration::uniform(1.0),
        auto_next,
        night_mode,
        end_message_autoplay: true,
    }
}

fn story(disk: &Disk, id: &str) -> ProjectEntry {
    ProjectEntry {
        id: id.to_string(),
        entry_type: "story".to_string(),
        name: format!("Histoire {id}"),
        audio: Some(disk.file(&format!("{id}.mp3"))),
        item_audio: Some(disk.file(&format!("{id}-title.mp3"))),
        item_image: Some(disk.file(&format!("{id}-title.png"))),
        ..ProjectEntry::default()
    }
}

fn step(audio: Option<String>, image: Option<String>) -> AfterPlaybackSequenceStep {
    AfterPlaybackSequenceStep {
        id: "step".to_string(),
        name: "Étape".to_string(),
        audio,
        image,
        ..AfterPlaybackSequenceStep::default()
    }
}

fn pack(disk: &Disk, entries: Vec<ProjectEntry>, options: GlobalOptions) -> Project {
    Project {
        name: "Pack".to_string(),
        project_type: Some("pack".to_string()),
        root_audio: Some(disk.file("root.mp3")),
        root_image: Some(disk.file("root.png")),
        thumbnail_image: Some(disk.file("thumb.png")),
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        pack_version: 1,
        pack_description: String::new(),
        pack_uuid: String::new(),
        root_entries: entries,
        shared_entries: Vec::new(),
        global_options: options,
    }
}

// --- Destinations de fin inactives sous Auto-next ---

fn stale_end_targets(disk: &Disk) -> Vec<ProjectEntry> {
    let mut a = story(disk, "a");
    a.return_after_play = Some("story:gone".to_string());
    a.after_playback_prompt_audio = Some(disk.file("a-end.mp3"));
    a.after_playback_prompt_ok_target = Some("story:gone".to_string());
    a.after_playback_prompt_home_target = Some("menu:gone".to_string());
    let mut b = story(disk, "b");
    b.after_playback_sequence = vec![AfterPlaybackSequenceStep {
        ok_target: Some("story:gone".to_string()),
        home_target: Some("story:gone".to_string()),
        ok_choice_targets: vec!["story:gone".to_string(), "story:a".to_string()],
        ..step(Some(disk.file("b-end.mp3")), None)
    }];
    vec![ProjectEntry {
        id: "menu".to_string(),
        entry_type: "menu".to_string(),
        name: "Dossier".to_string(),
        audio: Some(disk.file("menu.mp3")),
        image: Some(disk.file("menu.png")),
        return_after_play: Some("story:gone".to_string()),
        children: vec![a, b],
        ..ProjectEntry::default()
    }]
}

#[test]
fn auto_next_ignores_inactive_end_targets() {
    let disk = Disk::new("z1-04");
    let project = pack(&disk, stale_end_targets(&disk), options(true, false));
    validate_project_for_generation(&project)
        .expect("les destinations de fin inactives sous Auto-next ne bloquent pas");
}

#[test]
fn without_auto_next_the_same_end_targets_block() {
    let disk = Disk::new("z1-04-control");
    let project = pack(&disk, stale_end_targets(&disk), options(false, false));
    let errors = validate_project_for_generation(&project).expect_err("destinations actives");
    assert!(errors.contains("introuvable"), "{errors}");
}

// --- Médias de fin inactifs sous Auto-next ---

#[test]
fn auto_next_ignores_inactive_end_media() {
    let disk = Disk::new("z1-05");
    let mut a = story(&disk, "a");
    a.after_playback_prompt_audio = Some(disk.missing("a-end.mp3"));
    let mut b = story(&disk, "b");
    b.after_playback_sequence = vec![step(Some(disk.missing("b-end.mp3")), None)];
    let project = pack(&disk, vec![a, b], options(true, false));
    validate_project_for_generation(&project)
        .expect("un média de fin inactif sous Auto-next n'est pas vérifié");
}

#[test]
fn without_auto_next_a_lost_prompt_blocks() {
    let disk = Disk::new("z1-05-control");
    let mut a = story(&disk, "a");
    a.after_playback_prompt_audio = Some(disk.missing("a-end.mp3"));
    let project = pack(&disk, vec![a, story(&disk, "b")], options(false, false));
    validate_project_for_generation(&project).expect_err("prompt actif perdu");
}

// --- Écran transparent ---

#[test]
fn transparent_menu_image_is_not_checked() {
    let disk = Disk::new("r01");
    let menu = ProjectEntry {
        id: "menu".to_string(),
        entry_type: "menu".to_string(),
        name: "Dossier".to_string(),
        audio: Some(disk.file("menu.mp3")),
        image: Some(disk.missing("menu.png")),
        auto_black_image: true,
        children: vec![story(&disk, "a"), story(&disk, "b")],
        ..ProjectEntry::default()
    };
    let project = pack(&disk, vec![menu], options(false, false));
    validate_project_for_generation(&project)
        .expect("l'image d'un Écran transparent n'est pas lue");
}

// --- Message de fin global qu'aucune histoire n'emprunte ---

fn local_ends(disk: &Disk) -> Vec<ProjectEntry> {
    let mut a = story(disk, "a");
    a.after_playback_prompt_audio = Some(disk.file("a-end.mp3"));
    let mut b = story(disk, "b");
    b.after_playback_sequence = vec![step(Some(disk.file("b-end.mp3")), None)];
    vec![a, b]
}

#[test]
fn unused_global_end_audio_is_not_checked() {
    let disk = Disk::new("z1-02");
    let mut project = pack(&disk, local_ends(&disk), options(false, true));
    project.night_mode_audio = Some(disk.missing("global.mp3"));
    validate_project_for_generation(&project)
        .expect("un message global qu'aucune histoire n'emprunte n'est pas vérifié");
}

#[test]
fn global_end_audio_used_by_one_story_is_checked() {
    let disk = Disk::new("z1-02-control");
    let mut entries = local_ends(&disk);
    entries.push(story(&disk, "c"));
    let mut project = pack(&disk, entries, options(false, true));
    project.night_mode_audio = Some(disk.missing("global.mp3"));
    let errors = validate_project_for_generation(&project).expect_err("message global emprunté");
    assert!(errors.contains("Audio mode nuit"), "{errors}");
}

// --- Destination du message de fin global supprimée ---

fn global_end_project(disk: &Disk) -> Project {
    let mut project = pack(
        disk,
        vec![story(disk, "a"), story(disk, "b")],
        options(false, true),
    );
    project.night_mode_audio = Some(disk.file("global.mp3"));
    project
}

#[test]
fn deleted_global_end_return_target_blocks() {
    let disk = Disk::new("z1-01-ok");
    let mut project = global_end_project(&disk);
    project.night_mode_return = Some("story:gone".to_string());
    let errors = validate_project_for_generation(&project).expect_err("destination OK perdue");
    assert!(errors.contains("Message de fin"), "{errors}");
}

#[test]
fn deleted_global_end_home_target_blocks() {
    let disk = Disk::new("z1-01-home");
    let mut project = global_end_project(&disk);
    project.night_mode_home_return = Some("menu:gone".to_string());
    let errors = validate_project_for_generation(&project).expect_err("destination Accueil perdue");
    assert!(errors.contains("Message de fin"), "{errors}");
}

#[test]
fn existing_or_empty_global_end_targets_pass() {
    let disk = Disk::new("z1-01-control");
    let mut project = global_end_project(&disk);
    validate_project_for_generation(&project).expect("cibles vides : retour par défaut");
    project.night_mode_return = Some("story:b".to_string());
    project.night_mode_home_return = Some("next_story".to_string());
    validate_project_for_generation(&project).expect("cibles existantes");
}

// --- Étape de fin sans audio (acceptée) ---

#[test]
fn silent_end_step_is_accepted() {
    let disk = Disk::new("z1-03");
    let mut a = story(&disk, "a");
    a.after_playback_sequence = vec![step(None, None)];
    let project = pack(&disk, vec![a, story(&disk, "b")], options(false, false));
    validate_project_for_generation(&project).expect("écran muet accepté");
}

// --- Médias de la réaction Accueil et images d'étapes ---

fn home_reaction_project(
    disk: &Disk,
    sequence: Vec<AfterPlaybackSequenceStep>,
    home_step: Option<AfterPlaybackSequenceStep>,
) -> Project {
    let mut a = story(disk, "a");
    a.after_playback_sequence = sequence;
    a.after_playback_home_step = home_step;
    pack(disk, vec![a, story(disk, "b")], options(false, false))
}

fn two_steps(disk: &Disk) -> Vec<AfterPlaybackSequenceStep> {
    vec![
        step(Some(disk.file("end-1.mp3")), None),
        step(Some(disk.file("end-2.mp3")), None),
    ]
}

#[test]
fn disabled_home_reaction_media_and_targets_are_not_checked() {
    let disk = Disk::new("disabled-home-reaction");
    let mut reaction = step(
        Some(disk.missing("home.mp3")),
        Some(disk.missing("home.png")),
    );
    reaction.home_target = Some("story:deleted".to_string());
    let mut project = home_reaction_project(&disk, two_steps(&disk), Some(reaction));
    project.root_entries[0].control_settings = Some(EntryControlSettings {
        home: Some(false),
        ..Default::default()
    });
    validate_project_for_generation(&project).expect("réaction inactive ignorée");
}

#[test]
fn lost_home_reaction_audio_blocks() {
    let disk = Disk::new("r05-audio");
    let project = home_reaction_project(
        &disk,
        two_steps(&disk),
        Some(step(Some(disk.missing("home.mp3")), None)),
    );
    validate_project_for_generation(&project).expect_err("audio de réaction perdu");
}

#[test]
fn lost_home_reaction_image_blocks() {
    let disk = Disk::new("r05-image");
    let project = home_reaction_project(
        &disk,
        two_steps(&disk),
        Some(step(None, Some(disk.missing("home.png")))),
    );
    validate_project_for_generation(&project).expect_err("image de réaction perdue");
}

#[test]
fn lost_end_step_image_blocks() {
    let disk = Disk::new("r05-step");
    let project = home_reaction_project(
        &disk,
        vec![
            step(
                Some(disk.file("end-1.mp3")),
                Some(disk.missing("end-1.png")),
            ),
            step(Some(disk.file("end-2.mp3")), None),
        ],
        None,
    );
    validate_project_for_generation(&project).expect_err("image d'étape perdue");
}

#[test]
fn lost_end_step_audio_blocks() {
    let disk = Disk::new("r05-step-audio");
    let project = home_reaction_project(
        &disk,
        vec![step(Some(disk.missing("end-1.mp3")), None)],
        None,
    );
    validate_project_for_generation(&project).expect_err("audio d'étape perdu");
}

#[test]
fn home_reaction_without_media_passes() {
    let disk = Disk::new("r05-control");
    let project = home_reaction_project(&disk, two_steps(&disk), Some(step(None, None)));
    validate_project_for_generation(&project).expect("réaction sans média");
}

#[test]
fn home_reaction_not_written_by_a_single_step_is_not_checked() {
    let disk = Disk::new("r05-single");
    let project = home_reaction_project(
        &disk,
        vec![step(Some(disk.file("end-1.mp3")), None)],
        Some(step(Some(disk.missing("home.mp3")), None)),
    );
    validate_project_for_generation(&project).expect("réaction non écrite");
}

// --- Une cible « Retour de fin – X » suit l'activité de la réaction de X ---
//
// Le constructeur ne construit la réaction Accueil de X que si
// `end_home_step_is_active` : une cible `story_home_step:X` vers une réaction
// non construite ne se résoudrait pas (Lien) ou retomberait en silence sur un
// repli (destination de fin). Elle est donc « à corriger ».

enum HomeStepTargetVia {
    Link,
    EndDestination,
}

fn home_step_target_project(
    disk: &Disk,
    x_home: bool,
    x_steps: usize,
    auto_next: bool,
    via: HomeStepTargetVia,
) -> Project {
    let mut x = story(disk, "x");
    x.after_playback_sequence = (0..x_steps)
        .map(|index| step(Some(disk.file(&format!("x-end-{index}.mp3"))), None))
        .collect();
    x.after_playback_home_step = Some(step(None, None));
    x.control_settings = Some(EntryControlSettings {
        home: Some(x_home),
        ..Default::default()
    });
    let mut entries = vec![x];
    match via {
        HomeStepTargetVia::Link => {
            entries.push(story(disk, "y"));
            entries.push(ProjectEntry {
                id: "lien".to_string(),
                entry_type: "ref".to_string(),
                name: "Lien".to_string(),
                target: Some("story_home_step:x".to_string()),
                ..ProjectEntry::default()
            });
        }
        HomeStepTargetVia::EndDestination => {
            let mut y = story(disk, "y");
            y.after_playback_sequence = vec![AfterPlaybackSequenceStep {
                ok_target: Some("story_home_step:x".to_string()),
                ..step(Some(disk.file("y-end.mp3")), None)
            }];
            entries.push(y);
        }
    }
    pack(disk, entries, options(auto_next, false))
}

#[test]
fn link_to_the_home_reaction_of_a_story_whose_home_is_disabled_blocks() {
    let disk = Disk::new("c5-link-home");
    let project = home_step_target_project(&disk, false, 2, false, HomeStepTargetVia::Link);
    let errors = validate_project_for_generation(&project).expect_err("réaction non construite");
    assert!(errors.contains("retour de fin introuvable"), "{errors}");
}

#[test]
fn link_to_the_home_reaction_of_a_single_step_end_blocks() {
    let disk = Disk::new("c5-link-single");
    let project = home_step_target_project(&disk, true, 1, false, HomeStepTargetVia::Link);
    let errors = validate_project_for_generation(&project).expect_err("réaction non construite");
    assert!(errors.contains("retour de fin introuvable"), "{errors}");
}

#[test]
fn link_to_a_home_reaction_under_auto_next_blocks() {
    let disk = Disk::new("c5-link-auto-next");
    let project = home_step_target_project(&disk, true, 2, true, HomeStepTargetVia::Link);
    let errors = validate_project_for_generation(&project).expect_err("réaction non construite");
    assert!(errors.contains("retour de fin introuvable"), "{errors}");
}

#[test]
fn end_destination_to_the_home_reaction_of_a_story_whose_home_is_disabled_blocks() {
    let disk = Disk::new("c5-end-home");
    let project =
        home_step_target_project(&disk, false, 2, false, HomeStepTargetVia::EndDestination);
    let errors = validate_project_for_generation(&project).expect_err("réaction non construite");
    assert!(errors.contains("retour de fin introuvable"), "{errors}");
}

#[test]
fn targets_to_a_built_home_reaction_pass() {
    let disk = Disk::new("c5-built");
    for via in [HomeStepTargetVia::Link, HomeStepTargetVia::EndDestination] {
        let project = home_step_target_project(&disk, true, 2, false, via);
        validate_project_for_generation(&project).expect("réaction construite");
    }
}
