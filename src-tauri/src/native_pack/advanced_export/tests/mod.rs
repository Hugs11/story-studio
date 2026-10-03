//! Suite de tests de l'export avancé.
//!
//! **Aucun média privé, aucun double de ce qu'on prétend éprouver.** Les
//! fixtures sont synthétisées ici : WAV écrits octet par octet, images encodées
//! par la bibliothèque déjà présente. Ni le codec, ni la readiness, ni la
//! préparation, ni la préparation des médias, ni le writer, ni le lecteur de
//! pack ne sont remplacés par un double — les tests traversent les fonctions
//! réelles, et ceux qui exigent un transcodage le disent quand l'outil n'est pas
//! résolu au lieu de se déclarer verts.
//!
//! Les documents sans audio n'exigent pas FFmpeg : c'est délibéré, pour que les
//! propriétés de structure — identité, ordre, présence-sensibilité, refus —
//! soient éprouvées sur toute machine, y compris là où l'outil manque.

mod determinism;
mod export;
mod readback;
mod refusals;

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::*;
use crate::native_pack::persistence::{
    create_advanced_document, decode_authoring_payload, encode_authoring_payload,
    initialize_advanced_document, AdvancedMediaBinding, MediaBindingStatus,
};
use crate::native_pack::{
    decode_story_document, DecodedStoryDocument, Presence, StoryDocumentContext,
};
use crate::support::ffmpeg::{get_ffmpeg_path, now_millis};

pub(super) const ENTRY: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
pub(super) const SECOND: &str = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
pub(super) const THIRD: &str = "cccccccc-dddd-4eee-8fff-000000000000";
/// Identifiant bridge-compatible **sans tirets** : l'export le conserve tel
/// quel, et l'export ne doit pas le normaliser au passage.
pub(super) const HYPHENLESS: &str = "123E4567E89B12D3A456426614174001";
pub(super) const SAMPLE_RATE: u32 = 44_100;

/// Retire, puis rend, le droit d'écriture sur un dossier — sur les trois
/// systèmes.
///
/// Les bits de mode POSIX n'ont aucun effet sous Windows, où le droit
/// d'écriture est porté par l'ACL. Les deux acceptations `output-write` ne
/// pouvaient donc s'exprimer qu'en `cfg(unix)`, et ce chemin de refus n'avait
/// aucune couverture unitaire sous Windows — précisément la plateforme où
/// l'application est utilisée.
///
/// Le verrouillage n'est jamais **supposé** : `deny_writes` constate qu'une
/// écriture échoue réellement avant de rendre la main. Un `chmod` sans effet —
/// compte privilégié, montage particulier, système de fichiers sans
/// permissions — ferait sinon passer un dossier ordinaire pour un dossier
/// verrouillé, et le test se déclarerait vert sans avoir rien éprouvé.
pub(super) fn deny_writes(directory: &Path) {
    set_write_permission(directory, false);
    assert!(
        !is_writable(directory),
        "le dossier {} est resté inscriptible : le refus d'écriture n'a pas pris effet",
        directory.display()
    );
}

/// Rend le droit d'écriture. Séparée de `deny_writes` parce que l'appelant doit
/// pouvoir la lancer **avant** d'affirmer quoi que ce soit : un test qui
/// échoue ne doit pas laisser un dossier verrouillé derrière lui.
pub(super) fn allow_writes(directory: &Path) {
    set_write_permission(directory, true);
}

#[cfg(unix)]
fn set_write_permission(directory: &Path, writable: bool) {
    use std::os::unix::fs::PermissionsExt;

    let mode = if writable { 0o700 } else { 0o500 };
    let _ = fs::set_permissions(directory, fs::Permissions::from_mode(mode));
}

#[cfg(windows)]
fn set_write_permission(directory: &Path, writable: bool) {
    let account = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(domain), Ok(user)) => format!("{domain}\\{user}"),
        (_, Ok(user)) => user,
        _ => return,
    };
    let mut command = std::process::Command::new("icacls");
    command.arg(directory);
    if writable {
        command.arg("/remove:d").arg(&account);
    } else {
        command.arg("/deny").arg(format!("{account}:(WD,AD)"));
    }
    let _ = command.output();
}

