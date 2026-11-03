use super::*;
use crate::{
    domain::official_provenance::OfficialProvenance,
    native_pack::output_identity::authorize_storyteller,
    native_pack::{self, Presence, StoryDocument, StoryDocumentContext},
};
use serde_json::json;
use std::cell::RefCell;

const UUID: &str = "00000000-0000-4000-8000-123456ABCDEF";
const CHILD: &str = "00000000-0000-4000-8000-000000000002";

#[test]
fn media_preparation_without_cancellation_matches_baseline() {
    use sha2::{Digest, Sha256};
    let scratch = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let source = scratch.0.join("image.png");
    image::RgbImage::from_pixel(640, 480, image::Rgb([120, 80, 40]))
        .save(&source)
        .unwrap();
    let bindings = vec![AdvancedMediaBinding {
        asset_ref: "entry.bmp".into(),
        path: Some(source.to_string_lossy().into_owned()),
        status: native_pack::persistence::MediaBindingStatus::Resolved,
    }];
    let paths = media::prepare(
        &document(false),
        &bindings,
        &scratch.0.join("conversions"),
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap();
    let bytes = fs::read(&paths["entry.bmp"]).unwrap();
    // Référence mesurée avec les sources de HEAD, extraites par git show
    // avant correction : cette attente ne provient pas du code corrigé.
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        "2af39d6f8198b0df285a075feae3c167f7d0353265c94d61b5845476b4a2a698"
    );
}

#[test]
fn cancelling_media_preparation_starts_no_conversion() {
    let scratch = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let source = scratch.0.join("image.png");
    image::RgbImage::from_pixel(640, 480, image::Rgb([120, 80, 40]))
        .save(&source)
        .unwrap();
    let bindings = vec![AdvancedMediaBinding {
        asset_ref: "entry.bmp".into(),
        path: Some(source.to_string_lossy().into_owned()),
        status: native_pack::persistence::MediaBindingStatus::Resolved,
    }];
    let owned = scratch.0.join("conversions");
    let cancel = AtomicBool::new(false);
    let mut notices = 0;
    let error = media::prepare(&document(false), &bindings, &owned, &cancel, &mut |_| {
        notices += 1;
        cancel.store(true, Ordering::SeqCst);
    })
    .unwrap_err();
    assert_eq!(notices, 1);
    assert_eq!(error.code, codes::GENERATION_CANCELLED);
    assert_eq!(
        fs::read_dir(owned.join("assets/outputs")).unwrap().count(),
        0,
        "aucune conversion ne doit démarrer après la demande d'annulation"
    );

    // Le chemin d'envoi possède le workspace : il le détruit sur annulation,
    // puis un nouvel envoi dans le même cache doit réussir sans reliquat.
    let cache = scratch.0.join("cache");
    let output = scratch.0.join("output");
    fs::create_dir_all(&output).unwrap();
    cancel.store(false, Ordering::SeqCst);
    let authorized = authorization(&document(false));
    let error = write_plain_story_observed(
        &authorized,
        &bindings,
        &output,
        &cache,
        &cancel,
        &mut |_| cancel.store(true, Ordering::SeqCst),
    )
    .unwrap_err();
    assert_eq!(error.code, codes::GENERATION_CANCELLED);
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&output).unwrap().count(), 0);
    cancel.store(false, Ordering::SeqCst);
    super::write_plain_story(&authorized, &bindings, &output, &cache, &cancel).unwrap();
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
}

