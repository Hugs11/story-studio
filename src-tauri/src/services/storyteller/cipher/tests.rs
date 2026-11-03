use super::*;

pub(super) fn fake_md(root: &Path) {
    let mut bytes = [0; 112];
    bytes[..2].copy_from_slice(&6u16.to_le_bytes());
    bytes[2..7].copy_from_slice(b"3.1.5");
    bytes[26..40].copy_from_slice(b"01234567890123");
    for (i, b) in bytes[64..96].iter_mut().enumerate() {
        *b = i as u8;
    }
    fs::write(root.join(".md"), bytes).unwrap();
}
pub(super) fn scratch() -> Scratch {
    Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap()
}
#[test]
fn synthetic_v6_word_conversion_and_bt_offset() {
    let root = scratch();
    fake_md(&root.0);
    let c = V6Cipher::from_metadata(&root.0).unwrap();
    assert_eq!(&c.key, b"321076541098\x00\x0032");
    assert_eq!(&c.iv, b"\x00\x00\x00\x00\x00\x00\x00\x0032107654");
    assert_eq!(c.bt, std::array::from_fn(|i| i as u8));
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
#[test]
fn nist_sp800_38a_f2_1_four_block_cbc() {
    // Public NIST SP 800-38A F.2.1, AES-128-CBC. No device material.
    let root = scratch();
    fake_md(&root.0);
    let c = V6Cipher {
        material_fingerprint: [0; 32],
        metadata: V6Cipher::from_metadata(&root.0).unwrap().metadata,
        key: hex("2b7e151628aed2a6abf7158809cf4f3c").try_into().unwrap(),
        iv: hex("000102030405060708090a0b0c0d0e0f").try_into().unwrap(),
        bt: [0; 32],
    };
    let plain = hex(concat!(
        "6bc1bee22e409f96e93d7e117393172a",
        "ae2d8a571e03ac9c9eb76fac45af8e51",
        "30c81c46a35ce411e5fbc1191a0a52ef",
        "f69f2445df4f9b17ad2b417be66c3710"
    ));
    let cipher = hex(concat!(
        "7649abac8119b246cee98e9b12e9197d",
        "5086cb9b507219ee95db113a917678b2",
        "73bed6b8e3c1743b7116e69e22229516",
        "3ff1caa1681fac09120eca307586e1a7"
    ));
    let mut actual = plain.clone();
    c.cbc(&mut actual, false);
    assert_eq!(actual, cipher);
    c.cbc(&mut actual, true);
    assert_eq!(actual, plain);
}
#[test]
fn prefix_boundaries_roundtrip_and_clear_tail() {
    let root = scratch();
    fake_md(&root.0);
    let c = V6Cipher::from_metadata(&root.0).unwrap();
    for len in [0usize, 1, 15, 16, 17, 511, 512, 513, 2_000_003] {
        let plain: Vec<_> = (0..len).map(|i| (i % 251) as u8).collect();
        fs::write(root.0.join("input"), &plain).unwrap();
        let out = root.0.join(format!("out-{len}"));
        let size = c
            .copy_file(&root.0.join("input"), &out, true, &AtomicBool::new(false))
            .unwrap();
        let encrypted = fs::read(out).unwrap();
        assert_eq!(
            size as usize,
            if len < 512 {
                len.div_ceil(16) * 16
            } else {
                len
            }
        );
        assert_eq!(c.decrypt(&encrypted, Some(len)).unwrap(), plain);
        if len > 512 {
            assert_eq!(&encrypted[512..], &plain[512..]);
        }
        if len > 0 {
            assert_ne!(&encrypted[..len.min(512)], &plain[..len.min(512)]);
        }
    }
    assert!(c.decrypt(&[0; 15], None).is_err());
    assert!(c.decrypt(&[0; 16], Some(17)).is_err());
    let mut a = vec![1];
    c.encrypt_prefix(&mut a);
    let mut b = vec![1, 0];
    c.encrypt_prefix(&mut b);
    assert_eq!(a, b); // Original media length cannot be inferred from padding.
}
#[test]
fn rejects_unknown_and_malformed_metadata_without_output() {
    let root = scratch();
    for (offset, value) in [(0, 7), (0, 3), (26, b'x'), (2, b'x')] {
        fake_md(&root.0);
        let path = root.0.join(".md");
        let mut bytes = fs::read(&path).unwrap();
        bytes[offset] = value;
        fs::write(path, bytes).unwrap();
        assert_eq!(
            V6Cipher::from_metadata(&root.0).err().unwrap().code,
            codes::STORYTELLER_CIPHER_METADATA_REFUSED
        );
    }
    for size in [0, 1, 40, 96, 111, 113, 128] {
        fake_md(&root.0);
        let mut bytes = fs::read(root.0.join(".md")).unwrap();
        bytes.resize(size, 0);
        fs::write(root.0.join(".md"), bytes).unwrap();
        assert_eq!(
            V6Cipher::from_metadata(&root.0).err().unwrap().code,
            codes::STORYTELLER_CIPHER_METADATA_REFUSED
        );
    }
}
#[test]
fn staged_story_preserves_clear_files_bt_and_source_and_refuses_replacement() {
    let root = scratch();
    fake_md(&root.0);
    let c = V6Cipher::from_metadata(&root.0).unwrap();
    let src = scratch();
    let out = scratch();
    for folder in ["rf/000", "sf/000"] {
        fs::create_dir_all(src.0.join(folder)).unwrap();
        fs::write(src.0.join(folder).join("00000000"), [9; 17]).unwrap();
    }
    for name in ["ni", "nm", "li", "ri", "si"] {
        fs::write(src.0.join(name), [3; 17]).unwrap();
    }
    let plain = PlainStory {
        path: src.0.clone(),
        uuid: uuid::Uuid::new_v4(),
        total_bytes: 119,
    };
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        c.encrypt_story(&plain, &out.0, &cancelled)
            .unwrap_err()
            .code,
        codes::STORYTELLER_SEND_CANCELLED
    );
    assert_eq!(fs::read_dir(&out.0).unwrap().count(), 0);
    let encrypted = c
        .encrypt_story(&plain, &out.0, &AtomicBool::new(false))
        .unwrap();
    for name in ["ni", "nm"] {
        assert_eq!(fs::read(encrypted.path.join(name)).unwrap(), [3; 17]);
    }
    for name in ["li", "ri", "si", "rf/000/00000000", "sf/000/00000000"] {
        let original = fs::read(src.0.join(name)).unwrap();
        assert_eq!(
            c.decrypt(&fs::read(encrypted.path.join(name)).unwrap(), Some(17))
                .unwrap(),
            original
        );
    }
    assert_eq!(
        fs::read(encrypted.path.join("bt")).unwrap(),
        (0..32u8).collect::<Vec<_>>()
    );
    assert_eq!(encrypted.total_bytes, 34 + 5 * 32 + 32);
    assert!(!out.0.join(".pi").exists());
    assert!(c
        .encrypt_story(&plain, &out.0, &AtomicBool::new(false))
        .is_err());
    assert_eq!(fs::read_dir(&out.0).unwrap().count(), 1);
}

