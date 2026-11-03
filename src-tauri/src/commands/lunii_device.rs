//! Device IPC: opaque handles only; blocking I/O stays off the UI thread.
use crate::{
    services::{
        catalogue::{self, store::Store},
        storyteller::send::{self, AudioEdgeSilenceDefaults, Selection},
        storyteller_device::{
            self as driver,
            cards::Resolution,
            platform::{self, Volume},
            Action, Device, Identity, NativeVolumes, Volumes,
        },
    },
    support::user_message::{codes, UserMessage},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use uuid::Uuid;
type Result<T> = std::result::Result<T, UserMessage>;
#[derive(Default)]
pub(crate) struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
    /// D43: bumped after each official cover kept, published in the device
    /// inventory so the panel reads its story list again.
    covers: std::sync::atomic::AtomicU64,
}
impl Registry {
    fn cover_kept(&self) {
        self.covers
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}
#[derive(Clone)]
struct Entry {
    volume: Volume,
    busy: bool,
    ejected: bool,
}
fn gone() -> UserMessage {
    UserMessage::new(codes::STORYTELLER_DEVICE_GONE)
}
fn failure(_: impl std::fmt::Display) -> UserMessage {
    UserMessage::new(codes::STORYTELLER_WRITE_FAILED)
}
fn refresh(registry: &Registry, volumes: Vec<Volume>) -> Result<Vec<Value>> {
    let mut entries = registry.entries.lock().map_err(failure)?;
    entries.retain(|_, e| e.busy || volumes.iter().any(|v| v.native_id == e.volume.native_id));
    for volume in volumes {
        if let Some(entry) = entries
            .values_mut()
            .find(|e| e.volume.native_id == volume.native_id)
        {
            // A new mount/root after eject is usable immediately, even when
            // unplug/replug happened between two polling ticks.
            if volume.root.is_some() && entry.volume.root != volume.root {
                entry.ejected = false;
            }
            entry.volume = volume;
        } else {
            entries.insert(
                Uuid::new_v4().to_string(),
                Entry {
                    volume,
                    busy: false,
                    ejected: false,
                },
            );
        }
    }
    let covers = registry.covers.load(std::sync::atomic::Ordering::SeqCst);
    let mut values: Vec<_> = entries.iter().map(|(id, e)| json!({
        "id": id,
        "state": if e.ejected { "ejected" } else if e.volume.root.is_some() { "ready" } else { "detected" },
        "busy": e.busy,
        "covers": covers
    })).collect();
    values.sort_by_key(|v| v["id"].as_str().unwrap_or("").to_owned());
    Ok(values)
}
fn entry(app: &tauri::AppHandle, id: &str) -> Result<Entry> {
    app.state::<Registry>()
        .entries
        .lock()
        .map_err(failure)?
        .get(id)
        .filter(|e| !e.ejected)
        .cloned()
        .ok_or_else(gone)
}
struct Reservation {
    app: tauri::AppHandle,
    id: String,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.app.state::<Registry>().entries.lock() {
            if let Some(e) = entries.get_mut(&self.id) {
                e.busy = false;
            }
        }
    }
}
fn reserve(app: &tauri::AppHandle, id: &str) -> Result<Reservation> {
    let state = app.state::<Registry>();
    let mut entries = state.entries.lock().map_err(failure)?;
    let entry = entries
        .get_mut(id)
        .filter(|e| !e.ejected)
        .ok_or_else(gone)?;
    if entry.busy {
        return Err(driver::Error::Busy.into());
    }
    entry.busy = true;
    Ok(Reservation {
        app: app.clone(),
        id: id.into(),
    })
}
fn device(app: &tauri::AppHandle, id: &str) -> Result<Device> {
    let root = entry(app, id)?.volume.root.ok_or_else(gone)?;
    let data = app.path().app_data_dir().map_err(failure)?;
    std::fs::create_dir_all(&data).map_err(failure)?;
    Device::open(&root, &data).map_err(Into::into)
}
async fn run<T: Send + 'static>(
    app: tauri::AppHandle,
    task: impl FnOnce(&tauri::AppHandle, Arc<Store>) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = catalogue::open_store(&app)?;
        task(&app, store)
    })
    .await
    .map_err(failure)?
    .map_err(send::safe_reason)
}
/// Two-second polling reads the OS volume inventory only, never stories. This
/// also sees Linux devices awaiting the user's mount gesture. No automount.
pub(crate) fn watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut previous = Value::Null;
        loop {
            if let Ok(volumes) = platform::discover() {
                if let Ok(values) = refresh(&app.state::<Registry>(), volumes) {
                    let next = json!(values);
                    if next != previous {
                        let _ = app.emit("lunii-devices-changed", &next);
                        previous = next;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}
#[tauri::command]
pub async fn lunii_device_list(app: tauri::AppHandle) -> Result<Vec<Value>> {
    run(app, |app, _| {
        refresh(
            &app.state::<Registry>(),
            platform::discover().map_err(UserMessage::from)?,
        )
    })
    .await
}
#[tauri::command]
pub async fn lunii_device_open(app: tauri::AppHandle, device_id: String) -> Result<Value> {
    run(app, move |app, store| {
        let volume = {
            let registry = app.state::<Registry>();
            let mut entries = registry.entries.lock().map_err(failure)?;
            let e = entries.get_mut(&device_id).ok_or_else(gone)?;
            if e.busy {
                return Err(driver::Error::Busy.into());
            }
            // Reserve atomically; an ejected entry stays ejected until mounted.
            e.busy = true;
            e.volume.clone()
        };
        let _reservation = Reservation {
            app: app.clone(),
            id: device_id.clone(),
        };
        let root = platform::mount(&volume).map_err(UserMessage::from)?;
        if let Some(e) = app
            .state::<Registry>()
            .entries
            .lock()
            .map_err(failure)?
            .get_mut(&device_id)
        {
            // Usable again only after mount and reservation both succeeded.
            e.volume.root = Some(root);
            e.ejected = false;
        }
        drop(_reservation);
        inspect(app, &store, &device_id)
    })
    .await
}
fn bytes(path: &std::path::Path) -> Option<u64> {
    bytes_at(path, 0)
}
fn bytes_at(path: &std::path::Path, depth: usize) -> Option<u64> {
    if depth > 64 {
        return None;
    }
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || platform::is_reparse(&meta) {
        return None;
    }
    if meta.is_file() {
        return Some(meta.len());
    }
    let mut size = 0u64;
    for e in std::fs::read_dir(path).ok()? {
        size = size.checked_add(bytes_at(&e.ok()?.path(), depth + 1)?)?;
    }
    Some(size)
}
/// D43: a batch of covers kept. Only the counter moves: the watching loop
/// (two seconds) publishes the new inventory, so no device discovery runs here.
fn covers_changed(app: &tauri::AppHandle) {
    app.state::<Registry>().cover_kept();
}
/// D45: a leftover whose known identity is also in the list (listed, or hidden by
/// Story Studio) is a stale duplicate: restoring it would fail on `Duplicate`.
pub(crate) fn is_duplicate_of_listed(
    known: Option<Uuid>,
    in_list: &std::collections::HashSet<Uuid>,
) -> bool {
    known.is_some_and(|uuid| in_list.contains(&uuid))
}
fn inspect(app: &tauri::AppHandle, shared: &Arc<Store>, id: &str) -> Result<Value> {
    inspect_mode(app, shared, id, false)
}
fn inspect_mode(
    app: &tauri::AppHandle,
    shared: &Arc<Store>,
    id: &str,
    read_only: bool,
) -> Result<Value> {
    let store: &Store = shared;
    let device = device(app, id)?;
    let inventory =
        driver::inspect(&device.root, &NativeVolumes, Some(store)).map_err(UserMessage::from)?;
    let ids: Vec<_> = inventory.stories.iter().filter_map(|s| s.uuid).collect();
    let (resolutions, sync_failures) = if read_only {
        (device.read_cards(&ids, store), 0)
    } else {
        let sync = device.sync_cards(&ids, store).map_err(UserMessage::from)?;
        (sync.resolutions, sync.failures.len())
    };
    let backup_lists = device.backup_lists();
    let mut lost_list = Vec::new();
    let mut missing_covers = Vec::new();
    let mut stories = Vec::new();
    let mut orphans = Vec::new();
    // D45: stories of the list, or hidden by Story Studio.
    let in_list: std::collections::HashSet<Uuid> = inventory
        .stories
        .iter()
        .filter(|s| s.listed || s.probable_hidden)
        .filter_map(|s| s.uuid)
        .collect();
    for s in &inventory.stories {
        let key = s
            .uuid
            .map(|id| id.to_string())
            .unwrap_or_else(|| s.folder.clone());
        // An orphan's identity comes from its sidecar or the D15 copies; its
        // title and cover are only read, never published nor decrypted.
        let identity = match s.uuid {
            Some(id) => Identity::Known(id),
            None => device.orphan_identity(&backup_lists, &s.folder),
        };
        let known = match identity {
            Identity::Known(id) => Some(id),
            _ => None,
        };
        let orphan_resolution = s
            .uuid
            .is_none()
            .then(|| known.map(|uuid| device.orphan_resolution(uuid, Some(store))))
            .flatten();
        let resolution = s
            .uuid
            .and_then(|id| ids.iter().position(|v| *v == id))
            .and_then(|i| resolutions.get(i))
            .or(orphan_resolution.as_ref());
        let link = known.and_then(|uuid| store.device_card_link(uuid).ok().flatten());
        let (title, kind, has_cover, preview_error) = match resolution {
            Some(Resolution::Official { title }) => {
                let (cached, missing) = official_cover_state(known, link.is_some(), |key| {
                    store.has_official_device_cover(key)
                });
                missing_covers.extend(missing);
                (title.clone(), "official", cached, None)
            }
            Some(Resolution::Known(card)) => {
                // Orphans never decode payloads; listed creations keep the
                // first-screen fallback even after receiving a name-only card.
                let preview = s
                    .uuid
                    .map(|uuid| device.check_creation_cover(uuid, card, store));
                let has_cover = preview
                    .as_ref()
                    .map_or(card.cover_png.is_some(), |result| result.is_ok());
                let error = preview
                    .and_then(std::result::Result::err)
                    .map(UserMessage::from);
                (Some(card.title.clone()), "creation", has_cover, error)
            }
            _ => {
                let preview = s.uuid.map(|uuid| device.check_first_screen(uuid, store));
                let has_cover = preview.as_ref().is_some_and(|result| result.is_ok());
                let error = preview
                    .and_then(std::result::Result::err)
                    .map(UserMessage::from);
                (None, "unknown", has_cover, error)
            }
        };
        let story_path = s
            .uuid
            .map(|uuid| driver::story_path(&device.root, uuid))
            .unwrap_or_else(|| {
                s.folder
                    .strip_prefix("parked:")
                    .map(|name| device.root.join(".storystudio").join("masquees").join(name))
                    .unwrap_or_else(|| device.root.join(".content").join(&s.folder))
            });
        let value = json!({
            "key": key, "knownUuid": known, "identityConflict": identity == Identity::Contradicted, "title": title, "kind": kind, "previewError": preview_error,
            "hidden": s.probable_hidden, "parkingPending": s.parking_pending, "parked": s.folder.starts_with("parked:"), "duplicateOfListed": is_duplicate_of_listed(known, &in_list), "complete": s.complete,
            "directoryPresent": s.directory_present, "sizeBytes": bytes(&story_path),
            "durationSec": link.as_ref().and_then(|v| v.1),
            "sentAt": s.uuid.and_then(|uuid| device.sent_at(uuid)),
            "catalogueFicheId": link.as_ref().map(|v| &v.0),
            "catalogueCoverSignature": link.as_ref().map(|v| &v.2),
            "coverPath": if has_cover { known.map(|uuid| format!("/{id}/{uuid}")) } else { None }
        });
        if s.listed || s.probable_hidden {
            stories.push(value);
        } else {
            if s.complete && !s.folder.starts_with("parked:") {
                lost_list.push(known);
            }
            orphans.push(value);
        }
    }
    if !missing_covers.is_empty() {
        let app = app.clone();
        shared
            .fetch_official_device_covers(&missing_covers, Arc::new(move || covers_changed(&app)));
    }
    // D42: an empty or shortened list, which one D15 copy explains entirely.
    let listed: Vec<_> = inventory
        .stories
        .iter()
        .filter(|s| s.listed)
        .filter_map(|s| s.uuid)
        .collect();
    let list_lost = lost_list
        .iter()
        .copied()
        .collect::<Option<Vec<_>>>()
        .is_some_and(|ids| device.list_lost(&backup_lists, &ids, &listed));
    let writable = NativeVolumes.writable(&device.root).unwrap_or(false);
    let read_only = inventory.read_only_cause(writable);
    let state = if inventory.metadata.version == 1 {
        "unsupported"
    } else if inventory.playlist_state == driver::PlaylistState::Damaged {
        "damaged"
    } else if read_only.is_some() {
        "readOnly"
    } else {
        "ready"
    };
    let mut banners = Vec::new();
    if state == "damaged" {
        banners.push(if inventory.playlist_error.is_some() {
            "damagedTruncated"
        } else {
            "damagedMissingStories"
        });
    }
    if inventory.recovery.is_some() {
        banners.push("resume");
    }
    if read_only.is_some() {
        banners.push("readOnly");
    }
    // D45: a stale duplicate is not a story the child misses; its row says so.
    if orphans.iter().any(|o| o["duplicateOfListed"] != true) {
        banners.push("orphans");
    }
    let refusal = if writable {
        inventory.metadata.read_only
    } else {
        Some(driver::Error::ReadOnly)
    };
    let (repair_preview, repair_preview_error) =
        repair_preview(state == "damaged", refusal, || device.repair_preview());
    Ok(json!({
        "id": id, "name": device.name().map_err(UserMessage::from)?,
        "serial": inventory.metadata.serial(),
        "metadataVersion": inventory.metadata.version, "firmware": inventory.metadata.firmware, "state": state, "banner": banners, "readOnlyReason": read_only,
        "freeBytes": inventory.free_bytes, "totalBytes": inventory.total_bytes,
        "stories": stories, "orphans": orphans, "listLost": list_lost, "busy": entry(app, id)?.busy,
        "repairPreview": repair_preview, "repairPreviewError": repair_preview_error,
        "recognitionDegraded": inventory.recognition_degraded, "cardSyncFailures": sync_failures
    }))
}
/// No preview of a repair that will be refused: the typed refusal is shown instead.
fn repair_preview<T>(
    damaged: bool,
    refusal: Option<driver::Error>,
    preview: impl FnOnce() -> driver::Result<T>,
) -> (Option<T>, Option<UserMessage>) {
    if !damaged {
        return (None, None);
    }
    match refusal.map_or_else(preview, Err) {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(UserMessage::from(error))),
    }
}
#[tauri::command]
pub async fn lunii_device_inspect(
    app: tauri::AppHandle,
    device_id: String,
    read_only: Option<bool>,
) -> Result<Value> {
    run(app, move |app, store| {
        inspect_mode(app, &store, &device_id, read_only.unwrap_or(false))
    })
    .await
}
#[tauri::command]
pub async fn lunii_device_send(
    app: tauri::AppHandle,
    device_id: String,
    selection: Vec<Selection>,
    position: Option<usize>,
    request_id: String,
    audio_edge_silence: Option<AudioEdgeSilenceDefaults>,
) -> Result<Value> {
    run(app, move |app, store| {
        if selection.is_empty() || selection.len() > 1000 {
            return Err(failure("selection"));
        }
        let sink = catalogue::operation_sink(app.clone());
        // requestId identifies an attempt even if reservation fails. A retry
        // uses a fresh ID (documented in luniiDeviceApi.js).
        let op = store.begin_lunii_send(request_id, selection.len(), Arc::clone(&sink))?;
        let receipt = {
            let p = op.progress.lock().map_err(failure)?;
            json!({
                "operationId": p.operation_id,
                "requestId": p.request_id,
                "catalogueRevision": p.catalogue_revision,
                "sourcesRevision": p.sources_revision
            })
        };
        if op.started.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(receipt);
        }
        let setup = (|| {
            let reservation = reserve(app, &device_id)?;
            let device = device(app, &device_id)?;
            Ok::<_, UserMessage>((reservation, device))
        })();
        let (reservation, device) = match setup {
            Ok(value) => value,
            Err(error) => {
                if let Ok(mut p) = op.progress.lock() {
                    p.status = "failed".into();
                    p.error = Some(error.clone());
                }
                op.emit(&sink, true);
                return Err(error);
            }
        };
        let app = app.clone();
        std::thread::spawn(move || {
            let _reservation = reservation;
            send::run(
                app,
                store,
                device,
                selection,
                position,
                audio_edge_silence.unwrap_or_default(),
                op,
                sink,
            );
        });
        Ok(receipt)
    })
    .await
}
#[tauri::command]
pub async fn lunii_device_cancel(
    app: tauri::AppHandle,
    operation_id: String,
) -> Result<catalogue::events::Progress> {
    run(app, move |_, store| store.cancel_operation(&operation_id)).await
}
fn uuid(key: &str) -> Result<Uuid> {
    Uuid::parse_str(key).map_err(failure)
}
async fn apply(app: tauri::AppHandle, id: String, actions: Vec<Action>) -> Result<Value> {
    run(app, move |app, store| {
        let _reservation = reserve(app, &id)?;
        let device = device(app, &id)?;
        let _operation = device.backup_scope();
        let mut outcomes = Vec::new();
        for action in actions {
            outcomes.push(device.apply(action).map_err(UserMessage::from)?);
        }
        drop(_reservation);
        Ok(json!({"outcomes":outcomes,"device":inspect(app,&store,&id)?}))
    })
    .await
}
#[tauri::command]
pub async fn lunii_device_remove(
    app: tauri::AppHandle,
    device_id: String,
    keys: Vec<String>,
) -> Result<Value> {
    let actions = keys
        .iter()
        .map(|k| uuid(k).map(Action::Remove))
        .collect::<Result<_>>()?;
    apply(app, device_id, actions).await
}
#[tauri::command]
pub async fn lunii_device_reorder(
    app: tauri::AppHandle,
    device_id: String,
    keys: Vec<String>,
) -> Result<Value> {
    apply(
        app,
        device_id,
        vec![Action::Reorder(
            keys.iter().map(|k| uuid(k)).collect::<Result<_>>()?,
        )],
    )
    .await
}
#[tauri::command]
pub async fn lunii_device_hide(
    app: tauri::AppHandle,
    device_id: String,
    key: String,
    hidden: bool,
) -> Result<Value> {
    let id = uuid(&key)?;
    apply(
        app,
        device_id,
        vec![if hidden {
            Action::Hide(id)
        } else {
            Action::Show(id)
        }],
    )
    .await
}
#[tauri::command]
pub async fn lunii_device_repair(app: tauri::AppHandle, device_id: String) -> Result<Value> {
    apply(app, device_id, vec![Action::RepairPlaylist]).await
}
#[tauri::command]
pub async fn lunii_device_restore(app: tauri::AppHandle, device_id: String) -> Result<Value> {
    apply(app, device_id, vec![Action::RestorePlaylist]).await
}
#[tauri::command]
pub async fn lunii_device_orphan(
    app: tauri::AppHandle,
    device_id: String,
    key: String,
    restore: bool,
    known_uuid: Option<String>,
) -> Result<Value> {
    let action = if restore {
        Action::Restore {
            folder: key,
            known_uuid: known_uuid.as_deref().map(uuid).transpose()?,
        }
    } else {
        Action::DeleteOrphan(key)
    };
    apply(app, device_id, vec![action]).await
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanItem {
    key: String,
    known_uuid: String,
}
/// « Tout remettre dans la liste » : one `.pi` write for every listed orphan.
#[tauri::command]
pub async fn lunii_device_orphans_restore(
    app: tauri::AppHandle,
    device_id: String,
    items: Vec<OrphanItem>,
) -> Result<Value> {
    if items.len() > 100_000 {
        return Err(failure("items"));
    }
    let items = items
        .into_iter()
        .map(|item| Ok((item.key, uuid(&item.known_uuid)?)))
        .collect::<Result<_>>()?;
    apply(app, device_id, vec![Action::RestoreOrphans(items)]).await
}
#[tauri::command]
pub async fn lunii_device_name_story(
    app: tauri::AppHandle,
    device_id: String,
    key: String,
    title: String,
) -> Result<Value> {
    run(app, move |app, store| {
        let _reservation = reserve(app, &device_id)?;
        device(app, &device_id)?
            .name_card(uuid(&key)?, &*store, title)
            .map_err(UserMessage::from)?;
        drop(_reservation);
        inspect(app, &store, &device_id)
    })
    .await
}
#[tauri::command]
pub async fn lunii_device_rename(
    app: tauri::AppHandle,
    device_id: String,
    name: String,
) -> Result<Value> {
    run(app, move |app, store| {
        let _reservation = reserve(app, &device_id)?;
        device(app, &device_id)?
            .rename(name)
            .map_err(UserMessage::from)?;
        drop(_reservation);
        inspect(app, &store, &device_id)
    })
    .await
}
#[tauri::command]
pub async fn lunii_device_repatriate(
    app: tauri::AppHandle,
    device_id: String,
    key: String,
    request_id: String,
) -> Result<Value> {
    run(app, move |app, store| {
        let id = uuid(&key)?;
        let sink = catalogue::operation_sink(app.clone());
        let op = store.begin_lunii_transfer(request_id, 1, Arc::clone(&sink), "luniiRepatriate")?;
        let receipt = {
            let p = op.progress.lock().map_err(failure)?;
            json!({"operationId":p.operation_id,"requestId":p.request_id,
                "catalogueRevision":p.catalogue_revision,"sourcesRevision":p.sources_revision})
        };
        if op.started.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(receipt);
        }
        let setup = (|| {
            let reservation = reserve(app, &device_id)?;
            let device = device(app, &device_id)?;
            let cache = app
                .path()
                .app_cache_dir()
                .map_err(failure)?
                .join("storyteller-repatriate");
            Ok::<_, UserMessage>((reservation, device, cache))
        })();
        let (reservation, device, cache) = match setup {
            Ok(value) => value,
            Err(error) => {
                if let Ok(mut p) = op.progress.lock() {
                    p.status = "failed".into();
                    p.error = Some(error.clone());
                }
                op.emit(&sink, true);
                return Err(error);
            }
        };
        let app = app.clone();
        std::thread::spawn(move || {
            let _reservation = reservation;
            crate::services::storyteller::repatriate::run(store, device, id, cache, op, sink);
            catalogue::sources_changed(&app);
        });
        Ok(receipt)
    })
    .await
}
#[tauri::command]
pub async fn lunii_device_eject(app: tauri::AppHandle, device_id: String) -> Result<Value> {
    run(app, move |app, _| {
        let _reservation = reserve(app, &device_id)?;
        platform::eject(&entry(app, &device_id)?.volume).map_err(UserMessage::from)?;
        if let Some(e) = app
            .state::<Registry>()
            .entries
            .lock()
            .map_err(failure)?
            .get_mut(&device_id)
        {
            e.ejected = true;
        }
        Ok(json!({"id":device_id,"state":"ejected"}))
    })
    .await
}
/// Covers use opaque addresses like catalogue-cover, never filesystem URLs.
pub(crate) fn cover(app: &tauri::AppHandle, path: &str) -> Result<Vec<u8>> {
    let mut parts = path.trim_start_matches('/').split('/');
    let device_id = parts.next().ok_or_else(gone)?;
    let key = parts.next().ok_or_else(gone)?;
    if parts.next().is_some() {
        return Err(gone());
    }
    let store = catalogue::open_store(app)?;
    let id = uuid(key)?;
    let device = device(app, device_id)?;
    // An orphan's cover is strictly read-only: its own sidecar or nothing,
    // never a card publication nor a first-screen decryption.
    if !device.lists_story(id) {
        return match device.orphan_resolution(id, Some(&*store)) {
            Resolution::Known(card) => card.cover_png.ok_or_else(gone),
            Resolution::Official { .. } => official_cover(&store, id),
            _ => Err(gone()),
        };
    }
    // A cover requested after a silent inspection must not publish the
    // catalogue fallback as a sidecar either. Explicit inspect owns syncing.
    match device
        .read_cards(&[id], &*store)
        .into_iter()
        .next()
        .unwrap_or(Resolution::Unknown)
    {
        Resolution::Known(card) => device
            .read_creation_cover(id, &card, &*store)
            .map_err(UserMessage::from),
        Resolution::Official { .. } => official_cover(&store, id),
        Resolution::Unknown => device
            .read_first_screen(id, &*store)
            .map_err(UserMessage::from),
    }
}
/// D43: only an official without a fiche shows the cached official cover (a
/// linked one keeps its fiche's cover). Returns whether `coverPath` is
/// published, and the UUID to fetch in the background when it is missing.
fn official_cover_state(
    known: Option<Uuid>,
    linked: bool,
    cached: impl Fn(&str) -> bool,
) -> (bool, Option<Uuid>) {
    match known.filter(|_| !linked) {
        Some(uuid) if cached(&uuid.to_string()) => (true, None),
        Some(uuid) => (false, Some(uuid)),
        None => (false, None),
    }
}
/// D43: the app's own cached copy, read only; never the device's payload.
fn official_cover(store: &Store, id: Uuid) -> Result<Vec<u8>> {
    store
        .official_device_cover(&id.to_string())
        .map_err(|_| gone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_handles_survive_refresh_and_disappear_without_exposing_paths() {
        let registry = Registry::default();
        let volume = Volume {
            native_id: "/dev/fake".into(),
            root: None,
        };
        let first = refresh(&registry, vec![volume.clone()]).unwrap();
        assert_eq!(first[0]["state"], "detected");
        let second = refresh(
            &registry,
            vec![Volume {
                root: Some("/fake".into()),
                ..volume
            }],
        )
        .unwrap();
        assert_eq!(first[0]["id"], second[0]["id"]);
        assert_eq!(second[0]["state"], "ready");
        assert!(!second[0].to_string().contains("/fake"));
        assert!(refresh(&registry, vec![]).unwrap().is_empty());
    }
    #[test]
    fn ejected_device_requires_new_mount_before_ready() {
        let registry = Registry::default();
        let volume = Volume {
            native_id: "/fake".into(),
            root: Some("/fake".into()),
        };
        let first = refresh(&registry, vec![volume.clone()]).unwrap();
        let id = first[0]["id"].as_str().unwrap().to_owned();
        registry
            .entries
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .ejected = true;
        let next = refresh(&registry, vec![volume.clone()]).unwrap();
        assert_eq!(next[0]["state"], "ejected");
        refresh(
            &registry,
            vec![Volume {
                root: None,
                ..volume.clone()
            }],
        )
        .unwrap();
        let next = refresh(&registry, vec![volume]).unwrap();
        assert_eq!(next[0]["id"], id);
        assert_eq!(next[0]["state"], "ready");
    }
    #[test]
    fn official_cover_is_published_only_from_the_cache_and_never_for_a_linked_fiche() {
        let id = Uuid::parse_str("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
        assert_eq!(
            official_cover_state(Some(id), false, |_| true),
            (true, None)
        );
        assert_eq!(
            official_cover_state(Some(id), false, |_| false),
            (false, Some(id))
        );
        // A fiche of the catalogue keeps the current behaviour: no request either.
        assert_eq!(
            official_cover_state(Some(id), true, |_| true),
            (false, None)
        );
        assert_eq!(
            official_cover_state(Some(id), true, |_| false),
            (false, None)
        );
        assert_eq!(official_cover_state(None, false, |_| true), (false, None));
    }
    #[test]
    fn kept_cover_changes_the_published_inventory() {
        let registry = Registry::default();
        let volume = Volume {
            native_id: "/dev/fake".into(),
            root: Some("/fake".into()),
        };
        let before = refresh(&registry, vec![volume.clone()]).unwrap();
        assert_eq!(before[0]["covers"], 0);
        assert_eq!(refresh(&registry, vec![volume.clone()]).unwrap(), before);
        registry.cover_kept();
        let after = refresh(&registry, vec![volume]).unwrap();
        assert_ne!(after, before, "the watcher emits lunii-devices-changed");
        assert_eq!(after[0]["id"], before[0]["id"]);
        assert_eq!(after[0]["covers"], 1);
    }
    #[test]
    fn refused_repair_has_no_preview_but_a_typed_error() {
        let read_only = UserMessage::from(driver::Error::ReadOnly).code;
        let mut previewed = false;
        let (preview, error) = repair_preview(true, Some(driver::Error::ReadOnly), || {
            previewed = true;
            Ok(())
        });
        assert!(!previewed && preview.is_none());
        assert_eq!(error.unwrap().code, read_only);
        let metadata = UserMessage::from(driver::Error::UnknownFormat).code;
        let (preview, error) =
            repair_preview::<()>(true, Some(driver::Error::UnknownFormat), || Ok(()));
        assert!(preview.is_none());
        assert_eq!(error.unwrap().code, metadata);
        assert_eq!(repair_preview(true, None, || Ok(3)).0, Some(3));
        assert!(repair_preview(false, None, || Ok(3)).0.is_none());
    }
    #[test]
    fn invalid_story_key_never_reaches_filesystem_or_visible_message() {
        let error = uuid("/arbitrary/path").unwrap_err();
        assert!(error.params.is_empty());
        assert!(!error.to_string().contains("/arbitrary/path"));
    }
}