thread_local! { static STOP_AFTER: RefCell<Option<String>> = const { RefCell::new(None) }; }
pub(super) fn after_write(path: &Path, cancel: &AtomicBool) {
    // Observe the destination while writing, before cleanup can hide an
    // accidental conversion workspace on the output volume.
    let staging = path
        .ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == "story"))
        .unwrap()
        .parent()
        .unwrap();
    assert!(fs::read_dir(staging)
        .unwrap()
        .all(|e| e.unwrap().file_name() == "story"));
    STOP_AFTER.with(|stop| {
        if stop
            .borrow()
            .as_ref()
            .is_some_and(|suffix| path.ends_with(suffix))
        {
            cancel.store(true, Ordering::Relaxed);
        }
    });
}
fn document(night: bool) -> StoryDocument {
    serde_json::from_value(json!({"uuid":UUID,"version":7,"nightModeAvailable":night,
        "stageNodes":[
            {"uuid":UUID,"squareOne":true,"image":"entry.bmp","audio":null,
             "controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false},
             "okTransition":{"actionNode":"a","optionIndex":-1},"homeTransition":null},
            {"uuid":CHILD,"image":null,"audio":null,
             "controlSettings":{"wheel":false,"ok":false,"home":true,"pause":true,"autoplay":false},
             "okTransition":null,"homeTransition":null}],
        "actionNodes":[{"id":"a","options":[CHILD]}]})).unwrap()
}
fn authorization(doc: &StoryDocument) -> StorytellerAuthorization {
    authorize_storyteller(&serde_json::to_string(doc).unwrap(), None).unwrap()
}
// Headless entry points receive the application cache explicitly. Each test
// owns a separate on-disk cache; production resolves it through AppHandle.
fn write_plain_story(
    authorization: &StorytellerAuthorization,
    bindings: &[AdvancedMediaBinding],
    output: &Path,
    cancel: &AtomicBool,
) -> Result<PlainStory> {
    let cache = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let mut bindings = bindings.to_vec();
    if authorization
        .document()
        .stage_nodes
        .iter()
        .any(|s| s.image.value().is_some_and(|r| r == "entry.bmp"))
    {
        let path = cache.0.join("entry.bmp");
        fs::write(&path, bitmap()).unwrap();
        bindings.push(AdvancedMediaBinding {
            asset_ref: "entry.bmp".into(),
            path: Some(path.to_string_lossy().into_owned()),
            status: native_pack::persistence::MediaBindingStatus::Resolved,
        });
    }
    super::write_plain_story(authorization, &bindings, output, &cache.0, cancel)
}
fn write_catalogue_pack(
    target: &Target,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<PlainStory> {
    let cache = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    super::write_catalogue_pack_in(target, catalogue, output, &cache.0, cancel)
}
fn payload(doc: &StoryDocument, context: StoryDocumentContext) -> String {
    let mut decoded =
        native_pack::decode_story_document(&serde_json::to_string(doc).unwrap()).unwrap();
    decoded.context = context;
    native_pack::persistence::encode_authoring_payload(&decoded).unwrap()
}
fn int(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn actual_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            if p.is_dir() {
                actual_size(&p)
            } else {
                fs::metadata(p).unwrap().len()
            }
        })
        .sum()
}
fn re_read(path: &Path, owned: &Path) -> StoryDocument {
    let zip = owned.join(format!("{}.zip", uuid::Uuid::new_v4()));
    crate::support::fs_pack_reader::read_cleartext_fs_pack_to_studio_zip(
        path,
        &zip,
        "test",
        &AtomicBool::new(false),
    )
    .unwrap();
    let raw = native_pack::output_identity::read_story_text(&zip).unwrap();
    native_pack::decode_story_document(&raw).unwrap().document
}
#[test]
fn indexes_night_random_absent_transitions_and_structural_rereading() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    for night in [false, true] {
        let dir = Scratch::new(&base.0).unwrap();
        let doc = document(night);
        let written =
            write_plain_story(&authorization(&doc), &[], &dir.0, &AtomicBool::new(false)).unwrap();
        assert_eq!(written.path.file_name().unwrap(), "56ABCDEF");
        assert_eq!(written.uuid, uuid::Uuid::parse_str(UUID).unwrap());
        assert_eq!(written.total_bytes, actual_size(&written.path));
        let mut names: Vec<_> = fs::read_dir(&written.path)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let expected = if night {
            vec!["li", "ni", "nm", "rf", "ri", "sf", "si"]
        } else {
            vec!["li", "ni", "rf", "ri", "sf", "si"]
        };
        assert_eq!(names, expected);
        let ni = fs::read(written.path.join("ni")).unwrap();
        assert_eq!(ni.len(), 512 + 44 * 2);
        assert_eq!(&ni[..4], &[1, 0, 7, 0]);
        for (offset, value) in [(4, 512), (8, 44), (12, 2), (16, 1), (20, 0)] {
            assert_eq!(int(&ni, offset), value);
        }
        assert_eq!(ni[24], 1);
        assert!(ni[25..512].iter().all(|b| *b == 0));
        for (offset, value) in [
            (512, 0),
            (516, -1),
            (520, 0),
            (524, 1),
            (528, -1),
            (532, -1),
            (536, -1),
            (540, -1),
        ] {
            assert_eq!(int(&ni, offset), value);
        }
        assert_eq!(int(&ni, 512 + 44 + 8), -1);
        assert_eq!(&ni[512 + 42..512 + 44], &[0, 0]);
        let li = fs::read(written.path.join("li")).unwrap();
        assert_eq!(li.len(), 16);
        assert_eq!(int(&li, 0), 1);
        assert!(li[4..].iter().all(|b| *b == 0));
        assert_eq!(
            fs::metadata(written.path.join("nm")).ok().map(|m| m.len()),
            if night { Some(0) } else { None }
        );
        let read = re_read(&written.path, &dir.0);
        let report = native_pack::fidelity_judge::compare_documents_structural(&doc, &read);
        assert!(report.faithful, "{:?}", report.gaps);
        assert_eq!(read.night_mode_available.value(), Some(&night));
    }
}
#[test]
fn media_index_padding_boundaries_and_hex_names() {
    for count in [0, 1, 2, 3, 4, 42, 43, 44, 128] {
        let index = indexes::media_index(count).unwrap();
        let logical = count * 12;
        let expected = if logical < 512 {
            logical.div_ceil(16) * 16
        } else {
            logical
        };
        assert_eq!(index.len(), expected);
        for (rank, record) in index[..logical].chunks_exact(12).enumerate() {
            assert_eq!(record, format!("000\\{rank:08X}").as_bytes());
        }
        assert!(index[logical..].iter().all(|b| *b == 0));
    }
    for n in [0usize, 4, 16, 508, 512, 516, 524] {
        let mut bytes = vec![1; n];
        indexes::pad(&mut bytes);
        assert_eq!(bytes.len(), if n < 512 { n.div_ceil(16) * 16 } else { n });
    }
}
#[test]
fn media_deduplication_entry_reordering_and_cross_references() {
    let mut doc = document(false);
    doc.stage_nodes[0].image = Presence::Value("image".into());
    doc.stage_nodes[0].audio = Presence::Value("one".into());
    doc.stage_nodes[1].image = Presence::Value("image".into());
    doc.stage_nodes[1].audio = Presence::Value("two".into());
    doc.stage_nodes.swap(0, 1);
    let layout = indexes::encode(&doc).unwrap();
    assert_eq!(layout.images, vec!["image"]);
    assert_eq!(layout.sounds, vec!["one", "two"]);
    for (offset, value) in [(16, 1), (20, 2), (512, 0), (516, 0), (556, 0), (560, 1)] {
        assert_eq!(int(&layout.ni, offset), value);
    }
    assert_eq!(int(&layout.li, 0), 1);
}
struct Fake;
impl OfficialCatalogue for Fake {
    type Error = UserMessage;
    fn contains_official(&self, uuid: &str) -> Result<bool> {
        Ok(native_pack::output_identity::same(uuid, UUID))
    }
}
#[test]
fn refuses_official_provenance_current_uuid_and_nested_content_before_output() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let doc = document(false);
    let mut provenance = StoryDocumentContext::created();
    provenance.official_provenance = OfficialProvenance::Official;
    let mut flattened = StoryDocumentContext::created();
    flattened.contains_official_content = true;
    for context in [provenance, flattened] {
        let err = authorize_storyteller(&payload(&doc, context), None)
            .and_then(|authorized| {
                write_plain_story(&authorized, &[], &base.0, &AtomicBool::new(false))
            })
            .unwrap_err();
        assert_eq!(err.code, codes::STORYTELLER_OFFICIAL_REFUSED);
    }
    // Isolate the nested UUID from the root UUID recognition.
    let mut other = doc.clone();
    other.uuid = Presence::Value(CHILD.into());
    other.stage_nodes[0].uuid = CHILD.into();
    other.stage_nodes[1].uuid = "00000000-0000-4000-8000-000000000003".into();
    other.action_nodes[0].options = vec![Some(other.stage_nodes[1].uuid.clone())];
    let mut context = StoryDocumentContext::created();
    context.foreign_pack_uuids = vec![UUID.into()];
    assert_eq!(
        authorize_storyteller(&payload(&other, context), Some(&Fake))
            .unwrap_err()
            .code,
        codes::STORYTELLER_OFFICIAL_REFUSED
    );
    assert_eq!(
        authorize_storyteller(&serde_json::to_string(&doc).unwrap(), Some(&Fake))
            .unwrap_err()
            .code,
        codes::STORYTELLER_OFFICIAL_REFUSED
    );
    assert_eq!(fs::read_dir(&base.0).unwrap().count(), 0);
}
#[test]
fn interruption_at_each_index_removes_staging_and_never_publishes() {
    for name in ["ni", "li", "nm", "ri", "si"] {
        let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
        STOP_AFTER.with(|stop| *stop.borrow_mut() = Some(name.into()));
        let error = write_plain_story(
            &authorization(&document(true)),
            &[],
            &base.0,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        STOP_AFTER.with(|stop| *stop.borrow_mut() = None);
        assert_eq!(error.code, codes::GENERATION_CANCELLED);
        assert_eq!(fs::read_dir(&base.0).unwrap().count(), 0);
    }
}
#[test]
fn existing_directory_is_never_replaced_and_invalid_graph_is_not_written() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let final_path = base.0.join("56ABCDEF");
    fs::create_dir(&final_path).unwrap();
    fs::write(final_path.join("keep"), b"keep").unwrap();
    assert!(write_plain_story(
        &authorization(&document(false)),
        &[],
        &base.0,
        &AtomicBool::new(false)
    )
    .is_err());
    assert_eq!(fs::read(final_path.join("keep")).unwrap(), b"keep");
    let mut doc = document(false);
    doc.action_nodes[0].options = vec![Some("missing".into())];
    assert!(
        write_plain_story(&authorization(&doc), &[], &base.0, &AtomicBool::new(false)).is_err()
    );
    assert_eq!(fs::read_dir(&base.0).unwrap().count(), 1);
}

