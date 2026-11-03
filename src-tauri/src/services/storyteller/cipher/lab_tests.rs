//! Synthetic hardware variants only. No production writer knobs.
use super::tests::{scratch, wave};
use super::*;
use crate::native_pack::{persistence::AdvancedMediaBinding, StoryDocument};
use serde_json::json;

const VARIANTS: [&str; 8] = ["E5a", "E5b", "E5c", "E6a", "E6b", "E6c", "E8a", "E8b"];
fn lab_document(variant: &str) -> StoryDocument {
    let count = match variant {
        "E5a" => 2,
        "E5b" => 8,
        "E5c" => 131,        // 130 options * 4 = 520, each media index = 1572.
        "E8a" | "E8b" => 17, // Includes 10..16: decimal and a..f are observable.
        _ => 3,
    };
    let ids: Vec<_> = (0..count)
        .map(|_| uuid::Uuid::new_v4().to_string())
        .collect();
    let intermediate = variant == "E6a" || variant == "E6b";
    let stages: Vec<_> = (0..count).map(|rank| {
        let media_rank = if variant == "E5a" { 0 } else { rank };
        let ok = count > 1 && (rank == 0 || (intermediate && rank == 1));
        json!({
            "uuid":ids[rank], "squareOne":rank == 0,
            "image":if variant == "E6b" && rank == 1 { serde_json::Value::Null } else { json!(format!("image-{media_rank}.png")) },
            "audio":if variant == "E6a" && rank == 1 { serde_json::Value::Null } else { json!(format!("sound-{media_rank}.wav")) },
            "controlSettings":{"wheel":!intermediate && rank > 0,"ok":ok,"home":rank > 0,"pause":false,"autoplay":false},
            "okTransition":if ok { json!({"actionNode":if rank == 0 {"choices"} else {"finish"},"optionIndex":0}) } else { serde_json::Value::Null },
            "homeTransition":null
        })
    }).collect();
    let actions = if count == 1 {
        vec![]
    } else if intermediate {
        vec![
            json!({"id":"choices","options":[ids[1]]}),
            json!({"id":"finish","options":[ids[2]]}),
        ]
    } else {
        vec![json!({"id":"choices","options":ids[1..]})]
    };
    serde_json::from_value(json!({"uuid":uuid::Uuid::new_v4().to_string(),"version":1,"stageNodes":stages,"actionNodes":actions})).unwrap()
}
fn check_document(doc: &StoryDocument) {
    crate::native_pack::validate_document_for_studio_compat(doc).unwrap();
    super::super::validate_navigation(doc).unwrap();
}