/// Manual only. Never run automatically against real device metadata.
#[test]
#[ignore = "E4: requires STORY_STUDIO_E4_MD and STORY_STUDIO_E4_OUTPUT; local staging only"]
fn manufacture_e4_story() {
    let md = std::path::PathBuf::from(
        std::env::var_os("STORY_STUDIO_E4_MD").expect("STORY_STUDIO_E4_MD"),
    );
    assert!(md.is_absolute() && md.file_name().is_some_and(|n| n == ".md"));
    let cipher = V6Cipher::from_metadata(md.parent().unwrap()).unwrap();
    let output = std::path::PathBuf::from(
        std::env::var_os("STORY_STUDIO_E4_OUTPUT").expect("STORY_STUDIO_E4_OUTPUT"),
    );
    fs::create_dir_all(&output).unwrap();
    let cache = scratch();
    let clear = scratch();
    let document_uuid = uuid::Uuid::new_v4();
    let mut bindings = Vec::new();
    for rank in 0..4 {
        let image = cache.0.join(format!("image-{rank}.png"));
        let pixels = image::RgbImage::from_fn(320, 240, |x, y| {
            let stripe = (x / 40) < rank + 1 && x % 40 < 20 && (40..200).contains(&y);
            image::Rgb([if stripe { 255 } else { 0 }; 3])
        });
        pixels.save(&image).unwrap();
        let sound = cache.0.join(format!("sound-{rank}.wav"));
        fs::write(&sound, wave([440., 660., 880., 330.][rank as usize])).unwrap();
        for path in [image, sound] {
            bindings.push(crate::native_pack::persistence::AdvancedMediaBinding {
                asset_ref: path.file_name().unwrap().to_str().unwrap().into(),
                path: Some(path.to_string_lossy().into_owned()),
                status: crate::native_pack::persistence::MediaBindingStatus::Resolved,
            });
        }
    }
    let ids: Vec<_> = (0..4).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    // Navigation follows native_pack::port_rules: the entry is never an option and the
    // default return uses Home without a destination (physical TEST-A2 trapped the device).
    let stages: Vec<_> = (0..4)
        .map(|rank| {
            let ok = rank < 2;
            let action = if rank == 0 { "choices" } else { "finish" };
            serde_json::json!({
                "uuid": ids[rank], "squareOne": rank == 0,
                "image": format!("image-{rank}.png"), "audio": format!("sound-{rank}.wav"),
                "controlSettings": {"wheel": rank == 1 || rank == 2, "ok": ok,
                    "home": rank != 0, "pause": false, "autoplay": false},
                "okTransition": if ok {
                    serde_json::json!({"actionNode": action, "optionIndex": 0})
                } else {
                    serde_json::Value::Null
                },
                "homeTransition": null
            })
        })
        .collect();
    let doc = serde_json::json!({
        "uuid": document_uuid.to_string(), "version": 1, "stageNodes": stages,
        "actionNodes": [
            {"id": "choices", "options": [ids[1], ids[2]]},
            {"id": "finish", "options": [ids[3]]}
        ]
    });
    let parsed: crate::native_pack::StoryDocument = serde_json::from_value(doc.clone()).unwrap();
    crate::native_pack::validate_document_for_studio_compat(&parsed).unwrap();
    let authorized =
        crate::native_pack::output_identity::authorize_storyteller(&doc.to_string(), None).unwrap();
    let cancel = AtomicBool::new(false);
    let plain =
        super::super::write_plain_story(&authorized, &bindings, &clear.0, &cache.0, &cancel)
            .unwrap();
    let encrypted = cipher.encrypt_story(&plain, &output, &cancel).unwrap();
    // E14 verification of this creation only, without logging device material.
    for name in ["li", "ri", "si", "rf/000/00000000", "sf/000/00000000"] {
        let bytes = fs::read(plain.path.join(name)).unwrap();
        assert_eq!(
            cipher
                .decrypt(
                    &fs::read(encrypted.path.join(name)).unwrap(),
                    Some(bytes.len())
                )
                .unwrap(),
            bytes
        );
    }
    let instructions=format!("UUID : {}\nHistoire E4 non officielle, médias synthétiques.\nCopier le dossier {} dans .content/ ; l'inscription de l'UUID dans .pi reste au pilote.\nAccueil : une barre blanche, son 440 Hz. OK ouvre le choix ; Maison inactif.\nMolette : deux barres / son 660 Hz ou trois barres / son 880 Hz.\nOK sur deux barres : fin (quatre barres, son 330 Hz), OK inactif.\nTrois barres est aussi une fin : OK inactif.\nMaison (sans destination) partout sauf à l'accueil : sortie par défaut de l'appareil.\nE14 : identité binaire vérifiée hors appareil sur les trois index et le premier média de chaque type.\nRecette AES V3 à confirmer par cette lecture sur appareil.\n",plain.uuid,encrypted.path.file_name().unwrap().to_string_lossy());
    let mut file = fs::File::create_new(output.join(format!("E4-{}.txt", plain.uuid))).unwrap();
    file.write_all(instructions.as_bytes()).unwrap();
}
pub(super) fn wave(frequency: f64) -> Vec<u8> {
    let rate = 44100u32;
    let samples = rate as usize;
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend((36 + samples as u32 * 2).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(rate.to_le_bytes());
    bytes.extend((rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((samples as u32 * 2).to_le_bytes());
    for i in 0..samples {
        let sample =
            ((i as f64 * frequency * std::f64::consts::TAU / rate as f64).sin() * 6000.) as i16;
        bytes.extend(sample.to_le_bytes());
    }
    bytes
}

thread_local! { static CANCEL_DURING_COPY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
pub(super) fn after_copy_chunk(cancel: &AtomicBool) {
    CANCEL_DURING_COPY.with(|stop| {
        if stop.replace(false) {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
}
#[test]
fn cancellation_during_copy_removes_staging_and_keeps_source() {
    let root = scratch();
    fake_md(&root.0);
    let cipher = V6Cipher::from_metadata(&root.0).unwrap();
    let source = scratch();
    let output = scratch();
    let bytes = vec![42; 200_000];
    fs::write(source.0.join("ni"), &bytes).unwrap();
    let plain = PlainStory {
        path: source.0.clone(),
        uuid: uuid::Uuid::new_v4(),
        total_bytes: bytes.len() as u64,
    };
    CANCEL_DURING_COPY.with(|stop| stop.set(true));
    assert_eq!(
        cipher
            .encrypt_story(&plain, &output.0, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        codes::STORYTELLER_SEND_CANCELLED
    );
    assert_eq!(fs::read_dir(&output.0).unwrap().count(), 0);
    assert_eq!(fs::read(source.0.join("ni")).unwrap(), bytes);
}
#[test]
fn metadata_io_is_distinct_from_format_refusal() {
    let root = scratch();
    assert_eq!(
        V6Cipher::from_metadata(&root.0).err().unwrap().code,
        codes::STORYTELLER_CIPHER_METADATA_IO
    );
}