/// Synthetic solid-colour RLE4 bitmap; bytes describe the test fixture only.
pub(super) fn bitmap() -> Vec<u8> {
    let mut bytes = vec![0; 118];
    bytes[..2].copy_from_slice(b"BM");
    bytes[10..14].copy_from_slice(&118u32.to_le_bytes());
    bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
    bytes[18..22].copy_from_slice(&320i32.to_le_bytes());
    bytes[22..26].copy_from_slice(&240i32.to_le_bytes());
    bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
    bytes[28..30].copy_from_slice(&4u16.to_le_bytes());
    bytes[30..34].copy_from_slice(&2u32.to_le_bytes());
    bytes[46..50].copy_from_slice(&16u32.to_le_bytes());
    for colour in 0..16 {
        for channel in 0..3 {
            bytes[54 + colour * 4 + channel] = (colour * 17) as u8;
        }
    }
    for _ in 0..240 {
        bytes.extend([255, 0x11, 65, 0x11, 0, 0]);
    }
    bytes.extend([0, 1]);
    let length = bytes.len() as u32;
    bytes[2..6].copy_from_slice(&length.to_le_bytes());
    bytes[34..38].copy_from_slice(&(length - 118).to_le_bytes());
    bytes
}
fn media_fixture(base: &Path) -> (StoryDocument, Vec<AdvancedMediaBinding>) {
    let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().expect("FFmpeg for media tests");
    let sound = base.join("input.wav");
    let status = std::process::Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.2",
            "-ar",
            "22050",
            "-ac",
            "2",
            "-y",
        ])
        .arg(&sound)
        .status()
        .unwrap();
    assert!(status.success());
    let image = base.join("input.bmp");
    fs::write(&image, bitmap()).unwrap();
    let mut doc = document(true);
    for stage in &mut doc.stage_nodes {
        stage.image = Presence::Value("image.bmp".into());
        stage.audio = Presence::Value("sound.wav".into());
    }
    let bindings = [("image.bmp", image), ("sound.wav", sound)]
        .into_iter()
        .map(|(asset_ref, path)| AdvancedMediaBinding {
            asset_ref: asset_ref.into(),
            path: Some(path.to_string_lossy().into_owned()),
            status: native_pack::persistence::MediaBindingStatus::Resolved,
        })
        .collect();
    (doc, bindings)
}
#[test]
fn real_media_chain_transcodes_audio_preserves_rle4_and_rereads_structurally() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let (doc, bindings) = media_fixture(&base.0);
    let written = write_plain_story(
        &authorization(&doc),
        &bindings,
        &base.0,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(written.total_bytes, actual_size(&written.path));
    let ni = fs::read(written.path.join("ni")).unwrap();
    assert_eq!(int(&ni, 16), 1);
    assert_eq!(int(&ni, 20), 1);
    for index in ["ri", "si"] {
        let bytes = fs::read(written.path.join(index)).unwrap();
        assert_eq!(&bytes[..12], b"000\\00000000");
        assert_eq!(&bytes[12..], &[0; 4]);
    }
    assert_eq!(
        fs::read(written.path.join("rf/000/00000000")).unwrap(),
        bitmap()
    );
    let mp3 = fs::read(written.path.join("sf/000/00000000")).unwrap();
    let header = native_pack::parse_mpeg_frame_header(&mp3).unwrap();
    assert!(header.is_studio_conform());
    let read = re_read(&written.path, &base.0);
    let report = native_pack::fidelity_judge::compare_documents_structural(&doc, &read);
    assert!(report.faithful, "{:?}", report.gaps);
}
#[test]
fn interruption_during_each_media_phase_never_leaves_final_output() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let (doc, bindings) = media_fixture(&base.0);
    // Both folders use 00000000: choose an injected phase by relative suffix.
    for phase in ["rf/000/00000000", "sf/000/00000000"] {
        STOP_AFTER.with(|stop| *stop.borrow_mut() = Some(phase.into()));
        let result = write_plain_story(
            &authorization(&doc),
            &bindings,
            &base.0,
            &AtomicBool::new(false),
        );
        STOP_AFTER.with(|stop| *stop.borrow_mut() = None);
        assert_eq!(result.unwrap_err().code, codes::GENERATION_CANCELLED);
        assert!(!base.0.join("56ABCDEF").exists());
        assert!(fs::read_dir(&base.0).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".story-studio-conteuse-")));
    }
}
#[test]
fn png_and_jpeg_pack_images_are_converted_and_reread() {
    for format in [image::ImageFormat::Png, image::ImageFormat::Jpeg] {
        let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
        let (doc, bindings) = media_fixture(&base.0);
        let input = image::RgbImage::from_fn(641, 319, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 73])
        });
        let mut encoded = std::io::Cursor::new(Vec::new());
        input.write_to(&mut encoded, format).unwrap();
        fs::write(base.0.join("input.bmp"), encoded.into_inner()).unwrap();
        let story = write_plain_story(
            &authorization(&doc),
            &bindings,
            &base.0,
            &AtomicBool::new(false),
        )
        .unwrap();
        let bmp = fs::read(story.path.join("rf/000/00000000")).unwrap();
        assert_eq!(&bmp[30..34], &2u32.to_le_bytes());
        let decoded = image::load_from_memory(&bmp).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (320, 240));
        let colors: std::collections::HashSet<_> = decoded.pixels().map(|p| p.0).collect();
        assert!(colors.len() <= 16);
        assert!(colors.iter().all(|c| c[0] == c[1] && c[1] == c[2]));
        assert_eq!(story.total_bytes, actual_size(&story.path));
        let read = re_read(&story.path, &base.0);
        assert!(native_pack::fidelity_judge::compare_documents_structural(&doc, &read).faithful);
    }
}