/// Renames encrypted synthetic media and rewrites the corresponding encrypted
/// indexes together. This helper exists only in tests, after the normal writer
/// and D26 have succeeded; production has no naming/factory option.
fn lab_transport_variant(cipher: &V6Cipher, path: &Path, variant: &str) {
    if variant == "E6c" {
        let ni = path.join("ni");
        let mut bytes = fs::read(&ni).unwrap();
        bytes[24] = 0;
        fs::write(ni, bytes).unwrap();
    }
    if !matches!(variant, "E8a" | "E8b") {
        return;
    }
    for (index, folder) in [("ri", "rf"), ("si", "sf")] {
        let index_path = path.join(index);
        let mut bytes = cipher
            .decrypt(&fs::read(&index_path).unwrap(), None)
            .unwrap();
        let ni = fs::read(path.join("ni")).unwrap();
        let offset = if index == "ri" { 16 } else { 20 };
        let count = u32::from_le_bytes(ni[offset..offset + 4].try_into().unwrap()) as usize;
        // Rename via unique temporary names to avoid collisions (e.g. decimal
        // 10 maps onto the old hexadecimal name for 16).
        for rank in 0..count {
            fs::rename(
                path.join(folder).join("000").join(format!("{rank:08X}")),
                path.join(folder)
                    .join("000")
                    .join(format!("pending-{rank}")),
            )
            .unwrap();
        }
        for rank in 0..count {
            let name = if variant == "E8a" {
                format!("{rank:08}")
            } else {
                format!("{rank:08x}")
            };
            bytes[rank * 12 + 4..rank * 12 + 12].copy_from_slice(name.as_bytes());
            fs::rename(
                path.join(folder)
                    .join("000")
                    .join(format!("pending-{rank}")),
                path.join(folder).join("000").join(name),
            )
            .unwrap();
        }
        cipher.cbc(
            &mut bytes[..count.saturating_mul(12).min(512).div_ceil(16) * 16],
            false,
        );
        fs::write(index_path, bytes).unwrap();
    }
}
fn verify_transport(cipher: &V6Cipher, path: &Path, variant: &str) {
    let ni = fs::read(path.join("ni")).unwrap();
    assert_eq!(ni[24], u8::from(variant != "E6c"));
    for (index, folder, offset) in [("ri", "rf", 16), ("si", "sf", 20)] {
        let count = u32::from_le_bytes(ni[offset..offset + 4].try_into().unwrap()) as usize;
        let bytes = cipher
            .decrypt(&fs::read(path.join(index)).unwrap(), None)
            .unwrap();
        for record in bytes[..count * 12].chunks_exact(12) {
            assert_eq!(&record[..4], b"000\\");
            assert!(path
                .join(folder)
                .join("000")
                .join(std::str::from_utf8(&record[4..]).unwrap())
                .is_file());
        }
    }
}
#[test]
fn lab_variants_are_compatible_safe_and_cover_index_boundaries() {
    for variant in VARIANTS {
        let doc = lab_document(variant);
        check_document(&doc);
        assert_eq!(
            uuid::Uuid::parse_str(doc.uuid.value().unwrap())
                .unwrap()
                .get_version_num(),
            4
        );
        let layout = super::super::indexes::encode(&doc).unwrap();
        let raw_li = doc
            .action_nodes
            .iter()
            .map(|a| a.options.len() * 4)
            .sum::<usize>();
        let raw_ri = layout.images.len() * 12;
        let raw_si = layout.sounds.len() * 12;
        match variant {
            "E5a" => {
                assert_eq!([raw_li, raw_ri, raw_si], [4, 12, 12]);
                assert_eq!(doc.stage_nodes.len(), 2);
                let stages = serde_json::to_value(&doc).unwrap();
                let stages = stages["stageNodes"].as_array().unwrap();
                assert_eq!(stages[0]["image"], stages[1]["image"]);
                assert_eq!(stages[0]["audio"], stages[1]["audio"]);
                assert_eq!(stages[0]["controlSettings"]["ok"], true);
                assert_eq!(stages[1]["controlSettings"]["home"], true);
                assert!(stages[1]["homeTransition"].is_null());
            }
            "E5b" => assert!([raw_li, raw_ri, raw_si]
                .iter()
                .all(|n| (16..512).contains(n))),
            "E5c" => assert!([raw_li, raw_ri, raw_si].iter().all(|n| *n > 512)),
            "E6a" => assert_eq!(
                &layout.ni[512 + 44 + 4..512 + 44 + 8],
                &(-1i32).to_le_bytes()
            ),
            "E6b" => assert_eq!(&layout.ni[512 + 44..512 + 44 + 4], &(-1i32).to_le_bytes()),
            _ => {}
        }
    }
}