/// Le seul juge du verrouillage : une écriture réelle, tentée puis effacée.
fn is_writable(directory: &Path) -> bool {
    let probe = directory.join(format!(".ecriture-{}", std::process::id()));
    match fs::write(&probe, b"x") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Un dossier de travail propre, jeté à la fin du test.
pub(super) struct Scratch {
    pub(super) root: PathBuf,
}

impl Scratch {
    pub(super) fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "story_studio_p2_05_{}_{}_{}",
            name,
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&root).expect("créer le dossier de test");
        Self { root }
    }

    pub(super) fn dir(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir_all(&path).expect("créer un sous-dossier de test");
        path
    }

    /// Dossier de destination d'un export, créé par le préflight lui-même.
    pub(super) fn output(&self) -> PathBuf {
        self.root.join("out")
    }

    pub(super) fn write_media(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.dir("media").join(name);
        fs::write(&path, bytes).expect("écrire la source média");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// L'outil embarqué, s'il est résolu. Sinon le test le **dit** et s'arrête.
pub(super) fn ffmpeg_or_skip(test: &str) -> bool {
    match get_ffmpeg_path() {
        Ok(_) => true,
        Err(error) => {
            eprintln!("[export avancé] {test} non exécuté : FFmpeg non résolu ({error})");
            false
        }
    }
}

// ---------------------------------------------------------------- fixtures

pub(super) fn png_bytes(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let image = image::RgbImage::from_fn(width, height, |x, y| {
        let horizontal = (x * 255 / width.max(1)) as u8;
        let vertical = (y * 255 / height.max(1)) as u8;
        match seed % 3 {
            0 => image::Rgb([horizontal, 20, 20]),
            1 => image::Rgb([20, vertical, 20]),
            _ => image::Rgb([20, 20, horizontal.wrapping_add(vertical)]),
        }
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .expect("encoder la fixture image");
    out
}

/// Un WAV PCM 16 bits mono : un format que l'export doit convertir.
pub(super) fn wav_bytes(seconds: f64, frequency: f64) -> Vec<u8> {
    let count = (SAMPLE_RATE as f64 * seconds) as usize;
    let samples: Vec<i16> = (0..count)
        .map(|index| {
            let phase =
                2.0 * std::f64::consts::PI * frequency * index as f64 / f64::from(SAMPLE_RATE);
            (phase.sin() * 0.6 * f64::from(i16::MAX)) as i16
        })
        .collect();
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in &samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

pub(super) fn controls() -> Value {
    json!({"wheel": false, "ok": false, "home": true, "pause": false, "autoplay": false})
}

/// Un Stage complet : cinq contrôles explicites, médias facultatifs.
pub(super) fn stage(
    uuid: &str,
    square_one: bool,
    audio: Option<&str>,
    image: Option<&str>,
) -> Value {
    json!({
        "uuid": uuid,
        "squareOne": square_one,
        "audio": audio,
        "image": image,
        "controlSettings": controls(),
        "okTransition": null,
        "homeTransition": null
    })
}

/// Un document jouable : l'entrée mène au menu, qui mène aux Stages listés.
///
/// L'entrée n'est jamais un choix, et son Accueil est désactivé : ce sont les
/// règles de navigation de STUdio (`port_rules`), bloquantes à la génération.
/// Sans option, le document n'a qu'un Écran d'entrée terminal, sans menu,
/// comme un projet neuf.
pub(super) fn story_value(stages: Vec<Value>, options: Vec<&str>) -> Value {
    let mut stages = stages;
    let entry = stages
        .iter_mut()
        .find(|stage| stage["squareOne"] == Value::Bool(true))
        .expect("un Stage d'entrée");
    entry["controlSettings"]["home"] = Value::Bool(false);
    assert!(
        !options.contains(&entry["uuid"].as_str().expect("uuid d'entrée")),
        "l'Écran d'entrée ne peut pas être un choix de menu"
    );
    if options.is_empty() {
        return json!({
            "format": "v1",
            "version": 1,
            "title": "Banc export avancé",
            "stageNodes": stages,
            "actionNodes": []
        });
    }
    entry["controlSettings"]["ok"] = Value::Bool(true);
    entry["okTransition"] = json!({"actionNode": "menu", "optionIndex": 0});
    json!({
        "format": "v1",
        "version": 1,
        "title": "Banc export avancé",
        "stageNodes": stages,
        "actionNodes": [{"id": "menu", "options": options}]
    })
}

// ------------------------------------------------------- les trois origines

/// Compteur d'identités : une source injectable, pour qu'aucune preuve
/// d'unicité ne dépende du CSPRNG du système.
pub(super) struct Draws {
    next: u128,
}

impl Draws {
    pub(super) fn new() -> Self {
        Self { next: 0x2000_0000 }
    }

    pub(super) fn next(&mut self) -> uuid::Uuid {
        self.next += 1;
        let mut bytes = [0_u8; 16];
        bytes[..16].copy_from_slice(&self.next.to_be_bytes());
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        uuid::Uuid::from_bytes(bytes)
    }
}

/// Origine « document créé » : identité **générée**, indépendante du Stage
/// d'entrée. Le document neuf reçoit ensuite ses médias.
pub(super) fn created_payload(audio: Option<&str>, image: Option<&str>) -> String {
    let mut draws = Draws::new();
    let payload = create_advanced_document("Projet créé", &mut || draws.next())
        .expect("création d'un document avancé");
    let mut decoded = decode_authoring_payload(&payload).expect("réouverture du document créé");
    let entry = &mut decoded.document.stage_nodes[0];
    entry.control_settings.value_mut().expect("controls").ok = Presence::Value(false);
    entry.audio = audio
        .map(|value| Presence::Value(value.to_string()))
        .unwrap_or(Presence::Null);
    entry.image = image
        .map(|value| Presence::Value(value.to_string()))
        .unwrap_or(Presence::Null);
    encode_authoring_payload(&decoded).expect("réencodage du document créé")
}

/// Origine « importé FS » : contexte de projection natif, identité dérivée du
/// dossier, quadrillage d'éditeur séparé.
pub(super) fn imported_fs_payload(value: Value) -> String {
    let mut decoded = decode_story_document(&value.to_string()).expect("document FS décodable");
    let entry = decoded
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .expect("un Stage d'entrée")
        .uuid
        .clone();
    decoded.context = StoryDocumentContext::imported_fs(&decoded.document, &entry);
    let mut draws = Draws::new();
    initialize_advanced_document(decoded, &mut || draws.next()).expect("acquisition FS")
}

/// Origine « importé STUdio » : elle passe par l'**import réel**, pack ZIP
/// compris, et rend en même temps les liaisons médias que l'acquisition dérive
/// du document. Aucun raccourci de banc ne fabrique ces liaisons.
pub(super) fn imported_studio_project(
    scratch: &Scratch,
    story: &Value,
    assets: &[(&str, Vec<u8>)],
) -> (String, Vec<AdvancedMediaBinding>) {
    let zip_path = scratch.dir("packs").join("studio.zip");
    write_story_zip(&zip_path, story, assets);
    let acquired = crate::services::pack_reader::import_pack_as_advanced_document(
        zip_path.to_str().expect("chemin ZIP"),
        scratch
            .dir("studio-assets")
            .to_str()
            .expect("chemin des assets"),
    )
    .expect("acquisition d'un pack STUdio");
    (acquired.payload, acquired.media_bindings)
}

pub(super) fn write_story_zip(path: &Path, story: &Value, assets: &[(&str, Vec<u8>)]) {
    use std::io::Write;
    let file = fs::File::create(path).expect("créer le ZIP de fixture");
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("story.json", opts).expect("story.json");
    zip.write_all(story.to_string().as_bytes())
        .expect("écrire story.json");
    for (name, bytes) in assets {
        zip.start_file(format!("assets/{name}"), opts)
            .expect("entrée d'asset");
        zip.write_all(bytes).expect("écrire un asset");
    }
    zip.finish().expect("finaliser le ZIP de fixture");
}

// ------------------------------------------------------------- utilitaires

pub(super) fn binding(asset_ref: &str, path: &Path) -> AdvancedMediaBinding {
    AdvancedMediaBinding {
        asset_ref: asset_ref.to_string(),
        path: Some(path.to_string_lossy().to_string()),
        status: MediaBindingStatus::Resolved,
    }
}

pub(super) fn missing_binding(asset_ref: &str) -> AdvancedMediaBinding {
    AdvancedMediaBinding {
        asset_ref: asset_ref.to_string(),
        path: None,
        status: MediaBindingStatus::Missing,
    }
}

/// Raccourci de banc : l'export réel, options par défaut, sans progression ni
/// annulation. Il traverse exactement la fonction que la commande appelle.
pub(super) fn export(
    payload: &str,
    bindings: &[AdvancedMediaBinding],
    output: &Path,
) -> Result<AdvancedExportResult, AdvancedExportError> {
    export_named(payload, bindings, output, None)
}

/// Le même export, avec le nom d'archive que l'appelant demande.
pub(super) fn export_named(
    payload: &str,
    bindings: &[AdvancedMediaBinding],
    output: &Path,
    archive_name: Option<&str>,
) -> Result<AdvancedExportResult, AdvancedExportError> {
    export_advanced_pack_with_cancel(
        payload,
        bindings,
        output,
        &AdvancedAudioOptions::default(),
        archive_name,
        None,
        None,
        None,
        &|_| {},
        &|| false,
    )
}

/// Un drapeau d'annulation **armé par la progression**, et non dès l'appel.
///
/// Une annulation posée avant l'export est interceptée par la première garde
/// venue, bien avant la publication : elle n'éprouve donc pas le transfert. Pour
/// atteindre celui-ci, le banc arme le drapeau au moment où l'export **annonce**
/// le transfert, exactement comme un auteur qui cliquerait « annuler » en voyant
/// ce message. `grace` laisse ensuite passer un nombre choisi de relectures, ce
/// qui permet de viser l'entrée du transfert ou le milieu de sa copie.
pub(super) struct CancelOnTransfer {
    armed: std::sync::atomic::AtomicBool,
    grace: std::sync::atomic::AtomicUsize,
}

impl CancelOnTransfer {
    /// `grace = 0` annule à l'entrée du transfert ; `grace = 1` laisse un bloc
    /// être lu et écrit dans le `.partial` avant d'annuler.
    pub(super) fn new(grace: usize) -> Self {
        Self {
            armed: std::sync::atomic::AtomicBool::new(false),
            grace: std::sync::atomic::AtomicUsize::new(grace),
        }
    }

    pub(super) fn watch(&self, message: &str) {
        if message.contains("Transfert") {
            self.armed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    pub(super) fn cancelled(&self) -> bool {
        if !self.armed.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        let remaining = self.grace.load(std::sync::atomic::Ordering::SeqCst);
        if remaining > 0 {
            self.grace
                .store(remaining - 1, std::sync::atomic::Ordering::SeqCst);
            return false;
        }
        true
    }

    pub(super) fn was_armed(&self) -> bool {
        self.armed.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Relit une archive **publiée** avec un lecteur ZIP ordinaire.
pub(super) fn archive_entries(zip_path: &str) -> BTreeMap<String, Vec<u8>> {
    let file = fs::File::open(zip_path).expect("ouvrir l'archive publiée");
    let mut archive = zip::ZipArchive::new(file).expect("lire l'archive publiée");
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).expect("entrée d'archive");
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).expect("lire une entrée");
        entries.insert(name, bytes);
    }
    entries
}

pub(super) fn story_of(entries: &BTreeMap<String, Vec<u8>>) -> Value {
    serde_json::from_slice(
        entries
            .get("story.json")
            .expect("story.json dans l'archive"),
    )
    .expect("story.json relisible")
}

pub(super) fn asset_names(entries: &BTreeMap<String, Vec<u8>>) -> Vec<String> {
    entries
        .keys()
        .filter_map(|name| name.strip_prefix("assets/"))
        .map(str::to_string)
        .collect()
}

pub(super) fn reopen(payload: &str) -> DecodedStoryDocument {
    decode_authoring_payload(payload).expect("payload relisible")
}