#[test]
fn official_child_is_refused_even_under_the_same_identity_and_before_lock_checks() {
    use native_pack::output_identity::{decide, ContentIdentity, OutputForm};
    let root = ContentIdentity {
        provenance: OfficialProvenance::Unknown,
        uuid: UUID,
        origin_uuid: None,
    };
    let child = ContentIdentity {
        provenance: OfficialProvenance::Official,
        uuid: UUID,
        origin_uuid: Some(UUID),
    };
    assert_eq!(
        decide(
            root,
            OutputForm::Storyteller,
            &[child],
            false,
            None::<&Fake>
        )
        .unwrap_err()
        .code,
        codes::STORYTELLER_OFFICIAL_REFUSED
    );
    let root = ContentIdentity {
        provenance: OfficialProvenance::Official,
        uuid: CHILD,
        origin_uuid: Some(UUID),
    };
    assert_eq!(
        decide(root, OutputForm::Storyteller, &[], false, None::<&Fake>)
            .unwrap_err()
            .code,
        codes::STORYTELLER_OFFICIAL_REFUSED
    );
}

#[test]
fn catalogue_zip_and_studio_directory_reuse_materialization_and_recognition() {
    use crate::services::catalogue::open::target::Observed;
    use std::io::Write;
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let source = base.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::create_dir(source.join("assets")).unwrap();
    let raw = serde_json::to_vec(&document(false)).unwrap();
    fs::write(source.join("story.json"), &raw).unwrap();
    let zip = base.0.join("source.zip");
    let mut archive = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
    archive
        .start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(&raw).unwrap();
    archive
        .start_file("assets/entry.bmp", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(&bitmap()).unwrap();
    archive.finish().unwrap();
    fs::write(source.join("assets/entry.bmp"), bitmap()).unwrap();
    for (path, format) in [(zip, "zip"), (source, "studioDirectory")] {
        let token = crate::services::catalogue::open::target::current_token(
            &path,
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        let target = Target {
            path,
            observation: Some(Observed {
                format: format.into(),
                state: "available".into(),
                token,
                raw: json!({"chain":[]}),
            }),
        };
        let dir = Scratch::new(&base.0).unwrap();
        assert_eq!(
            write_catalogue_pack(&target, Some(&Fake), &dir.0, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            codes::STORYTELLER_OFFICIAL_REFUSED
        );
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
        let story = write_catalogue_pack(&target, None, &dir.0, &AtomicBool::new(false)).unwrap();
        let read = re_read(&story.path, &base.0);
        assert!(
            native_pack::fidelity_judge::compare_documents_structural(&document(false), &read)
                .faithful
        );
    }
}

#[test]
fn contradictory_context_cannot_hide_a_recognized_document_identity() {
    let mut context = StoryDocumentContext::created();
    context.pack_identity.value = Some(CHILD.into());
    assert_eq!(
        authorize_storyteller(&payload(&document(false), context), Some(&Fake))
            .unwrap_err()
            .code,
        codes::STORYTELLER_OFFICIAL_REFUSED
    );
}

#[test]
fn three_padded_media_records_reread_with_exact_counts_and_targets() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let (mut doc, bindings) = media_fixture(&base.0);
    let mut third = doc.stage_nodes[1].clone();
    third.uuid = "00000000-0000-4000-8000-000000000003".into();
    doc.action_nodes[0].options.push(Some(third.uuid.clone()));
    doc.stage_nodes.push(third);
    let mut mapped = Vec::new();
    for (rank, stage) in doc.stage_nodes.iter_mut().enumerate() {
        for (field, source) in [
            (&mut stage.image, &bindings[0]),
            (&mut stage.audio, &bindings[1]),
        ] {
            let mut binding = source.clone();
            binding.asset_ref = format!("{}-{rank}", binding.asset_ref);
            *field = Presence::Value(binding.asset_ref.clone());
            mapped.push(binding);
        }
    }
    let story = write_plain_story(
        &authorization(&doc),
        &mapped,
        &base.0,
        &AtomicBool::new(false),
    )
    .unwrap();
    let ni = fs::read(story.path.join("ni")).unwrap();
    assert_eq!(int(&ni, 16), 3);
    assert_eq!(int(&ni, 20), 3);
    for index in ["ri", "si"] {
        let bytes = fs::read(story.path.join(index)).unwrap();
        assert_eq!(bytes.len(), 48);
        assert_eq!(&bytes[36..], &[0; 12]);
    }
    let read = re_read(&story.path, &base.0);
    assert!(native_pack::fidelity_judge::compare_documents_structural(&doc, &read).faithful);
    assert_eq!(actual_size(&story.path), story.total_bytes);
}

#[test]
fn catalogue_filesystem_pack_uses_the_existing_reader_and_media_chain() {
    use crate::services::catalogue::open::target::Observed;
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let (doc, bindings) = media_fixture(&base.0);
    let source = write_plain_story(
        &authorization(&doc),
        &bindings,
        &base.0,
        &AtomicBool::new(false),
    )
    .unwrap();
    // A filesystem export that retains its full identity. A device suffix alone
    // cannot recover the missing 96 UUID bits and must never invent them.
    let input = base.0.join(UUID);
    fs::rename(&source.path, &input).unwrap();
    fs::write(
        input.join(crate::support::fs_pack_reader::FS_PACK_CLEARTEXT_MARKER),
        [],
    )
    .unwrap();
    let token = crate::services::catalogue::open::target::current_token(
        &input,
        std::time::Duration::from_secs(5),
    )
    .unwrap();
    let target = Target {
        path: input,
        observation: Some(Observed {
            format: "fsDirectory".into(),
            state: "available".into(),
            token,
            raw: json!({"chain":[]}),
        }),
    };
    let out = Scratch::new(&base.0).unwrap();
    let story = write_catalogue_pack(&target, None, &out.0, &AtomicBool::new(false)).unwrap();
    assert!(
        native_pack::fidelity_judge::compare_documents_structural(
            &doc,
            &re_read(&story.path, &base.0)
        )
        .faithful
    );
}

#[test]
fn missing_entry_image_is_typed_and_writes_nothing() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let mut doc = document(false);
    doc.stage_nodes[0].image = Presence::Null;
    let err =
        write_plain_story(&authorization(&doc), &[], &base.0, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.code, codes::STORYTELLER_ENTRY_IMAGE_REQUIRED);
    assert_eq!(fs::read_dir(&base.0).unwrap().count(), 0);
}
#[test]
fn missing_sounds_use_minus_one_and_null_destination_is_refused_at_send() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let mut doc = document(false);
    doc.action_nodes[0].options = vec![None];
    // Encoding still supports the dialect, but D26 now refuses active OK to null.
    let layout = indexes::encode(&doc).unwrap();
    assert_eq!(int(&layout.ni, 20), 0);
    assert_eq!(int(&layout.ni, 516), -1);
    assert_eq!(int(&layout.ni, 560), -1);
    assert_eq!(int(&layout.li, 0), 0);
    let err =
        write_plain_story(&authorization(&doc), &[], &base.0, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.code, codes::STORYTELLER_NAVIGATION_REFUSED);
    assert_eq!(fs::read_dir(&base.0).unwrap().count(), 0);
}
#[test]
fn archive_provenance_cannot_be_erased_by_a_blank_caller_context() {
    use std::io::Write;
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let path = base.0.join("official.zip");
    let mut raw = serde_json::to_value(document(false)).unwrap();
    raw["officialProvenance"] = json!("official");
    raw["context"] = serde_json::to_value(StoryDocumentContext::created()).unwrap();
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(serde_json::to_string(&raw).unwrap().as_bytes())
        .unwrap();
    zip.finish().unwrap();
    // This used to be a caller argument. It is now impossible to pass it to
    // authorization: the source archive is the only authority.
    let _blank_context = StoryDocumentContext::created();
    let output = base.0.join("output");
    fs::create_dir(&output).unwrap();
    let err = authorize_storyteller_path(&path, None)
        .and_then(|authorized| {
            write_plain_story(&authorized, &[], &output, &AtomicBool::new(false))
        })
        .unwrap_err();
    assert_eq!(err.code, codes::STORYTELLER_OFFICIAL_REFUSED);
    assert_eq!(fs::read_dir(&output).unwrap().count(), 0);
}

