use super::*;

#[test]
fn validate_pack_asset_name_accepts_asset_paths() {
    assert_eq!(
        validate_pack_asset_name("assets/img.png").unwrap(),
        "assets/img.png"
    );
    assert_eq!(
        validate_pack_asset_name("assets/audio/mp3.mp3").unwrap(),
        "assets/audio/mp3.mp3"
    );
    assert_eq!(
        validate_pack_asset_name("assets/x..%2Fy.png").unwrap(),
        "assets/x..%2Fy.png"
    );
}

#[test]
fn validate_pack_asset_name_rejects_traversal_and_external_paths() {
    for asset_name in [
        "assets/../etc/passwd",
        "assets/./a.png",
        "assets/",
        r"assets/a\b.png",
        "/assets/x.png",
        "img.png",
        "",
        "   ",
    ] {
        assert!(
            validate_pack_asset_name(asset_name).is_err(),
            "{asset_name:?} should be rejected"
        );
    }
}

#[test]
fn archive_entry_count_limit_rejects_large_zip() {
    let err =
        ensure_zip_entry_count(ARCHIVE_MAX_ENTRIES + 1, Path::new("too-large.zip")).unwrap_err();
    assert!(err.contains("Archive trop volumineuse"));
    assert!(err.contains(&ARCHIVE_MAX_ENTRIES.to_string()));
}

#[test]
fn story_json_size_limit_rejects_large_entry() {
    let err = ensure_zip_entry_size(
        "story.json",
        "story.json",
        MAX_STORY_JSON_BYTES + 1,
        MAX_STORY_JSON_BYTES,
    )
    .unwrap_err();
    assert!(err.contains("story.json trop volumineux"));
}

#[test]
fn asset_size_limit_rejects_large_entry() {
    let err = ensure_zip_entry_size(
        "Asset",
        "assets/audio.mp3",
        ARCHIVE_MAX_FILE_BYTES + 1,
        ARCHIVE_MAX_FILE_BYTES,
    )
    .unwrap_err();
    assert!(err.contains("Asset trop volumineux"));
}

#[test]
fn total_asset_size_limit_is_five_gib() {
    ensure_total_asset_size(5 * 1024 * 1024 * 1024).unwrap();
    let err = ensure_total_asset_size(5 * 1024 * 1024 * 1024 + 1).unwrap_err();
    assert!(err.contains("maximum 5120 Mo"));
}
