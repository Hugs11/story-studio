use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

fn fixture(scratch: &Scratch, images: usize) -> (StoryDocument, Vec<AdvancedMediaBinding>) {
    let mut stages = Vec::new();
    let mut bindings = Vec::new();
    for index in 0..images {
        let asset_ref = format!("image-{index:02}.png");
        let source = scratch.write_source("images", &asset_ref, &png_bytes(640, 480, index as u8));
        bindings.push(binding(&asset_ref, &source));
        stages.push(stage(
            &format!("11111111-2222-4333-8444-{index:012}"),
            index == 0,
            None,
            Some(&asset_ref),
        ));
    }
    (document_with(&stages.join(","), ""), bindings)
}

#[test]
fn cancellation_between_conversions_skips_queued_tasks() {
    let ffmpeg = get_ffmpeg_path().expect("FFmpeg requis pour la régression");
    let scratch = Scratch::new("cancel-between-conversions");
    let (document, bindings) = fixture(&scratch, 3);
    let cancel = Arc::new(AtomicBool::new(false));
    let completed = Arc::new(AtomicUsize::new(0));
    // Un seul worker impose une file réelle : le signal est posé à la fin de
    // la première conversion, avant que les deux suivantes puissent démarrer.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap();
    let result = pool.install(|| {
        let stop = Arc::clone(&cancel);
        let count = Arc::clone(&completed);
        AFTER_CONVERSION.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                stop.store(true, Ordering::SeqCst);
            }));
        });
        let result = prepare_storyteller_assets(
            &document,
            &bindings,
            &scratch.workspace(),
            &ffmpeg,
            Some(&cancel),
            &mut |_| {},
        );
        AFTER_CONVERSION.with(|hook| *hook.borrow_mut() = None);
        result
    });
    assert!(
        result.unwrap().is_none(),
        "annulation distincte d'un échec média"
    );
    assert_eq!(completed.load(Ordering::SeqCst), 1);
    let outputs: Vec<_> = fs::read_dir(scratch.workspace().join("outputs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(outputs.len(), 1);
    assert_ne!(
        outputs[0].extension().and_then(|ext| ext.to_str()),
        Some("pending")
    );
    assert!(image::load_from_memory(&fs::read(&outputs[0]).unwrap()).is_ok());
}

#[test]
fn absent_and_inactive_cancellation_preserve_media_bytes_and_reports() {
    let ffmpeg = get_ffmpeg_path().expect("FFmpeg requis pour la régression");
    let scratch = Scratch::new("inactive-cancellation");
    let (mut document, mut bindings) = fixture(&scratch, 2);
    let wav = scratch.write_source("audio", "tone.wav", &wav_bytes(&tone(440.0, 0.1, 0.3)));
    document.stage_nodes[0].audio = crate::native_pack::Presence::Value("tone.wav".into());
    bindings.push(binding("tone.wav", &wav));
    let cancel = AtomicBool::new(false);
    for storyteller in [false, true] {
        let prepare_with = |root: &Path, signal| {
            prepare_assets(
                &document,
                &bindings,
                root,
                &ffmpeg,
                &AdvancedAudioOptions::default(),
                DEFAULT_TOOL_DEADLINE,
                storyteller,
                signal,
                &mut |_| {},
            )
            .unwrap()
            .unwrap()
        };
        let absent = prepare_with(&scratch.root.join(format!("absent-{storyteller}")), None);
        let inactive = prepare_with(
            &scratch.root.join(format!("inactive-{storyteller}")),
            Some(&cancel),
        );
        assert_eq!(absent.assets, inactive.assets);
        assert_eq!(absent.destinations, inactive.destinations);
        assert_eq!(absent.archive_entries.len(), inactive.archive_entries.len());
        for (left, right) in absent.archive_entries.iter().zip(&inactive.archive_entries) {
            assert_eq!(left.archive_name, right.archive_name);
            assert_eq!(left.output_sha256, right.output_sha256);
            assert_eq!(
                fs::read(&left.output_path).unwrap(),
                fs::read(&right.output_path).unwrap()
            );
        }
    }
}

#[test]
fn cancelled_preparation_does_not_open_a_workspace() {
    let scratch = Scratch::new("cancel-before-inventory");
    let (document, bindings) = fixture(&scratch, 1);
    let result = prepare_storyteller_assets(
        &document,
        &bindings,
        &scratch.workspace(),
        Path::new("unused-ffmpeg"),
        Some(&AtomicBool::new(true)),
        &mut |_| panic!("aucune conversion attendue"),
    );
    assert!(result.unwrap().is_none());
    assert!(!scratch.workspace().exists());
}
