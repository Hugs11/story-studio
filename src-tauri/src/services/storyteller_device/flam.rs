//! Read-only FLAM inventory. Never open the Lunii writer for this layout.
//! Public metadata ends before the device key material at offset 0x4e.
use super::*;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
};

#[derive(Debug)]
pub(crate) struct Inventory {
    pub firmware: Option<String>,
    pub stories: Vec<Story>,
    pub free_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub playlist_error: bool,
}

#[derive(Debug)]
pub(crate) struct Story {
    pub uuid: Uuid,
    pub title: Option<String>,
    pub hidden: bool,
    pub directory_present: bool,
    pub complete: bool,
}

/// The marker identifies the family, even if its metadata is damaged.
pub(crate) fn is_device(root: &Path) -> bool {
    safe(&root.join(".mdf"), false).is_ok()
}

pub(crate) fn inspect(root: &Path, volumes: &impl Volumes) -> Result<Inventory> {
    safe(root, true)?;
    safe(&root.join(".mdf"), false)?;
    let firmware = firmware(root).ok();
    let (free_bytes, total_bytes) = volumes
        .capacity(root)
        .map(|(free, total)| (Some(free), Some(total)))
        .unwrap_or((None, None));
    let mut playlist_error = false;
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for (file, hidden) in [("list", false), ("list.hidden", true)] {
        let path = root.join("etc/library").join(file);
        if hidden && !path.try_exists()? {
            continue;
        }
        match read_bounded(&path, 40 * 10_000).and_then(|data| playlist(&data)) {
            Ok(ids) => {
                for id in ids {
                    if seen.insert(id) {
                        entries.push((id, hidden));
                    }
                }
            }
            Err(_) => playlist_error = true,
        }
    }
    // The firmware cache is optional: titles only, never authority for the list.
    let titles = read_bounded(&root.join("usr/0/library.cache"), 16 * 1024 * 1024)
        .ok()
        .and_then(|data| cache_titles(&data))
        .unwrap_or_default();
    let stories = entries
        .into_iter()
        .map(|(uuid, hidden)| {
            let path = root
                .join(if hidden { "str.hidden" } else { "str" })
                .join(uuid.to_string());
            let directory_present = safe(&path, true).is_ok();
            let present = |names: &[&str]| {
                names
                    .iter()
                    .all(|name| safe(&path.join(name), false).is_ok())
            };
            // FLAM 2.x also carries index-based stories, without Lua or version.
            let complete = directory_present
                && present(&["info", "key"])
                && (present(&["main.lsf", "version"]) || present(&["ni", "li", "ri", "si"]));
            Story {
                uuid,
                title: titles.get(&uuid).cloned(),
                hidden,
                directory_present,
                complete,
            }
        })
        .collect();
    Ok(Inventory {
        firmware,
        stories,
        free_bytes,
        total_bytes,
        playlist_error,
    })
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    safe(path, false)?;
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(Error::UnknownFormat);
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(Error::UnknownFormat);
    }
    Ok(data)
}

fn firmware(root: &Path) -> Result<String> {
    let mut prefix = [0; 50];
    // Deliberately do not read the serial, credentials or crypto blocks.
    fs::File::open(root.join(".mdf"))?.read_exact(&mut prefix)?;
    if u16::from_le_bytes([prefix[0], prefix[1]]) != 1 {
        return Err(Error::UnknownFormat);
    }
    let text = std::str::from_utf8(&prefix[2..]).map_err(|_| Error::InvalidMetadata)?;
    let main = text.trim_end_matches('\0').lines().next().unwrap_or("");
    let version = main.strip_prefix("main: ").unwrap_or(main);
    let semantic = version.split('-').next().unwrap_or("");
    let parts: Vec<_> = semantic.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
        || version.chars().any(char::is_control)
    {
        return Err(Error::InvalidMetadata);
    }
    Ok(version.into())
}

fn playlist(data: &[u8]) -> Result<Vec<Uuid>> {
    let text = std::str::from_utf8(data).map_err(|_| Error::InvalidPlaylist)?;
    let mut ids = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let id = Uuid::parse_str(line).map_err(|_| Error::InvalidPlaylist)?;
        if !id.to_string().eq_ignore_ascii_case(line) || ids.len() >= 10_000 {
            return Err(Error::InvalidPlaylist);
        }
        ids.push(id);
    }
    Ok(ids)
}