#[test]
fn conversions_stay_in_the_local_cache_and_cleanup_preserves_its_neighbours() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let (doc, bindings) = media_fixture(&base.0);
    let cache = base.0.join("application-cache");
    fs::create_dir(&cache).unwrap();
    fs::write(cache.join("keep"), b"keep").unwrap();
    let output = base.0.join("output");
    fs::create_dir(&output).unwrap();
    for cancelled in [true, false] {
        if cancelled {
            STOP_AFTER.with(|s| *s.borrow_mut() = Some("ni".into()));
        }
        let result = super::write_plain_story(
            &authorization(&doc),
            &bindings,
            &output,
            &cache,
            &AtomicBool::new(false),
        );
        STOP_AFTER.with(|s| *s.borrow_mut() = None);
        if cancelled {
            assert_eq!(result.unwrap_err().code, codes::GENERATION_CANCELLED);
            assert_eq!(fs::read_dir(&output).unwrap().count(), 0);
        } else {
            let story = result.unwrap();
            assert_eq!(story.total_bytes, actual_size(&story.path));
            assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
        }
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        assert_eq!(fs::read(cache.join("keep")).unwrap(), b"keep");
    }
}

#[test]
fn empty_audio_and_absent_audio_use_minus_one_without_assets() {
    for reference in ["", "   "] {
        let mut doc = document(false);
        doc.stage_nodes[0].audio = Presence::Value(reference.into());
        let layout = indexes::encode(&doc).unwrap();
        assert!(layout.sounds.is_empty());
        assert_eq!(int(&layout.ni, 20), 0);
        assert_eq!(int(&layout.ni, 516), -1);
        assert_eq!(int(&layout.ni, 560), -1);
    }
}

