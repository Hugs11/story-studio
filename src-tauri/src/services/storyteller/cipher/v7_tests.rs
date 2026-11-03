use super::tests::{fake_md, scratch};
use super::*;

fn fake_v7(root: &Path) {
    fake_md(root);
    let mut md = fs::read(root.join(".md")).unwrap();
    md.resize(128, 0);
    md[..2].copy_from_slice(&7u16.to_le_bytes());
    fs::write(root.join(".md"), md).unwrap();
}
#[test]
fn synthetic_v7_manual_material_and_known_ciphertext() {
    let root = scratch();
    fake_v7(&root.0);
    let cipher = DeviceCipher::from_metadata(&root.0).unwrap();
    assert_eq!(cipher.metadata.version, 7);
    assert_eq!(
        cipher.key,
        [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12]
    );
    assert_eq!(
        cipher.iv,
        [19, 18, 17, 16, 23, 22, 21, 20, 27, 26, 25, 24, 31, 30, 29, 28]
    );
    assert_eq!(&cipher.bt, b"01234567890123\0\0\0\0\0\0\0\0\0\x0001234567");
    // Independent AES-CBC vector checked with OpenSSL enc, zero plaintext,
    // explicit manual key/IV above, no padding. No device secrets.
    let mut bytes = vec![0; 16];
    cipher.encrypt_prefix(&mut bytes);
    assert_eq!(
        bytes,
        [
            0x78, 0x0d, 0xfc, 0x19, 0x35, 0x02, 0x77, 0x25, 0xdc, 0x79, 0xf4, 0x01, 0xae, 0x2a,
            0x3c, 0x3f
        ]
    );
    for len in [0, 1, 17, 511, 512, 513, 1025] {
        let plain: Vec<_> = (0..len).map(|n| (n % 251) as u8).collect();
        let mut encrypted = plain[..len.min(512)].to_vec();
        cipher.encrypt_prefix(&mut encrypted);
        encrypted.extend_from_slice(&plain[len.min(512)..]);
        assert_eq!(cipher.decrypt(&encrypted, Some(len)).unwrap(), plain);
    }
}
#[test]
fn story_recipe_survives_firmware_update_and_rejects_garbage_headers() {
    let root = scratch();
    fake_md(&root.0);
    let v6 = DeviceCipher::from_metadata(&root.0).unwrap();
    let mut old_image = b"BM synthetic bitmap".to_vec();
    v6.encrypt_prefix(&mut old_image);
    fake_v7(&root.0);
    let v7 = DeviceCipher::from_metadata(&root.0).unwrap();
    let legacy = DeviceCipher::for_story(&root.0, &v6.bt).unwrap();
    assert_eq!(legacy.key, v6.key);
    assert_eq!(legacy.iv, v6.iv);
    assert!(legacy.decrypt(&old_image, None).unwrap().starts_with(b"BM"));
    let current = DeviceCipher::for_story(&root.0, &v7.bt).unwrap();
    assert_eq!(current.key, v7.key);
    assert!(!current
        .decrypt(&old_image, None)
        .unwrap()
        .starts_with(b"BM"));
}
#[test]
#[ignore = "E15: local secret fixtures outside repository; never print material"]
fn real_v7_equivalence_e15() {
    let (Some(md), Some(story)) = (
        std::env::var_os("STORY_STUDIO_V7_MD"),
        std::env::var_os("STORY_STUDIO_V7_STORY"),
    ) else {
        return;
    };
    let root = scratch();
    fs::copy(md, root.0.join(".md")).unwrap();
    let story = PathBuf::from(story);
    let bt = fs::read(story.join("bt")).unwrap();
    let cipher = DeviceCipher::for_story(&root.0, &bt).unwrap();
    // Boolean assertions deliberately cannot dump secrets on failure.
    assert!(cipher.metadata.version == 7);
    assert!(bt == cipher.bt);
    for (index, folder, image) in [("ri", "rf", true), ("si", "sf", false)] {
        let records = cipher
            .decrypt(&fs::read(story.join(index)).unwrap(), None)
            .unwrap();
        let mut count = 0;
        for record in records.chunks_exact(12) {
            if record.iter().all(|b| *b == 0) {
                continue;
            }
            assert!(&record[..4] == b"000\\");
            let name = std::str::from_utf8(&record[4..]).unwrap();
            let bytes = fs::read(story.join(folder).join("000").join(name)).unwrap();
            let plain = cipher.decrypt(&bytes, None).unwrap();
            assert!(if image {
                plain.starts_with(b"BM")
            } else {
                plain.starts_with(b"ID3")
                    || (plain.len() > 1 && plain[0] == 0xff && plain[1] & 0xe0 == 0xe0)
            });
            count += 1;
        }
        assert!(count > 0);
    }
}