/// Observed FLAM 2.4 cache: count, 64-byte firmware, u32 record offsets;
/// each record has a size, story kind (1: Lua, 2: index-based) and three
/// NUL-terminated u16-sized strings.
/// Ignore the remaining thumbnail bytes; reject unknown/truncated layouts.
fn cache_titles(data: &[u8]) -> Option<HashMap<Uuid, String>> {
    fn u32_at(data: &[u8], offset: usize) -> Option<usize> {
        Some(
            u32::from_le_bytes(data.get(offset..offset.checked_add(4)?)?.try_into().ok()?) as usize,
        )
    }
    fn string<'a>(data: &'a [u8], offset: &mut usize) -> Option<&'a str> {
        let end = offset.checked_add(2)?;
        let len = u16::from_le_bytes(data.get(*offset..end)?.try_into().ok()?) as usize;
        if len == 0 || len > 4096 {
            return None;
        }
        let bytes = data.get(end..end.checked_add(len)?)?;
        *offset = end + len;
        let text = std::str::from_utf8(bytes.strip_suffix(&[0])?).ok()?;
        (!text.chars().any(char::is_control)).then_some(text)
    }
    let count = u32_at(data, 0)?;
    if count > 10_000 {
        return None;
    }
    let table_end = 68usize.checked_add(count.checked_mul(4)?)?;
    data.get(..table_end)?;
    let mut previous_end = table_end;
    let mut titles = HashMap::new();
    for i in 0..count {
        let offset = u32_at(data, 68 + i * 4)?;
        if offset < previous_end {
            return None;
        }
        let len = u32_at(data, offset)?;
        let end = offset.checked_add(len)?;
        let record = data.get(offset..end)?;
        if !matches!(u32_at(record, 4)?, 1 | 2) {
            return None;
        }
        previous_end = end;
        let mut cursor = 8;
        let uuid = string(record, &mut cursor)?;
        let id = Uuid::parse_str(uuid).ok()?;
        let path = string(record, &mut cursor)?;
        let title = string(record, &mut cursor)?;
        if uuid != id.to_string() || path != format!("/str/{id}") || title.is_empty() {
            return None;
        }
        if titles.insert(id, title.to_owned()).is_some() {
            return None;
        }
    }
    Some(titles)
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: Uuid = Uuid::from_u128(0x00000000000040008000000000000001);
    const B: Uuid = Uuid::from_u128(0x00000000000040008000000000000002);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("flam-{}", Uuid::new_v4()));
            fs::create_dir_all(root.join("etc/library")).unwrap();
            fs::create_dir_all(root.join("str")).unwrap();
            let mut md = vec![0; 126];
            md[..2].copy_from_slice(&1u16.to_le_bytes());
            let firmware = b"2.4.1-test";
            md[2..2 + firmware.len()].copy_from_slice(firmware);
            md[78..].fill(0xff);
            fs::write(root.join(".mdf"), md).unwrap();
            fs::write(root.join("etc/library/list"), format!("{B}\r\n{A}\n{B}\n")).unwrap();
            for id in [A, B] {
                let path = root.join("str").join(id.to_string());
                fs::create_dir(&path).unwrap();
                for name in ["info", "main.lsf", "key", "version"] {
                    fs::write(path.join(name), b"fixture").unwrap();
                }
            }
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    impl Volumes for Fixture {
        fn mounted_removable(&self) -> Result<Vec<PathBuf>> {
            Ok(vec![self.0.clone()])
        }
        fn capacity(&self, _: &Path) -> Result<(u64, u64)> {
            Ok((1024, 4096))
        }
    }
    fn cache(id: Uuid, title: &str) -> Vec<u8> {
        let mut record = vec![0; 4];
        record.extend(1u32.to_le_bytes());
        for text in [id.to_string(), format!("/str/{id}"), title.into()] {
            record.extend(((text.len() + 1) as u16).to_le_bytes());
            record.extend(text.as_bytes());
            record.push(0);
        }
        let size = record.len() as u32;
        record[..4].copy_from_slice(&size.to_le_bytes());
        let mut data = vec![0; 68];
        data[..4].copy_from_slice(&1u32.to_le_bytes());
        data.extend(72u32.to_le_bytes());
        data.extend(record);
        data
    }
    #[test]
    fn detects_and_reads_flam_without_lunii_files_or_device_writes() {
        let fixture = Fixture::new();
        assert_eq!(
            super::super::detect(&fixture).unwrap(),
            vec![fixture.0.clone()]
        );
        let before = fs::read(fixture.0.join("etc/library/list")).unwrap();
        let inventory = inspect(&fixture.0, &fixture).unwrap();
        assert_eq!(inventory.firmware.as_deref(), Some("2.4.1-test"));
        assert_eq!(
            inventory.stories.iter().map(|s| s.uuid).collect::<Vec<_>>(),
            vec![B, A]
        );
        assert!(inventory
            .stories
            .iter()
            .all(|s| s.complete && s.directory_present));
        assert!(!inventory.playlist_error);
        assert_eq!(
            (inventory.free_bytes, inventory.total_bytes),
            (Some(1024), Some(4096))
        );
        assert_eq!(
            fs::read(fixture.0.join("etc/library/list")).unwrap(),
            before
        );
        for path in [".md", ".pi", ".content", ".storystudio"] {
            assert!(!fixture.0.join(path).exists());
        }
        assert!(matches!(
            Device::open(&fixture.0, &fixture.0),
            Err(Error::FlamReadOnly)
        ));
        // Even a mixed or misidentified device may never reach the Lunii writer.
        fs::write(fixture.0.join(".md"), [0; 112]).unwrap();
        assert!(matches!(
            Device::open(&fixture.0, &fixture.0),
            Err(Error::FlamReadOnly)
        ));
    }
    #[test]
    fn cached_titles_are_optional_and_never_create_playlist_entries() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("usr/0")).unwrap();
        fs::write(
            fixture.0.join("usr/0/library.cache"),
            cache(A, "Une aventure"),
        )
        .unwrap();
        let inventory = inspect(&fixture.0, &fixture).unwrap();
        assert_eq!(inventory.stories[1].title.as_deref(), Some("Une aventure"));
        assert_eq!(inventory.stories[0].title, None);
        for size in 0..cache(A, "Une aventure").len() {
            assert!(cache_titles(&cache(A, "Une aventure")[..size]).is_none());
        }
        let mut malformed = cache(A, "Une aventure");
        malformed[68..72].copy_from_slice(&0u32.to_le_bytes());
        assert!(cache_titles(&malformed).is_none());
        fs::write(fixture.0.join("usr/0/library.cache"), malformed).unwrap();
        assert_eq!(inspect(&fixture.0, &fixture).unwrap().stories.len(), 2);
    }
    #[test]
    fn mixed_native_and_index_based_cache_records_keep_both_titles() {
        let fixture = Fixture::new();
        let first = cache(A, "Native story");
        let mut second = cache(B, "Index story");
        second[76..80].copy_from_slice(&2u32.to_le_bytes());
        let mut mixed = first[..68].to_vec();
        mixed[..4].copy_from_slice(&2u32.to_le_bytes());
        mixed.extend(76u32.to_le_bytes());
        mixed.extend((76 + first.len() as u32 - 72).to_le_bytes());
        mixed.extend(&first[72..]);
        mixed.extend(&second[72..]);
        fs::create_dir_all(fixture.0.join("usr/0")).unwrap();
        fs::write(fixture.0.join("usr/0/library.cache"), &mixed).unwrap();
        let inventory = inspect(&fixture.0, &fixture).unwrap();
        assert_eq!(inventory.stories[0].title.as_deref(), Some("Index story"));
        assert_eq!(inventory.stories[1].title.as_deref(), Some("Native story"));
        mixed[80..84].copy_from_slice(&3u32.to_le_bytes());
        assert!(cache_titles(&mixed).is_none());
    }
    #[test]
    fn hidden_missing_and_invalid_stories_do_not_trigger_repairs() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("etc/library/list"), format!("{A}\n")).unwrap();
        fs::write(
            fixture.0.join("etc/library/list.hidden"),
            format!("{B}\n{A}\n"),
        )
        .unwrap();
        fs::create_dir(fixture.0.join("str.hidden")).unwrap();
        fs::rename(
            fixture.0.join("str").join(B.to_string()),
            fixture.0.join("str.hidden").join(B.to_string()),
        )
        .unwrap();
        fs::remove_file(fixture.0.join("str").join(A.to_string()).join("main.lsf")).unwrap();
        let inventory = inspect(&fixture.0, &fixture).unwrap();
        assert!(!inventory.stories[0].complete);
        assert!(inventory.stories[1].hidden && inventory.stories[1].complete);
        fs::write(fixture.0.join("etc/library/list"), b"../../outside\n").unwrap();
        assert!(inspect(&fixture.0, &fixture).unwrap().playlist_error);
    }
    #[test]
    fn flam_two_also_lists_index_based_stories_without_lua_or_version() {
        let fixture = Fixture::new();
        let path = fixture.0.join("str").join(A.to_string());
        for name in ["main.lsf", "version"] {
            fs::remove_file(path.join(name)).unwrap();
        }
        for name in ["ni", "li", "ri", "si"] {
            fs::write(path.join(name), b"fixture").unwrap();
        }
        assert!(inspect(&fixture.0, &fixture).unwrap().stories[1].complete);
        fs::remove_file(path.join("si")).unwrap();
        assert!(!inspect(&fixture.0, &fixture).unwrap().stories[1].complete);
    }
    #[test]
    fn metadata_and_playlist_reads_are_bounded_and_tolerate_future_firmware() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join(".mdf"), [1, 0]).unwrap();
        assert_eq!(inspect(&fixture.0, &fixture).unwrap().firmware, None);
        assert_eq!(inspect(&fixture.0, &fixture).unwrap().stories.len(), 2);
        let path = fixture.0.join("etc/library/list");
        fs::File::create(&path).unwrap().set_len(400_001).unwrap();
        assert!(inspect(&fixture.0, &fixture).unwrap().playlist_error);
        fs::write(path, [0xff]).unwrap();
        assert!(inspect(&fixture.0, &fixture).unwrap().playlist_error);
    }
    #[test]
    #[ignore = "requires an explicitly selected mounted FLAM; read-only"]
    fn mounted_flam_inventory() {
        let root = PathBuf::from(
            std::env::var_os("STORY_STUDIO_FLAM_TEST_ROOT").expect("select the mounted device"),
        );
        let expected: usize = std::env::var("STORY_STUDIO_FLAM_TEST_STORIES")
            .expect("expected story count")
            .parse()
            .unwrap();
        let before = fs::read(root.join("etc/library/list")).unwrap();
        assert!(super::super::detect(&NativeVolumes)
            .unwrap()
            .contains(&root));
        assert!(platform::discover()
            .unwrap()
            .iter()
            .any(|v| v.root.as_ref() == Some(&root)));
        let inventory = inspect(&root, &NativeVolumes).unwrap();
        assert!(!inventory.playlist_error);
        assert_eq!(inventory.stories.len(), expected);
        assert!(inventory
            .stories
            .iter()
            .all(|s| s.directory_present && s.complete));
        assert!(inventory.stories.iter().all(|s| s.title.is_some()));
        assert!(inventory.total_bytes.unwrap() > inventory.free_bytes.unwrap());
        assert_eq!(fs::read(root.join("etc/library/list")).unwrap(), before);
        println!("FLAM detected; {expected} stories with cached titles; playlist unchanged");
    }
    #[cfg(unix)]
    #[test]
    fn rejects_linked_markers_playlists_cache_and_story_directories() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let other = Fixture::new();
        fs::remove_dir_all(fixture.0.join("str").join(A.to_string())).unwrap();
        symlink(
            other.0.join("str").join(A.to_string()),
            fixture.0.join("str").join(A.to_string()),
        )
        .unwrap();
        assert!(!inspect(&fixture.0, &fixture).unwrap().stories[1].directory_present);
        fs::remove_file(fixture.0.join("etc/library/list")).unwrap();
        symlink(
            other.0.join("etc/library/list"),
            fixture.0.join("etc/library/list"),
        )
        .unwrap();
        assert!(inspect(&fixture.0, &fixture).unwrap().playlist_error);
        fs::remove_file(fixture.0.join(".mdf")).unwrap();
        symlink(other.0.join(".mdf"), fixture.0.join(".mdf")).unwrap();
        assert!(!is_device(&fixture.0));
    }
}