#[test]
fn d26_refuses_each_trapping_port_before_any_write() {
    for code in [
        "ENTRY_STAGE_AS_OPTION",
        "OK_WITHOUT_USABLE_DESTINATION",
        "NO_USABLE_EXIT",
        "OK_LOOPS_TO_SELF",
    ] {
        let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
        let mut raw = serde_json::to_value(document(false)).unwrap();
        match code {
            "ENTRY_STAGE_AS_OPTION" => raw["actionNodes"][0]["options"][0] = json!(UUID),
            "OK_WITHOUT_USABLE_DESTINATION" => raw["stageNodes"][0]["okTransition"] = json!(null),
            "NO_USABLE_EXIT" => raw["stageNodes"][1]["controlSettings"]["home"] = json!(false),
            "OK_LOOPS_TO_SELF" => {
                raw["stageNodes"][1]["controlSettings"]["ok"] = json!(true);
                raw["stageNodes"][1]["okTransition"] = json!({"actionNode":"a","optionIndex":0});
            }
            _ => unreachable!(),
        }
        let doc: StoryDocument = serde_json::from_value(raw).unwrap();
        let err = write_plain_story(&authorization(&doc), &[], &base.0, &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(err.code, codes::STORYTELLER_NAVIGATION_REFUSED);
        assert!(err.params["violations"]
            .as_array()
            .unwrap()
            .contains(&json!(code)));
        assert_eq!(fs::read_dir(&base.0).unwrap().count(), 0);
    }
}
#[test]
fn d26_allows_home_loop_alone() {
    for implicit in [true, false] {
        let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
        let mut raw = serde_json::to_value(document(false)).unwrap();
        if implicit {
            raw["stageNodes"][0]["controlSettings"]["home"] = json!(true);
        } else {
            raw["stageNodes"][1]["homeTransition"] = json!({"actionNode":"a","optionIndex":0});
        }
        let doc = serde_json::from_value(raw).unwrap();
        let violations = native_pack::port_violations(&doc);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].code(), "HOME_LOOPS_TO_SELF");
        write_plain_story(&authorization(&doc), &[], &base.0, &AtomicBool::new(false)).unwrap();
    }
}
#[test]
fn e4_first_attempt_explicit_finish_and_home_to_entry_is_refused() {
    // Synthetic reproduction of first-attempt E4 / TEST-A2: four screens,
    // a choice of two, then a finish and explicit Home returns to the entry.
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let option_two = "00000000-0000-4000-8000-000000000003";
    let finish = "00000000-0000-4000-8000-000000000004";
    let raw = json!({"uuid":UUID,"version":1,"stageNodes":[
        {"uuid":UUID,"squareOne":true,"image":"entry.bmp","audio":null,
         "controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false},
         "okTransition":{"actionNode":"choices","optionIndex":0},"homeTransition":null},
        {"uuid":CHILD,"image":null,"audio":null,
         "controlSettings":{"wheel":true,"ok":true,"home":true,"pause":false,"autoplay":false},
         "okTransition":{"actionNode":"finish","optionIndex":0},
         "homeTransition":{"actionNode":"entry","optionIndex":0}},
        {"uuid":option_two,"image":null,"audio":null,
         "controlSettings":{"wheel":true,"ok":true,"home":true,"pause":false,"autoplay":false},
         "okTransition":{"actionNode":"entry","optionIndex":0},
         "homeTransition":{"actionNode":"entry","optionIndex":0}},
        {"uuid":finish,"image":null,"audio":null,
         "controlSettings":{"wheel":false,"ok":true,"home":true,"pause":false,"autoplay":false},
         "okTransition":{"actionNode":"entry","optionIndex":0},
         "homeTransition":{"actionNode":"entry","optionIndex":0}}],
         "actionNodes":[{"id":"choices","options":[CHILD,option_two]},
             {"id":"finish","options":[finish]},{"id":"entry","options":[UUID]}]});
    let doc = serde_json::from_value(raw).unwrap();
    let err =
        write_plain_story(&authorization(&doc), &[], &base.0, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.code, codes::STORYTELLER_NAVIGATION_REFUSED);
    assert!(err.params["violations"]
        .as_array()
        .unwrap()
        .contains(&json!("ENTRY_STAGE_AS_OPTION")));
    assert_eq!(fs::read_dir(&base.0).unwrap().count(), 0);
}