#[test]
#[ignore = "E5/E6/E8: STORY_STUDIO_E4_MD and STORY_STUDIO_E4_OUTPUT; local staging only"]
fn manufacture_lab_stories() {
    let md = PathBuf::from(std::env::var_os("STORY_STUDIO_E4_MD").expect("STORY_STUDIO_E4_MD"));
    assert!(md.is_absolute() && md.file_name().is_some_and(|n| n == ".md"));
    let cipher = V6Cipher::from_metadata(md.parent().unwrap()).unwrap();
    let output =
        PathBuf::from(std::env::var_os("STORY_STUDIO_E4_OUTPUT").expect("STORY_STUDIO_E4_OUTPUT"));
    fs::create_dir_all(&output).unwrap();
    let mut manifest = String::from("Variante\tUUID\tDossier\tDescription\n");
    for (variant_rank, variant) in VARIANTS.into_iter().enumerate() {
        let doc = lab_document(variant);
        check_document(&doc);
        let cache = scratch();
        let clear = scratch();
        let mut bindings = Vec::new();
        let sound = cache.0.join("tone.wav");
        let frequency = 330. + 110. * variant_rank as f64;
        fs::write(&sound, wave(frequency)).unwrap();
        for (rank, stage) in doc.stage_nodes.iter().enumerate() {
            if let Some(reference) = stage.image.value() {
                let path = cache.0.join(reference);
                let pixels = image::RgbImage::from_fn(320, 240, |x, y| {
                    let bars =
                        x / 36 < variant_rank as u32 + 1 && x % 36 < 18 && (30..190).contains(&y);
                    let marker = y > 210 && x < (rank as u32 % 32) * 10;
                    image::Rgb([if bars || marker { 255 } else { 0 }; 3])
                });
                pixels.save(&path).unwrap();
                bindings.push(AdvancedMediaBinding {
                    asset_ref: reference.clone(),
                    path: Some(path.to_string_lossy().into_owned()),
                    status: crate::native_pack::persistence::MediaBindingStatus::Resolved,
                });
            }
            if let Some(reference) = stage.audio.value() {
                bindings.push(AdvancedMediaBinding {
                    asset_ref: reference.clone(),
                    path: Some(sound.to_string_lossy().into_owned()),
                    status: crate::native_pack::persistence::MediaBindingStatus::Resolved,
                });
            }
        }
        let authorized = crate::native_pack::output_identity::authorize_storyteller(
            &serde_json::to_string(&doc).unwrap(),
            None,
        )
        .unwrap();
        let cancel = AtomicBool::new(false);
        let plain =
            super::super::write_plain_story(&authorized, &bindings, &clear.0, &cache.0, &cancel)
                .unwrap();
        let encrypted = cipher.encrypt_story(&plain, &output, &cancel).unwrap();
        lab_transport_variant(&cipher, &encrypted.path, variant);
        verify_transport(&cipher, &encrypted.path, variant);
        let folder = super::super::story_folder(plain.uuid);
        let purpose = match variant {
            "E5a" => "Deux écrans partageant image et son ; OK sur l’entrée vers l’écran 2, Maison sans destination sur l’écran 2. Index utiles li=4, ri=12, si=12 octets, remplissage à 16.",
            "E5b" => "8 écrans ; li=28, ri=96, si=96 octets utiles (16 à 511).",
            "E5c" => "131 écrans ; li=520, ri=1572, si=1572 octets (>512).",
            "E6a" => "OK : écran intermédiaire muet (son −1), puis OK : fin sonore.",
            "E6b" => "OK : écran intermédiaire sans image (image −1), puis OK : fin illustrée.",
            "E6c" => "Indicateur factory=0 ; toutes les autres variantes ont factory=1.",
            "E8a" => "17 médias de chaque type, noms décimaux (00000010 à 00000016).",
            "E8b" => "17 médias de chaque type, hexa minuscule (0000000a à 0000000f).",
            _ => unreachable!()
        };
        manifest.push_str(&format!("{variant}\t{}\t{folder}\t{purpose}\n", plain.uuid));
        let note = format!("{variant}\nUUID : {}\nDossier : {folder}\nMédias synthétiques : {} barres blanches, ton {frequency} Hz ; marqueur inférieur par écran.\n{purpose}\nAccueil : OK ouvre les choix (E5a : écran 2 avec les mêmes image et son). Molette parcourt les choix ; OK inactif sur les fins. E6a/E6b : progression par OK.\nMaison sans destination sur chaque écran hors entrée ; Maison désactivé sur l’entrée.\nNavigation validée par compatibilité STUdio et D26.\nCopier {folder} dans .content/ ; inscription UUID dans .pi à la charge du pilote.\n",plain.uuid,variant_rank+1);
        let mut file =
            fs::File::create_new(output.join(format!("{variant}-{}.txt", plain.uuid))).unwrap();
        file.write_all(note.as_bytes()).unwrap();
    }
    let mut file =
        fs::File::create_new(output.join(format!("lab-{}.tsv", uuid::Uuid::new_v4()))).unwrap();
    file.write_all(manifest.as_bytes()).unwrap();
}

#[test]
fn lab_only_names_and_factory_rewrites_keep_transport_coherent() {
    let root = scratch();
    super::tests::fake_md(&root.0);
    let cipher = V6Cipher::from_metadata(&root.0).unwrap();
    for variant in ["E6c", "E8a", "E8b"] {
        let doc = lab_document(variant);
        let layout = super::super::indexes::encode(&doc).unwrap();
        let source = scratch();
        let output = scratch();
        for (name, bytes) in [
            ("ni", layout.ni),
            ("li", layout.li),
            (
                "ri",
                super::super::indexes::media_index(layout.images.len()).unwrap(),
            ),
            (
                "si",
                super::super::indexes::media_index(layout.sounds.len()).unwrap(),
            ),
        ] {
            fs::write(source.0.join(name), bytes).unwrap();
        }
        for (folder, count) in [("rf", layout.images.len()), ("sf", layout.sounds.len())] {
            fs::create_dir_all(source.0.join(folder).join("000")).unwrap();
            for rank in 0..count {
                fs::write(
                    source
                        .0
                        .join(folder)
                        .join("000")
                        .join(format!("{rank:08X}")),
                    [rank as u8; 17],
                )
                .unwrap();
            }
        }
        let plain = PlainStory {
            path: source.0.clone(),
            uuid: uuid::Uuid::new_v4(),
            total_bytes: 0,
        };
        let encrypted = cipher
            .encrypt_story(&plain, &output.0, &AtomicBool::new(false))
            .unwrap();
        lab_transport_variant(&cipher, &encrypted.path, variant);
        verify_transport(&cipher, &encrypted.path, variant);
        if variant.starts_with("E8") {
            for rank in 0..17 {
                let name = if variant == "E8a" {
                    format!("{rank:08}")
                } else {
                    format!("{rank:08x}")
                };
                for folder in ["rf", "sf"] {
                    assert_eq!(
                        cipher
                            .decrypt(
                                &fs::read(encrypted.path.join(folder).join("000").join(&name))
                                    .unwrap(),
                                Some(17)
                            )
                            .unwrap(),
                        [rank as u8; 17]
                    );
                }
            }
        }
    }
}