/// Steps announced while the pack is written (not the ones `send` adds around it).
fn announced_steps(
    doc: &StoryDocument,
    bindings: &[AdvancedMediaBinding],
    base: &Path,
) -> (Vec<PrepStep>, PlainStory) {
    let cache = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let mut steps = Vec::new();
    let story = super::write_plain_story_observed(
        &authorization(doc),
        bindings,
        base,
        &cache.0,
        &AtomicBool::new(false),
        &mut |step| steps.push(step),
    )
    .unwrap();
    (steps, story)
}
fn bound(asset_ref: &str, path: &Path) -> AdvancedMediaBinding {
    AdvancedMediaBinding {
        asset_ref: asset_ref.into(),
        path: Some(path.to_string_lossy().into_owned()),
        status: native_pack::persistence::MediaBindingStatus::Resolved,
    }
}
#[test]
fn conversion_step_is_announced_only_for_media_really_re_encoded() {
    // A stereo 22 kHz WAV is re-encoded: sounds are announced, once.
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let (doc, bindings) = media_fixture(&base.0);
    let out = Scratch::new(&base.0).unwrap();
    let (steps, first) = announced_steps(&doc, &bindings, &out.0);
    assert_eq!(steps, vec![PrepStep::ConvertingSounds]);

    // The MP3 that came out is already conform, and so is the RLE4 bitmap:
    // nothing is re-encoded, nothing is announced.
    let conform = base.0.join("conform.mp3");
    fs::copy(first.path.join("sf/000/00000000"), &conform).unwrap();
    let mut verbatim = doc.clone();
    for stage in &mut verbatim.stage_nodes {
        stage.audio = Presence::Value("sound.mp3".into());
    }
    let bindings = vec![
        bound("image.bmp", &base.0.join("input.bmp")),
        bound("sound.mp3", &conform),
    ];
    let out = Scratch::new(&base.0).unwrap();
    assert!(announced_steps(&verbatim, &bindings, &out.0).0.is_empty());

    // Images only: a PNG becomes the device bitmap, and no sound is involved.
    let png = base.0.join("input.png");
    image::RgbImage::from_fn(64, 48, |x, y| image::Rgb([x as u8, y as u8, 9]))
        .save(&png)
        .unwrap();
    let mut images = verbatim.clone();
    for stage in &mut images.stage_nodes {
        stage.audio = Presence::Absent;
    }
    let out = Scratch::new(&base.0).unwrap();
    assert_eq!(
        announced_steps(&images, &[bound("image.bmp", &png)], &out.0).0,
        vec![PrepStep::ConvertingImages]
    );

    // Both kinds re-encoded: the heavier one, sounds, names the step.
    let out = Scratch::new(&base.0).unwrap();
    let both = [
        bound("image.bmp", &png),
        bound("sound.wav", &base.0.join("input.wav")),
    ];
    assert_eq!(
        announced_steps(&doc, &both, &out.0).0,
        vec![PrepStep::ConvertingSounds]
    );
}

/// The fixture of a damaged pack: the RLE stream of a valid bitmap cut short,
/// as in a truncated download. Bytes describe the test fixture only.
fn truncated_bitmap() -> Vec<u8> {
    let mut bytes = bitmap();
    bytes.truncate(bytes.len() - 57);
    bytes
}
fn damaged_document(name: Option<&str>, image: bool) -> StoryDocument {
    let mut doc = document(false);
    let child = &mut doc.stage_nodes[1];
    child.name = name.map_or(Presence::Absent, |n| Presence::Value(n.into()));
    if image {
        child.image = Presence::Value("broken.bmp".into());
    } else {
        child.audio = Presence::Value("broken.mp3".into());
    }
    doc
}
#[test]
fn unreadable_media_is_refused_naming_its_screen_and_writes_nothing() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let image = base.0.join("broken.bmp");
    fs::write(&image, truncated_bitmap()).unwrap();
    assert!(image::load_from_memory(&truncated_bitmap()).is_err());
    let sound = base.0.join("broken.mp3");
    fs::write(&sound, b"ID3 not really a sound, only bytes").unwrap();
    for (name, is_image, code, unnamed) in [
        (
            Some("La girafe"),
            true,
            codes::STORYTELLER_IMAGE_UNREADABLE,
            codes::STORYTELLER_IMAGE_UNREADABLE_UNNAMED,
        ),
        (
            Some("Le lion"),
            false,
            codes::STORYTELLER_SOUND_UNREADABLE,
            codes::STORYTELLER_SOUND_UNREADABLE_UNNAMED,
        ),
    ] {
        let binding = if is_image {
            bound("broken.bmp", &image)
        } else {
            bound("broken.mp3", &sound)
        };
        let out = Scratch::new(&base.0).unwrap();
        let doc = damaged_document(name, is_image);
        let err = write_plain_story(
            &authorization(&doc),
            std::slice::from_ref(&binding),
            &out.0,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.code, code);
        assert_eq!(err.params["screen"], name.unwrap());
        let text = serde_json::to_string(&err).unwrap();
        assert!(!text.contains("broken") && !text.contains(base.0.to_str().unwrap()));
        assert_eq!(fs::read_dir(&out.0).unwrap().count(), 0, "nothing written");
        // A screen without a name falls back to a sentence without it.
        let doc = damaged_document(Some("  "), is_image);
        let err = write_plain_story(
            &authorization(&doc),
            &[binding],
            &out.0,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.code, unnamed);
        assert!(err.params.is_empty());
        // The send keeps the typed code: safe_reason no longer flattens it.
        assert_eq!(super::send::safe_reason(err).code, unnamed);
    }
}

/// The import-time detection and the send preparation share one rule: a pack
/// flagged at import is refused at send with the same screen, and a pack not
/// flagged is never refused as unreadable.
#[test]
fn import_detection_and_send_refusal_agree_on_every_picture() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let mut garbage = bitmap();
    garbage[..2].copy_from_slice(b"XX");
    let mut wide = png_of(641, 319);
    let cut = wide.len() / 2;
    wide.truncate(cut);
    let samples: Vec<(&str, Vec<u8>)> = vec![
        ("truncated RLE bitmap", truncated_bitmap()),
        ("empty file", Vec::new()),
        ("garbage", b"not a picture".to_vec()),
        ("bad signature", garbage),
        ("truncated png", wide),
        ("valid bitmap", bitmap()),
        ("valid png", png_of(641, 319)),
    ];
    for (label, bytes) in samples {
        let image = base.0.join("broken.bmp");
        fs::write(&image, &bytes).unwrap();
        let flagged = crate::services::catalogue::analyze::image_is_damaged(&bytes);
        let doc = damaged_document(Some("La girafe"), true);
        let out = Scratch::new(&base.0).unwrap();
        let sent = write_plain_story(
            &authorization(&doc),
            &[bound("broken.bmp", &image)],
            &out.0,
            &AtomicBool::new(false),
        );
        let refused = matches!(&sent, Err(e) if e.code == codes::STORYTELLER_IMAGE_UNREADABLE);
        assert_eq!(flagged, refused, "{label}");
        if let Err(e) = &sent {
            if refused {
                assert_eq!(e.params["screen"], "La girafe", "{label}");
            }
        }
    }
}
fn png_of(width: u32, height: u32) -> Vec<u8> {
    let input = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 73])
    });
    let mut encoded = std::io::Cursor::new(Vec::new());
    input
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    encoded.into_inner()
}
