//! Catalogue-only send. Preparation never writes to the device.
use super::*;
use crate::{
    native_pack::output_identity,
    services::{
        catalogue::{
            self,
            scan::{Operation, Sink},
            store::Store,
        },
        storyteller_device::{self as device, cards::CardCatalogue, Action, Device, NativeVolumes},
    },
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selection {
    pub exemplar_id: String,
    pub expected_revision: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    exemplar_id: String,
    step: String,
    progress: u8,
    reason: Option<UserMessage>,
    /// Real step at the failure, as logged; never sent to the interface.
    #[serde(skip)]
    failed_at: Option<String>,
}
fn publish(op: &Operation, sink: &Sink, items: &[Item], terminal: bool) {
    if let Ok(mut p) = op.progress.lock() {
        p.result = Some(serde_json::json!({"stories":items}));
        p.candidates.processed = items
            .iter()
            .filter(|i| ["done", "refused", "failed", "interrupted"].contains(&i.step.as_str()))
            .count() as u64;
        p.outcomes.updated = items.iter().filter(|i| i.step == "done").count() as u64;
        p.outcomes.refused = items.iter().filter(|i| i.step == "refused").count() as u64;
        p.outcomes.error = items
            .iter()
            .filter(|i| ["failed", "interrupted"].contains(&i.step.as_str()))
            .count() as u64;
        if terminal {
            p.scan_complete = true;
            p.status = if op.cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else if p.outcomes.refused + p.outcomes.error > 0 {
                "partial"
            } else {
                "success"
            }
            .into();
        }
    }
    op.emit(sink, terminal);
}
/// Errors from older catalogue commands may interpolate a path. A typed code
/// keeps its code and only its presentable parameters (see `presentable`).
/// It becomes the generic write failure when its code is unknown, when it
/// carries private data under a parameter its code does not declare (a path
/// interpolated into a code not meant to show one), or when filtering removes
/// a parameter its code declares: the interface renders a code only with all
/// of them. A damaged medium whose screen name is private loses only the name.
pub(crate) fn safe_reason(error: UserMessage) -> UserMessage {
    if error.code == codes::GENERATION_CANCELLED {
        return UserMessage::new(codes::STORYTELLER_SEND_CANCELLED);
    }
    if !error.params.is_empty() && !typed(&error) {
        return UserMessage::new(codes::STORYTELLER_WRITE_FAILED);
    }
    let given: Vec<String> = contract(&error.code)
        .iter()
        .filter(|key| error.params.contains_key(*key))
        .cloned()
        .collect();
    let mut value = serde_json::to_value(error).unwrap_or_default();
    presentable(&mut value);
    let safe: UserMessage = match serde_json::from_value(value) {
        Ok(safe) => safe,
        Err(_) => return UserMessage::new(codes::STORYTELLER_WRITE_FAILED),
    };
    if given.iter().all(|key| safe.params.contains_key(key)) {
        return safe;
    }
    match safe.code.as_str() {
        codes::STORYTELLER_IMAGE_UNREADABLE => {
            UserMessage::new(codes::STORYTELLER_IMAGE_UNREADABLE_UNNAMED)
        }
        codes::STORYTELLER_SOUND_UNREADABLE => {
            UserMessage::new(codes::STORYTELLER_SOUND_UNREADABLE_UNNAMED)
        }
        _ => UserMessage::new(codes::STORYTELLER_WRITE_FAILED),
    }
}
/// A known code whose undeclared parameters, if any, hold no private data.
fn typed(error: &UserMessage) -> bool {
    let Some(declared) = contracts().get(&error.code) else {
        return false;
    };
    error.params.iter().all(|(key, value)| {
        declared.contains(key)
            || (!identity_key(key) && presentable_parameter(key, &mut value.clone()))
    })
}
/// Allowlist of presentation data, applied recursively: a message keeps its
/// code and the parameters declared by its registry contract; a message list
/// keeps its messages, separator and case. Every other key (diagnostics,
/// details, unknown fields) is dropped, as are declared parameters naming a
/// path or an identifier unless they are a number or a boolean.
fn presentable(value: &mut serde_json::Value) {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            if let Some(Value::String(code)) = map.get("code").cloned() {
                let declared = contract(&code);
                let mut params = match map.remove("params") {
                    Some(Value::Object(params)) => params,
                    _ => serde_json::Map::new(),
                };
                params.retain(|key, v| {
                    declared.contains(key)
                        && (!identity_key(key) || v.is_number() || v.is_boolean())
                        && presentable_parameter(key, v)
                });
                for v in params.values_mut() {
                    presentable(v);
                }
                map.clear();
                map.insert("code".into(), Value::String(code));
                map.insert("params".into(), Value::Object(params));
            } else if let Some(Value::Array(mut messages)) = map.remove("messages") {
                let separator = map.remove("separator").filter(Value::is_string);
                let case = map.remove("case").filter(Value::is_string);
                map.clear();
                for message in &mut messages {
                    presentable(message);
                }
                messages.retain(Value::is_object);
                map.insert("messages".into(), Value::Array(messages));
                if let Some(separator) = separator {
                    map.insert("separator".into(), separator);
                }
                if let Some(case) = case {
                    map.insert("case".into(), case);
                }
            } else {
                *value = Value::Null;
            }
        }
        Value::Array(values) => {
            for v in values {
                presentable(v);
            }
        }
        Value::String(text) => {
            // Composite services may carry a serialized message as a string.
            if let Ok(mut message) = serde_json::from_str::<Value>(text) {
                if message.is_object() {
                    presentable(&mut message);
                    *value = message;
                }
            }
        }
        _ => {}
    }
}
fn contracts() -> &'static std::collections::HashMap<String, Vec<String>> {
    use std::collections::HashMap;
    static CONTRACTS: std::sync::OnceLock<HashMap<String, Vec<String>>> =
        std::sync::OnceLock::new();
    #[derive(Deserialize)]
    struct Entry {
        code: String,
        params: Vec<String>,
    }
    CONTRACTS.get_or_init(|| {
        serde_json::from_str::<Vec<Entry>>(include_str!(
            "../../../../src/locales/_generated/rust-messages.json"
        ))
        .expect("valid embedded Rust message contracts")
        .into_iter()
        .map(|e| (e.code, e.params))
        .collect()
    })
}
fn contract(code: &str) -> &'static [String] {
    contracts().get(code).map(Vec::as_slice).unwrap_or(&[])
}
/// Exclude internal identities and paths, preserving author-facing labels.
fn identity_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "path"
            | "dir"
            | "root"
            | "uuid"
            | "id"
            | "entry_id"
            | "entryid"
            | "zip_path_buf"
            | "self_root"
            | "packroot"
            | "entryabsolute"
            | "entryrelative"
            | "outputzip"
            | "cachedzip"
            | "assetfolder"
            | "outputfolder"
            | "directory"
            | "xttsdirectory"
            | "serveroutputdirectory"
            | "requestedoutputfile"
            | "file"
            | "filename"
            | "detail"
            | "details"
            | "source"
            | "existingid"
            | "stageid"
            | "stage_id"
            | "actionid"
            | "action_id"
            | "asset_ref"
            | "assetref"
            | "assetname"
            | "identity"
    ) || key.ends_with("Path")
        || key.ends_with("Dir")
        || lower.ends_with("_path")
        || lower.ends_with("_dir")
        || lower.ends_with("uuid")
}
/// Relative separators are meaningful in known author labels (e.g. Jour/Nuit),
/// but absolute paths remain private even when supplied under a label key.
fn presentable_parameter(key: &str, value: &mut serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => {
            let text = text.trim();
            if identity_shaped(text) {
                return false;
            }
            let bytes = text.as_bytes();
            let absolute = text.starts_with(['/', '\\'])
                || (bytes.len() >= 3
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && matches!(bytes[2], b'/' | b'\\'));
            let label = matches!(
                key,
                "label"
                    | "entry_name"
                    | "entry_names"
                    | "entry_context"
                    | "zip_label"
                    | "zip_name"
                    | "review_entry_names"
                    | "target_label"
                    | "screen"
            );
            !absolute && (label || !text.contains(['/', '\\']))
        }
        serde_json::Value::Array(values) => {
            values.retain_mut(|v| presentable_parameter(key, v));
            true
        }
        _ => true,
    }
}
/// A UUID or a hexadecimal fingerprint of 16 characters or more names an
/// internal identity whatever the parameter is called.
fn identity_shaped(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| *c != '-').collect();
    let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    uuid::Uuid::parse_str(text).is_ok() || (compact.len() >= 16 && hex(&compact))
}
// The application silence preferences are captured once for the whole send.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    app: tauri::AppHandle,
    store: Arc<Store>,
    device: Device,
    selection: Vec<Selection>,
    mut position: Option<usize>,
    audio_edge_silence: AudioEdgeSilenceDefaults,
    op: Arc<Operation>,
    sink: Sink,
) {
    let _access = device::platform::access_guard();
    let _operation = device.backup_scope();
    let items = run_batch_tracked(
        &selection,
        &op.cancel,
        |items| publish(&op, &sink, items, false),
        |selected, stage, enter| {
            let result = (|| {
                let target =
                    store.resolve_target(&selected.exemplar_id, selected.expected_revision)?;
                target.require_unchanged(std::time::Duration::from_secs(5))?;
                let uuid = target
                    .observation
                    .as_ref()
                    .and_then(|o| o.raw["identity"]["value"].as_str())
                    .and_then(|s| uuid::Uuid::parse_str(s).ok());
                // Same decision as the catalogue list's `official` flag.
                if target.observation.as_ref().is_some_and(|o| {
                    crate::services::catalogue::observed_official(&o.raw, Some(&*store))
                }) {
                    return Err(UserMessage::new(codes::STORYTELLER_OFFICIAL_REFUSED));
                }
                device
                    .preflight(uuid, estimate_target(&target)?, &NativeVolumes)
                    .map_err(UserMessage::from)?;
                let cache = crate::support::temp::app_cache_subdir(&app, "lunii-send")
                    .map_err(UserMessage::from)?;
                fs::create_dir_all(&cache).map_err(failure)?;
                let scratch = Scratch::new(&cache)?;
                let plain_dir = scratch.0.join("plain");
                let encrypted_dir = scratch.0.join("encrypted");
                fs::create_dir(&plain_dir).map_err(failure)?;
                fs::create_dir(&encrypted_dir).map_err(failure)?;
                let is_project = target
                    .observation
                    .as_ref()
                    .is_some_and(|o| o.format == "project");
                // A step reuses the progress already shown; only copying moves it.
                let base: u8 = if is_project { 20 } else { 5 };
                let plain = if is_project {
                    stage("generating", 20);
                    let zip = generate_project(
                        &app,
                        &store,
                        &target,
                        &scratch.0,
                        &op.cancel,
                        audio_edge_silence,
                    )?;
                    // The archive exists: what follows reads it back like any pack.
                    stage("preparing", 20);
                    // Feed the generated archive through the same pack chain and D26.
                    let authorized =
                        output_identity::authorize_storyteller_path(&zip, Some(&*store))?;
                    let bindings = extract_bindings(&zip, &authorized, &scratch.0, &op.cancel)?;
                    write_plain_story_observed(
                        &authorized,
                        &bindings,
                        &plain_dir,
                        &cache,
                        &op.cancel,
                        &mut |step| stage(prep_stage(step), base),
                    )?
                } else {
                    write_catalogue_pack(
                        &app,
                        &target,
                        Some(&*store),
                        &plain_dir,
                        &op.cancel,
                        &mut |step| stage(prep_stage(step), base),
                    )?
                };
                target.require_unchanged(std::time::Duration::from_secs(5))?;
                let cipher = cipher::DeviceCipher::from_metadata(&device.root)?;
                // Shown only when encryption outlasts the delay: a fast one
                // keeps the previous label instead of flashing a new one.
                // The failure log names the real step, shown or not.
                enter("encrypting");
                let encrypted = run_announcing_if_slow(
                    ENCRYPTION_LABEL_DELAY,
                    || cipher.encrypt_story(&plain, &encrypted_dir, &op.cancel),
                    || stage("encrypting", base),
                )?;
                stage("copying", 70);
                let id = encrypted.uuid;
                let finalizing = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let applied = device.apply_with_catalogue(
                    Action::Install {
                        story: encrypted,
                        position,
                        cancel: Arc::clone(&op.cancel),
                        progress: Some(copy_progress(
                            Arc::clone(&op),
                            Arc::clone(&sink),
                            selected.exemplar_id.clone(),
                            Arc::clone(&finalizing),
                        )),
                    },
                    &NativeVolumes,
                    Some(&*store),
                );
                if finalizing.load(Ordering::SeqCst) {
                    enter("finalizing");
                }
                let outcome = applied.map_err(UserMessage::from)?;
                // Payload is committed: a sidecar error must not invite a duplicate retry.
                let card_result = (|| -> device::Result<()> {
                    if let Some(card) = store.card(id)? {
                        device.write_card(id, Some(&*store), card.card)?;
                    }
                    device.mark_sent(id)
                })();
                if let Some(p) = &mut position {
                    *p += 1;
                }
                Ok(card_result.err().map(UserMessage::from).or_else(|| {
                    matches!(
                        outcome,
                        device::Outcome::InstalledNotDurable | device::Outcome::StateWarning
                    )
                    .then(|| UserMessage::new(codes::STORYTELLER_WRITE_FAILED))
                }))
            })();
            result.map_err(|e| {
                if !device.root.join(".md").is_file() {
                    device::Error::Disconnected.into()
                } else {
                    safe_reason(e)
                }
            })
        },
    );
    publish(&op, &sink, &items, true);
}

/// Encryption gets its own label only if it lasts longer than this.
const ENCRYPTION_LABEL_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

/// Stage name of a preparation step the engine has really entered.
fn prep_stage(step: PrepStep) -> &'static str {
    match step {
        PrepStep::ConvertingSounds => "convertingSounds",
        PrepStep::ConvertingImages => "convertingImages",
    }
}

/// Runs `work` on a scoped thread and calls `on_slow`, from the caller's
/// thread, once, only if `work` is still running after `delay`.
fn run_announcing_if_slow<T: Send>(
    delay: std::time::Duration,
    work: impl FnOnce() -> T + Send,
    on_slow: impl FnOnce(),
) -> T {
    std::thread::scope(|scope| {
        let (done, finished) = std::sync::mpsc::channel::<()>();
        let handle = scope.spawn(move || {
            let result = work();
            let _ = done.send(());
            result
        });
        if matches!(
            finished.recv_timeout(delay),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ) {
            on_slow();
        }
        handle
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

/// Selection coordinator is independent of IPC and device discovery. A refused
/// item never aborts following items; cancellation settles all remaining rows.
fn run_batch(
    selection: &[Selection],
    cancel: &AtomicBool,
    notify: impl FnMut(&[Item]),
    mut process: impl FnMut(&Selection, &mut dyn FnMut(&str, u8)) -> Result<Option<UserMessage>>,
) -> Vec<Item> {
    run_batch_tracked(selection, cancel, notify, |s, stage, _| process(s, stage))
}

/// `process` also receives `enter(step)`: it records the real current step for
/// the failure log without changing what is displayed (a step that is shown
/// late or never, like a fast encryption, is still the one that failed).
fn run_batch_tracked(
    selection: &[Selection],
    cancel: &AtomicBool,
    mut notify: impl FnMut(&[Item]),
    mut process: impl FnMut(
        &Selection,
        &mut dyn FnMut(&str, u8),
        &mut dyn FnMut(&str),
    ) -> Result<Option<UserMessage>>,
) -> Vec<Item> {
    let mut items: Vec<_> = selection
        .iter()
        .map(|s| Item {
            exemplar_id: s.exemplar_id.clone(),
            step: "pending".into(),
            progress: 0,
            reason: None,
            failed_at: None,
        })
        .collect();
    notify(&items);
    for (index, selected) in selection.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            items[index].step = "refused".into();
            items[index].reason = Some(device::Error::Cancelled.into());
            log_item_failure(
                &items[index].exemplar_id,
                "pending",
                "refused",
                &device::Error::Cancelled.into(),
                None,
            );
            notify(&items);
            continue;
        }
        items[index].step = "preparing".into();
        items[index].progress = 5;
        notify(&items);
        let real = std::cell::RefCell::new(String::from("preparing"));
        let result = process(
            selected,
            &mut |stage, progress| {
                items[index].step = stage.into();
                items[index].progress = progress;
                *real.borrow_mut() = stage.into();
                notify(&items);
            },
            &mut |step| *real.borrow_mut() = step.into(),
        );
        match result {
            Ok(warning) => {
                items[index].step = "done".into();
                items[index].progress = 100;
                items[index].reason = warning;
            }
            Err(error) => {
                let raw_code = error.code.clone();
                let error = safe_reason(error);
                let stage = real.into_inner();
                items[index].failed_at = Some(stage.clone());
                items[index].step = if error.code == codes::STORYTELLER_SEND_DISCONNECTED {
                    "interrupted"
                } else if [
                    codes::STORYTELLER_OFFICIAL_REFUSED,
                    codes::STORYTELLER_NAVIGATION_REFUSED,
                    codes::STORYTELLER_STORY_DUPLICATE,
                    codes::STORYTELLER_NO_SPACE,
                    codes::STORYTELLER_PROJECT_INCOMPLETE,
                    codes::STORYTELLER_IMAGE_UNREADABLE,
                    codes::STORYTELLER_IMAGE_UNREADABLE_UNNAMED,
                    codes::STORYTELLER_SOUND_UNREADABLE,
                    codes::STORYTELLER_SOUND_UNREADABLE_UNNAMED,
                    codes::GENERATION_CANCELLED,
                    codes::STORYTELLER_SEND_CANCELLED,
                ]
                .contains(&error.code.as_str())
                {
                    "refused"
                } else {
                    "failed"
                }
                .into();
                log_item_failure(
                    &items[index].exemplar_id,
                    &stage,
                    &items[index].step,
                    &error,
                    Some(&raw_code),
                );
                items[index].reason = Some(safe_reason(error));
            }
        }
        notify(&items);
    }
    items
}

/// Diagnostic line for one story that did not reach the device. Only the
/// exemplar id, the stage, the outcome, the codes and the parameters kept by
/// `safe_reason` are written: no path, file name or device data.
fn failure_log_line(
    exemplar_id: &str,
    stage: &str,
    outcome: &str,
    reason: &UserMessage,
    raw_code: Option<&str>,
) -> String {
    let mut line = format!(
        "Lunii send {outcome}: exemplar {exemplar_id}, stage {stage}, code {}",
        reason.code
    );
    if let Some(raw) = raw_code.filter(|raw| *raw != reason.code) {
        line.push_str(&format!(" (raised as {raw})"));
    }
    if !reason.params.is_empty() {
        line.push_str(&format!(
            ", params {}",
            serde_json::Value::Object(reason.params.clone())
        ));
    }
    line
}

fn log_item_failure(
    exemplar_id: &str,
    stage: &str,
    outcome: &str,
    reason: &UserMessage,
    raw_code: Option<&str>,
) {
    log::warn!(target: "lunii_send", "{}", failure_log_line(exemplar_id, stage, outcome, reason, raw_code));
}

fn extract_bindings(
    zip: &Path,
    authorized: &output_identity::StorytellerAuthorization,
    scratch: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<AdvancedMediaBinding>> {
    let mut bindings = Vec::new();
    for (rank, asset_ref) in
        crate::native_pack::persistence::referenced_asset_refs(authorized.document())
            .into_iter()
            .enumerate()
    {
        check(cancel)?;
        let path = scratch.join(format!("asset-{rank}"));
        let asset = if asset_ref.starts_with("assets/") {
            asset_ref.clone()
        } else {
            format!("assets/{asset_ref}")
        };
        let bytes = crate::services::pack_reader::get_pack_asset(&zip.to_string_lossy(), &asset)
            .map_err(UserMessage::from)?;
        fs::write(&path, bytes).map_err(failure)?;
        bindings.push(AdvancedMediaBinding {
            asset_ref,
            path: Some(path.to_string_lossy().into()),
            status: crate::native_pack::persistence::MediaBindingStatus::Resolved,
        });
    }
    Ok(bindings)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(default)]
pub(crate) struct AudioEdgeSilenceDefaults {
    leading: f64,
    trailing: f64,
}

impl Default for AudioEdgeSilenceDefaults {
    fn default() -> Self {
        Self {
            leading: crate::support::audio_norm::EDGE_SILENCE_SEC,
            trailing: crate::support::audio_norm::EDGE_SILENCE_SEC,
        }
    }
}

fn prepare_project_audio(
    raw: &mut serde_json::Value,
    defaults: AudioEdgeSilenceDefaults,
) -> crate::native_pack::advanced_export::AdvancedAudioOptions {
    use crate::domain::project::SilenceMode;

    // Saved envelopes have UI options, not the generator DTO. Resolve once for
    // both send branches, following schema.js and advancedPackAudioOptions.
    let advanced = raw["authoringMode"] == "advanced";
    let stored = &raw["globalOptions"];
    let explicit_mode = stored["silenceMode"].as_str().map(|mode| {
        if advanced {
            mode.to_owned()
        } else {
            mode.to_lowercase()
        }
    });
    let silence_mode = match explicit_mode.as_deref() {
        Some("off") => SilenceMode::Off,
        Some("add") => SilenceMode::Add,
        Some("normalize") => SilenceMode::Normalize,
        // Only the menus editor migrates the historical addSilence flag.
        _ if !advanced && stored.get("addSilence").is_some() => {
            if json_truthy(&stored["addSilence"]) {
                SilenceMode::Add
            } else {
                SilenceMode::Off
            }
        }
        _ => SilenceMode::Normalize,
    };
    let harmonize_loudness = stored["harmonizeLoudness"].as_bool().unwrap_or(true);
    let leading = stored_edge_silence(&stored["leadingSilenceSec"])
        .unwrap_or_else(|| bounded_edge_silence(defaults.leading));
    let trailing = stored_edge_silence(&stored["trailingSilenceSec"])
        .unwrap_or_else(|| bounded_edge_silence(defaults.trailing));
    if !advanced {
        if !raw["globalOptions"].is_object() {
            raw["globalOptions"] = serde_json::json!({});
        }
        let options = raw["globalOptions"].as_object_mut().unwrap();
        options.insert("silenceMode".into(), serde_json::json!(silence_mode));
        options.insert("harmonizeLoudness".into(), harmonize_loudness.into());
        options.insert(
            "addSilenceDurationSec".into(),
            serde_json::json!({"start": leading, "end": trailing}),
        );
        // normalizeOptions also supplies these fields before editor export.
        for key in ["autoNext", "nightMode"] {
            if options.get(key).is_none_or(serde_json::Value::is_null) {
                options.insert(key.into(), false.into());
            }
        }
    }
    let neutral_edges = advanced && silence_mode == SilenceMode::Off;
    crate::native_pack::advanced_export::AdvancedAudioOptions {
        silence_mode,
        harmonize_loudness,
        // buildExportRequest omits inactive durations, leaving engine defaults.
        leading_silence_sec: if neutral_edges {
            AudioEdgeSilenceDefaults::default().leading
        } else {
            leading
        },
        trailing_silence_sec: if neutral_edges {
            AudioEdgeSilenceDefaults::default().trailing
        } else {
            trailing
        },
    }
}

fn json_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn bounded_edge_silence(value: f64) -> f64 {
    // Same 0..10 s bounds as config/audioProcessing.js, on all platforms.
    if value.is_finite() {
        value.clamp(0.0, 10.0)
    } else {
        crate::support::audio_norm::EDGE_SILENCE_SEC
    }
}

fn stored_edge_silence(value: &serde_json::Value) -> Option<f64> {
    let seconds = if let Some(text) = value.as_str() {
        let text = text.trim().replace(',', ".");
        // Match the editor's decimal input (including French commas), without
        // accepting exponents, signed strings or non-finite numbers.
        if text.is_empty()
            || !text.bytes().any(|b| b.is_ascii_digit())
            || text.bytes().any(|b| !b.is_ascii_digit() && b != b'.')
            || text.bytes().filter(|b| *b == b'.').count() > 1
        {
            return None;
        }
        text.parse::<f64>().ok()?
    } else {
        value.as_f64()?
    };
    (seconds.is_finite() && seconds >= 0.0).then(|| bounded_edge_silence(seconds))
}

fn generate_project(
    app: &tauri::AppHandle,
    store: &Store,
    target: &Target,
    scratch: &Path,
    cancel: &AtomicBool,
    audio_edge_silence: AudioEdgeSilenceDefaults,
) -> Result<PathBuf> {
    let incomplete = || project_incomplete(UserMessage::new(codes::STORYTELLER_PROJECT_INVALID));
    let mut raw = catalogue::analyze::project(&target.path)
        .map_err(|e| project_incomplete(UserMessage::from(e)))?
        .raw;
    let roots = materialize::MediaRoots::for_project(&target.path, &store.workspace_roots()?, &raw);
    let folder = target.path.parent().ok_or_else(incomplete)?;
    // Resolve the saved bindings with the same confinement used by consultation.
    fn paths(value: &mut serde_json::Value, folder: &Path, roots: &materialize::MediaRoots) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, value) in map {
                    if [
                        "path",
                        "audio",
                        "image",
                        "rootImage",
                        "rootAudio",
                        "thumbnailImage",
                        "zipPath",
                        "nightModeAudio",
                        "itemAudio",
                        "itemImage",
                        "afterPlaybackPromptAudio",
                        "coverImage",
                        "coverAudio",
                    ]
                    .contains(&key.as_str())
                    {
                        if let Some(text) = value.as_str().filter(|s| !s.is_empty()) {
                            let path = Path::new(text);
                            let path = if path.is_absolute() {
                                path.to_owned()
                            } else {
                                folder.join(path)
                            };
                            if let Some(path) = roots.admit(&path) {
                                *value = path.to_string_lossy().to_string().into();
                            }
                        }
                    } else {
                        paths(value, folder, roots);
                    }
                }
            }
            serde_json::Value::Array(values) => {
                for v in values {
                    paths(v, folder, roots);
                }
            }
            _ => {}
        }
    }
    paths(&mut raw, folder, &roots);
    let audio_options = prepare_project_audio(&mut raw, audio_edge_silence);
    let should_cancel = || cancel.load(Ordering::SeqCst);
    if raw["authoringMode"] == "advanced" {
        let payload = raw
            .pointer("/authoring/payload")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(incomplete)?;
        let authorized = output_identity::authorize_storyteller(payload, Some(store))?;
        super::validate_navigation(authorized.document())?;
        let bindings: Vec<AdvancedMediaBinding> =
            serde_json::from_value(raw["authoring"]["mediaBindings"].clone())
                .map_err(|e| project_incomplete(UserMessage::from(e.to_string())))?;
        let result = crate::native_pack::advanced_export::export_advanced_pack_with_catalogue(
            &app.state::<catalogue::CatalogueState>(),
            payload,
            &bindings,
            scratch,
            &audio_options,
            None,
            None,
            None,
            None,
            &|_| {},
            &should_cancel,
        )
        .map_err(|error| {
            if matches!(
                error,
                crate::native_pack::advanced_export::AdvancedExportError::ExportCancelled
            ) {
                return UserMessage::new(codes::STORYTELLER_SEND_CANCELLED);
            }
            let cause =
                serde_json::to_value(UserMessage::new(codes::STORYTELLER_PROJECT_INVALID)).unwrap();
            UserMessage::new(codes::STORYTELLER_PROJECT_INCOMPLETE).param("cause", cause)
        })?;
        Ok(PathBuf::from(result.zip_path))
    } else {
        raw["name"] = raw["projectName"].clone();
        raw["packUuid"] = raw["packMetadata"]["uuid"].clone();
        raw["packVersion"] = raw["packMetadata"]["version"].clone();
        raw["packDescription"] = raw["packMetadata"]["description"].clone();
        let project = crate::commands::generation::parse_project_json(&raw.to_string())
            .map_err(|e| project_incomplete(UserMessage::from(e)))?;
        crate::domain::validation::validate_project_for_generation(&project)
            .map_err(|e| project_incomplete(UserMessage::from(e)))?;
        let identity =
            output_identity::for_project(&project, Some(store)).map_err(UserMessage::from)?;
        // Enforce the Storyteller identity decision before generation too.
        output_identity::decide(
            output_identity::ContentIdentity {
                uuid: &project.pack_uuid,
                provenance: project.official_provenance,
                origin_uuid: project.official_origin_uuid.as_deref(),
            },
            output_identity::OutputForm::Storyteller,
            &[],
            project.contains_official_content,
            Some(store),
        )?;
        let result = crate::native_pack::generate_with_identity(
            &project,
            &scratch.to_string_lossy(),
            &|_| {},
            &should_cancel,
            &identity,
        )
        .map_err(UserMessage::from)?;
        Ok(PathBuf::from(result.zip_path))
    }
}

fn copy_progress(
    op: Arc<Operation>,
    sink: Sink,
    exemplar: String,
    finalizing: Arc<std::sync::atomic::AtomicBool>,
) -> Box<dyn Fn(device::CopyEvent) + Send> {
    let last = std::sync::Mutex::new(std::time::Instant::now());
    Box::new(move |event| {
        if event == device::CopyEvent::Finalizing {
            finalizing.store(true, Ordering::SeqCst);
        }
        if let device::CopyEvent::Copied { copied, total } = event {
            let Ok(mut last) = last.lock() else {
                return;
            };
            if copied < total && last.elapsed() < std::time::Duration::from_millis(100) {
                return;
            }
            *last = std::time::Instant::now();
        }
        if let Ok(mut p) = op.progress.lock() {
            if let Some(items) = p.result.as_mut().and_then(|v| v["stories"].as_array_mut()) {
                if let Some(item) = items.iter_mut().find(|v| v["exemplarId"] == exemplar) {
                    apply_copy_event(item, event);
                }
            }
        }
        op.emit(&sink, false);
    })
}

/// Copy keeps its 70-99 % range; the end of the copy, when the device is
/// still being written, is its own step at the same percentage.
fn apply_copy_event(item: &mut serde_json::Value, event: device::CopyEvent) {
    match event {
        device::CopyEvent::Copied { copied, total } => {
            item["progress"] = serde_json::json!(
                70 + copied
                    .saturating_mul(29)
                    .checked_div(total)
                    .unwrap_or(0)
                    .min(29)
            );
        }
        device::CopyEvent::Finalizing => item["step"] = serde_json::json!("finalizing"),
    }
}

/// Estimate available source bytes before any generation; Install later checks
/// exact allocated bytes. Includes resolved project media and referenced packs.
fn estimate_target(target: &Target) -> Result<u64> {
    fn size(path: &Path, depth: usize) -> Result<u64> {
        if depth > 64 {
            return Err(UserMessage::new(codes::STORYTELLER_PROJECT_INVALID));
        }
        let meta = fs::symlink_metadata(path).map_err(failure)?;
        if meta.file_type().is_symlink() || device::platform::is_reparse(&meta) {
            return Err(UserMessage::new(codes::STORYTELLER_PROJECT_INVALID));
        }
        if meta.is_file() {
            return Ok(meta.len());
        }
        let mut total = 0u64;
        for e in fs::read_dir(path).map_err(failure)? {
            total = total.saturating_add(size(&e.map_err(failure)?.path(), depth + 1)?);
        }
        Ok(total)
    }
    let mut total = size(&target.path, 0)?;
    if let Some(observation) = target
        .observation
        .as_ref()
        .filter(|o| o.format == "project")
    {
        fn visit(
            value: &serde_json::Value,
            folder: &Path,
            paths: &mut std::collections::HashSet<PathBuf>,
        ) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, v) in map {
                        if [
                            "path",
                            "audio",
                            "image",
                            "rootImage",
                            "rootAudio",
                            "thumbnailImage",
                            "zipPath",
                            "nightModeAudio",
                            "itemAudio",
                            "itemImage",
                            "afterPlaybackPromptAudio",
                            "coverImage",
                            "coverAudio",
                        ]
                        .contains(&key.as_str())
                        {
                            if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
                                let p = Path::new(s);
                                paths.insert(if p.is_absolute() {
                                    p.to_owned()
                                } else {
                                    folder.join(p)
                                });
                            }
                        } else {
                            visit(v, folder, paths);
                        }
                    }
                }
                serde_json::Value::Array(values) => {
                    for v in values {
                        visit(v, folder, paths);
                    }
                }
                _ => {}
            }
        }
        let mut paths = std::collections::HashSet::new();
        visit(
            &observation.raw,
            target.path.parent().unwrap_or(&target.path),
            &mut paths,
        );
        for path in paths {
            if path.is_file() {
                total = total.saturating_add(size(&path, 0)?);
            }
        }
    }
    Ok(total)
}
fn project_incomplete(mut cause: UserMessage) -> UserMessage {
    // Preserve structured presentation data only (allowlist, see presentable).
    cause.detail = None;
    if cause.code == codes::UNEXPECTED_ERROR {
        cause.code = codes::STORYTELLER_PROJECT_INVALID.into();
    }
    let mut value = serde_json::to_value(cause).unwrap_or_default();
    presentable(&mut value);
    UserMessage::new(codes::STORYTELLER_PROJECT_INCOMPLETE).param("cause", value)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Audio oracle captured by executing the editor sources from git show
    // 93aa045af493facf49578d2e46c5186790fa22fc:
    // schema.js::projectToRustExport; packAudioOptions.js::advancedPackAudioOptions
    // followed by exportRequest.js::buildExportRequest. Never derived from send.
    const EDITOR_AUDIO_CASES: &str = r#"[
  {"name":"free/absent","project":{"authoringMode":"free"},"defaults":{"leading":0.4,"trailing":0.4},"expected":["normalize",true,0.4,0.4]},
  {"name":"free/empty","project":{"authoringMode":"free","globalOptions":{}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"free/null","project":{"authoringMode":"free","globalOptions":null},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"free/custom","project":{"authoringMode":"free","globalOptions":{"silenceMode":"normalize","harmonizeLoudness":false,"leadingSilenceSec":0,"trailingSilenceSec":1.7}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",false,0,1.7]},
  {"name":"free/partial","project":{"authoringMode":"free","globalOptions":{"leadingSilenceSec":0.8}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,0.8,2.5]},
  {"name":"free/decimal","project":{"authoringMode":"free","globalOptions":{"leadingSilenceSec":"1,7","trailingSilenceSec":" .6 "}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.7,0.6]},
  {"name":"free/invalid-edges","project":{"authoringMode":"free","globalOptions":{"leadingSilenceSec":-1,"trailingSilenceSec":"bad"}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"free/capped","project":{"authoringMode":"free","globalOptions":{"leadingSilenceSec":15,"trailingSilenceSec":"20"}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,10,10]},
  {"name":"free/invalid-mode","project":{"authoringMode":"free","globalOptions":{"silenceMode":"invalid","harmonizeLoudness":null}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"free/legacy-on","project":{"authoringMode":"free","globalOptions":{"addSilence":true}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["add",true,1.25,2.5]},
  {"name":"free/legacy-off","project":{"authoringMode":"free","globalOptions":{"addSilence":false}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["off",true,1.25,2.5]},
  {"name":"free/legacy-uppercase","project":{"authoringMode":"free","globalOptions":{"silenceMode":"ADD","addSilence":false}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["add",true,1.25,2.5]},
  {"name":"free/off-true","project":{"authoringMode":"free","globalOptions":{"silenceMode":"off","harmonizeLoudness":true,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["off",true,1.2,2.3]},
  {"name":"free/off-false","project":{"authoringMode":"free","globalOptions":{"silenceMode":"off","harmonizeLoudness":false,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["off",false,1.2,2.3]},
  {"name":"free/add-true","project":{"authoringMode":"free","globalOptions":{"silenceMode":"add","harmonizeLoudness":true,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["add",true,1.2,2.3]},
  {"name":"free/add-false","project":{"authoringMode":"free","globalOptions":{"silenceMode":"add","harmonizeLoudness":false,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["add",false,1.2,2.3]},
  {"name":"free/normalize-true","project":{"authoringMode":"free","globalOptions":{"silenceMode":"normalize","harmonizeLoudness":true,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.2,2.3]},
  {"name":"free/normalize-false","project":{"authoringMode":"free","globalOptions":{"silenceMode":"normalize","harmonizeLoudness":false,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",false,1.2,2.3]},
  {"name":"advanced/absent","project":{"authoringMode":"advanced"},"defaults":{"leading":0.4,"trailing":0.4},"expected":["normalize",true,0.4,0.4]},
  {"name":"advanced/empty","project":{"authoringMode":"advanced","globalOptions":{}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"advanced/null","project":{"authoringMode":"advanced","globalOptions":null},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"advanced/custom","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"normalize","harmonizeLoudness":false,"leadingSilenceSec":0,"trailingSilenceSec":1.7}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",false,0,1.7]},
  {"name":"advanced/partial","project":{"authoringMode":"advanced","globalOptions":{"leadingSilenceSec":0.8}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,0.8,2.5]},
  {"name":"advanced/decimal","project":{"authoringMode":"advanced","globalOptions":{"leadingSilenceSec":"1,7","trailingSilenceSec":" .6 "}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.7,0.6]},
  {"name":"advanced/invalid-edges","project":{"authoringMode":"advanced","globalOptions":{"leadingSilenceSec":-1,"trailingSilenceSec":"bad"}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"advanced/capped","project":{"authoringMode":"advanced","globalOptions":{"leadingSilenceSec":15,"trailingSilenceSec":"20"}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,10,10]},
  {"name":"advanced/invalid-mode","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"invalid","harmonizeLoudness":null}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"advanced/legacy-on","project":{"authoringMode":"advanced","globalOptions":{"addSilence":true}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"advanced/legacy-off","project":{"authoringMode":"advanced","globalOptions":{"addSilence":false}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"advanced/legacy-uppercase","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"ADD","addSilence":false}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.25,2.5]},
  {"name":"advanced/off-true","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"off","harmonizeLoudness":true,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["off",true,0.4,0.4]},
  {"name":"advanced/off-false","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"off","harmonizeLoudness":false,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["off",false,0.4,0.4]},
  {"name":"advanced/add-true","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"add","harmonizeLoudness":true,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["add",true,1.2,2.3]},
  {"name":"advanced/add-false","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"add","harmonizeLoudness":false,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["add",false,1.2,2.3]},
  {"name":"advanced/normalize-true","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"normalize","harmonizeLoudness":true,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",true,1.2,2.3]},
  {"name":"advanced/normalize-false","project":{"authoringMode":"advanced","globalOptions":{"silenceMode":"normalize","harmonizeLoudness":false,"leadingSilenceSec":1.2,"trailingSilenceSec":2.3}},"defaults":{"leading":1.25,"trailing":2.5},"expected":["normalize",false,1.2,2.3]}
]"#;

    fn assert_editor_audio_cases(mode: &str) {
        let cases: Vec<serde_json::Value> = serde_json::from_str(EDITOR_AUDIO_CASES).unwrap();
        for case in cases {
            if case["project"]["authoringMode"] != mode {
                continue;
            }
            let mut raw = case["project"].clone();
            let defaults = serde_json::from_value(case["defaults"].clone()).unwrap();
            let options = prepare_project_audio(&mut raw, defaults);
            let actual = if mode == "advanced" {
                serde_json::json!([
                    options.silence_mode,
                    options.harmonize_loudness,
                    options.leading_silence_sec,
                    options.trailing_silence_sec
                ])
            } else {
                // Read precisely the DTO consumed by the menus generator.
                let project =
                    crate::commands::generation::parse_project_json(&raw.to_string()).unwrap();
                let options = project.global_options;
                serde_json::json!([
                    options.silence_mode(),
                    options.harmonize_loudness,
                    options.leading_silence_duration_sec(),
                    options.trailing_silence_duration_sec()
                ])
            };
            // JavaScript serializes zero as 0; Rust serializes f64 as 0.0.
            // Compare the engine values, without changing the captured oracle.
            type Audio = (crate::domain::project::SilenceMode, bool, f64, f64);
            let actual: Audio = serde_json::from_value(actual).unwrap();
            let expected: Audio = serde_json::from_value(case["expected"].clone()).unwrap();
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }

    #[test]
    fn catalogue_advanced_audio_matches_editor() {
        assert_editor_audio_cases("advanced");
    }

    #[test]
    fn catalogue_free_audio_matches_editor() {
        assert_editor_audio_cases("free");
    }

    #[test]
    fn catalogue_audio_defaults_accept_missing_and_partial_preferences() {
        let empty: AudioEdgeSilenceDefaults = serde_json::from_str("{}").unwrap();
        assert_eq!((empty.leading, empty.trailing), (0.4, 0.4));
        let partial: AudioEdgeSilenceDefaults = serde_json::from_str(r#"{"leading": 0}"#).unwrap();
        assert_eq!((partial.leading, partial.trailing), (0.0, 0.4));
        let mut project = serde_json::json!({"authoringMode": "advanced"});
        let options = prepare_project_audio(
            &mut project,
            AudioEdgeSilenceDefaults {
                leading: -1.0,
                trailing: 20.0,
            },
        );
        assert_eq!(
            (options.leading_silence_sec, options.trailing_silence_sec),
            (0.0, 10.0)
        );
    }
    fn selection() -> Vec<Selection> {
        ["first", "refused", "last"]
            .iter()
            .map(|id| Selection {
                exemplar_id: (*id).into(),
                expected_revision: 1,
            })
            .collect()
    }
    #[test]
    fn failure_log_line_keeps_only_filtered_data() {
        let leaky = UserMessage::new(codes::STORYTELLER_PROJECT_INVALID)
            .param("path", "/home/alice/Mes histoires/secret.mp3")
            .with_detail("/home/alice/Mes histoires/secret.mp3");
        let raw = leaky.code.clone();
        let reason = safe_reason(leaky);
        let line = failure_log_line("ex-1", "copying", "failed", &reason, Some(&raw));
        assert!(line.contains("exemplar ex-1, stage copying"));
        assert!(line.contains(&format!("code {}", reason.code)));
        assert!(line.contains(&format!("raised as {raw}")));
        assert!(!line.contains("alice") && !line.contains("secret"));
        let space =
            safe_reason(UserMessage::new(codes::STORYTELLER_NO_SPACE).param("missingBytes", 42));
        assert_eq!(
            failure_log_line("ex-2", "preparing", "refused", &space, Some(&space.code)),
            "Lunii send refused: exemplar ex-2, stage preparing, code STORYTELLER_NO_SPACE, params {\"missingBytes\":42}"
        );
    }
    #[test]
    fn typed_code_keeps_its_code_and_loses_its_path() {
        // A declared parameter that must be filtered out leaves a code the
        // interface could not render: the generic failure, without the path.
        let raw = UserMessage::new(codes::CATALOG_STORE_CORRUPT)
            .param("path", "/home/alice/Mes histoires/catalogue.sqlite")
            .with_detail("/home/alice/Mes histoires/catalogue.sqlite");
        let safe = safe_reason(raw);
        assert_eq!(safe.code, codes::STORYTELLER_WRITE_FAILED);
        assert!(safe.params.is_empty());
        assert!(safe.detail.is_none());
        assert!(!serde_json::to_string(&safe).unwrap().contains("alice"));
        // A typed code keeps its code and its declared parameters; harmless
        // undeclared data is dropped (private undeclared data would flatten).
        let space = safe_reason(
            UserMessage::new(codes::STORYTELLER_NO_SPACE)
                .param("missingBytes", 42)
                .param("freeBytes", 7),
        );
        assert_eq!(space.code, codes::STORYTELLER_NO_SPACE);
        assert_eq!(
            space.params,
            serde_json::json!({"missingBytes":42})
                .as_object()
                .unwrap()
                .clone()
        );
        // Structured data its code does not interpolate is dropped, the code stays.
        let navigation = safe_reason(
            UserMessage::new(codes::STORYTELLER_NAVIGATION_REFUSED)
                .param("violations", serde_json::json!(["HOME_TO_ENTRY"])),
        );
        assert_eq!(navigation.code, codes::STORYTELLER_NAVIGATION_REFUSED);
        assert!(navigation.params.is_empty());
        // Without a known code nothing is trusted.
        assert_eq!(
            safe_reason(UserMessage::new("NOT_A_REGISTERED_CODE").param("label", "x")).code,
            codes::STORYTELLER_WRITE_FAILED
        );
    }
    #[test]
    fn bare_uuids_and_fingerprints_never_leave_whatever_their_name() {
        let uuid = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
        let hash = "82f2a91c0d3e4b5f";
        for key in [
            "name", "value", "error", "stderr", "body", "response", "label",
        ] {
            for secret in [uuid, hash, "82F2A91C0D3E4B5F6A7B8C9D0E1F2A3B"] {
                let mut value = serde_json::json!(secret);
                assert!(!presentable_parameter(key, &mut value), "{key}={secret}");
            }
        }
        // Undeclared: the whole message is flattened, nothing leaks.
        for key in ["name", "error", "stderr", "body", "response"] {
            let safe = safe_reason(
                UserMessage::new(codes::STORYTELLER_NAVIGATION_REFUSED).param(key, uuid),
            );
            assert_eq!(safe.code, codes::STORYTELLER_WRITE_FAILED, "{key}");
        }
        // Declared under an author-label key: removed, then flattened.
        let safe = safe_reason(
            UserMessage::new(codes::VALIDATION_PROJECT_TARGET_MISSING)
                .param("entry_name", hash)
                .param("target_label", "histoire 2"),
        );
        assert_eq!(safe.code, codes::STORYTELLER_WRITE_FAILED);
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains(uuid) && !text.contains(hash));
        // Nested messages lose them too.
        let mut nested = serde_json::json!({"code":codes::VALIDATION_PROJECT_TARGET_MISSING,
            "params":{"entry_name":uuid,"target_label":hash}});
        presentable(&mut nested);
        assert_eq!(nested["params"], serde_json::json!({}));
        // Short hexadecimal-looking words and author labels stay.
        let mut word = serde_json::json!("Cafe bebe");
        assert!(presentable_parameter("label", &mut word));
        let mut short = serde_json::json!("deadbeef");
        assert!(presentable_parameter("label", &mut short));
    }
    #[test]
    fn unreadable_media_is_a_refusal_naming_the_screen_in_ipc_and_log() {
        for (code, unnamed) in [
            (
                codes::STORYTELLER_IMAGE_UNREADABLE,
                codes::STORYTELLER_IMAGE_UNREADABLE_UNNAMED,
            ),
            (
                codes::STORYTELLER_SOUND_UNREADABLE,
                codes::STORYTELLER_SOUND_UNREADABLE_UNNAMED,
            ),
        ] {
            let items = run_batch(
                &selection(),
                &AtomicBool::new(false),
                |_| {},
                |selected, _| match selected.exemplar_id.as_str() {
                    "refused" => Err(UserMessage::new(code).param("screen", "La girafe")),
                    "last" => Err(UserMessage::new(unnamed)),
                    _ => Ok(None),
                },
            );
            assert_eq!(items[0].step, "done");
            assert_eq!(items[1].step, "refused", "{code} is deterministic");
            let reason = items[1].reason.as_ref().unwrap();
            assert_eq!(reason.code, code);
            assert_eq!(reason.params["screen"], "La girafe");
            assert_eq!(items[2].step, "refused");
            assert_eq!(items[2].reason.as_ref().unwrap().code, unnamed);
            assert_eq!(
                failure_log_line("refused", "preparing", "refused", reason, Some(code)),
                format!("Lunii send refused: exemplar refused, stage preparing, code {code}, params {{\"screen\":\"La girafe\"}}")
            );
        }
        // A screen name shaped like a path or an identity is never shown: the
        // sentence without a name is used instead.
        for (code, unnamed) in [
            (
                codes::STORYTELLER_IMAGE_UNREADABLE,
                codes::STORYTELLER_IMAGE_UNREADABLE_UNNAMED,
            ),
            (
                codes::STORYTELLER_SOUND_UNREADABLE,
                codes::STORYTELLER_SOUND_UNREADABLE_UNNAMED,
            ),
        ] {
            for screen in ["/home/alice", "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"] {
                let safe = safe_reason(UserMessage::new(code).param("screen", screen));
                assert_eq!(safe.code, unnamed, "{screen}");
                assert!(safe.params.is_empty());
            }
        }
        let mut relative = serde_json::json!("Jour/Nuit");
        assert!(presentable_parameter("screen", &mut relative));
    }
    #[test]
    fn disconnected_item_is_interrupted_and_keeps_its_typed_reason() {
        let items = run_batch(
            &selection()[..1],
            &AtomicBool::new(false),
            |_| {},
            |_, _| Err(device::Error::Disconnected.into()),
        );
        assert_eq!(items[0].step, "interrupted");
        assert_eq!(
            items[0].reason.as_ref().unwrap().code,
            codes::STORYTELLER_SEND_DISCONNECTED
        );
    }
    #[test]
    fn structured_causes_and_ipc_parameters_survive_safe_reason() {
        let cause = UserMessage::new(codes::VALIDATION_PROJECT_ERRORS).param("errors", serde_json::json!({
            "messages": [{"code": codes::VALIDATION_FIELD_MISSING_MASCULINE, "params": {"label": "Audio"}}], "separator": "\n"
        }));
        let wrapped = safe_reason(project_incomplete(cause.clone()));
        assert_eq!(wrapped.code, codes::STORYTELLER_PROJECT_INCOMPLETE);
        assert_eq!(
            wrapped.params["cause"],
            serde_json::to_value(cause).unwrap()
        );
        let duplicate = safe_reason(device::Error::Duplicate { position: Some(3) }.into());
        assert_eq!(duplicate.params["position"], 4);
        let space = safe_reason(device::Error::NoSpace { missing_bytes: 42 }.into());
        assert_eq!(space.params["missingBytes"], 42);
        assert_eq!(
            safe_reason(UserMessage::new(codes::GENERATION_CANCELLED)).code,
            codes::STORYTELLER_SEND_CANCELLED
        );
    }
    #[test]
    fn ipc_strips_nested_diagnostics_and_internal_paths() {
        let cause = UserMessage::new(codes::VALIDATION_PROJECT_ERRORS)
            .param("errors", serde_json::json!({"detail":"/private/project", "diagnostic":{"uuid":"secret", "path":"/private/path"}, "messages":[]}))
            .with_detail("/private/diagnostic");
        let safe = safe_reason(project_incomplete(cause));
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("/private"));
        assert!(!text.contains("secret"));
        assert!(safe.params["cause"]["params"]["errors"]
            .get("diagnostic")
            .is_none());
        assert!(safe.detail.is_none());
    }
    #[test]
    fn ipc_keeps_only_declared_presentation_keys() {
        let cause = UserMessage::new(codes::VALIDATION_PROJECT_ERRORS).param(
            "errors",
            serde_json::json!({
                "messages": [
                    {"code": codes::VALIDATION_FIELD_MISSING_MASCULINE,
                     "params": {"label": "Audio", "secretKey": "/private/a", "folderPath": "/private/b"},
                     "extra": "/private/c"},
                    "/private/raw"
                ],
                "separator": "\n",
                "data": true,
                "unknown": {"anything": "/private/d"}
            }),
        );
        let safe = safe_reason(project_incomplete(cause.param("unexpected", "/private/e")));
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("/private"), "{text}");
        let messages = &safe.params["cause"]["params"]["errors"]["messages"];
        assert_eq!(messages.as_array().unwrap().len(), 1);
        assert_eq!(messages[0]["params"]["label"], "Audio");
        assert!(identity_key("rootUuid") && !identity_key("entry_names"));
        assert!(!identity_key("label") && !identity_key("missingBytes"));
    }
    #[test]
    fn ipc_preserves_author_labels_and_registry_is_not_empty() {
        assert_eq!(
            contract(codes::VALIDATION_PROJECT_TARGET_MISSING),
            ["entry_name", "target_label"]
        );
        let mut message = serde_json::json!({"messages": [
            {"code": codes::VALIDATION_PROJECT_TARGET_MISSING, "params": {"entry_name": "Menu des héros", "target_label": "histoire 2"}},
            {"code": codes::VALIDATION_IMPORTED_ARCHIVE_INVALID, "params": {"zip_label": "Mes aventures"}},
            {"code": codes::CATALOG_STORE_CORRUPT, "params": {"path": "/private/catalogue"}}
        ]});
        presentable(&mut message);
        assert_eq!(
            message["messages"][0]["params"]["entry_name"],
            "Menu des héros"
        );
        assert_eq!(
            message["messages"][1]["params"]["zip_label"],
            "Mes aventures"
        );
        assert!(message["messages"][2]["params"]
            .as_object()
            .unwrap()
            .is_empty());
        for label in ["entry_context", "zip_name", "review_entry_names"] {
            assert!(!identity_key(label));
        }
        for internal in [
            "path",
            "dir",
            "root",
            "folderPath",
            "sourceDir",
            "uuid",
            "id",
            "entry_id",
            "entryId",
            "existingId",
            "stageId",
            "stage_id",
            "actionId",
            "action_id",
            "asset_ref",
            "assetRef",
            "assetName",
            "identity",
        ] {
            assert!(identity_key(internal), "{internal}");
        }
    }
    #[test]
    fn ipc_drops_path_names_and_path_shaped_text_but_keeps_author_labels() {
        for key in [
            "zip_path_buf",
            "self_root",
            "packRoot",
            "entryAbsolute",
            "entryRelative",
            "outputZip",
            "cachedZip",
            "assetFolder",
            "outputFolder",
            "directory",
            "xttsDirectory",
            "serverOutputDirectory",
            "requestedOutputFile",
            "file",
            "filename",
            "detail",
            "details",
            "source",
        ] {
            assert!(identity_key(key), "{key}");
        }
        for (code, key) in [
            (codes::IMPORT_STORY_FILE_MISSING, "zip_path_buf"),
            (codes::EXPORT_TEMP_WORKSPACE_DELETE_FAILED, "self_root"),
            (codes::FILES_ARCHIVE_ENTRY_READ_FAILED, "entryAbsolute"),
            (codes::FILES_ZIP_WRITE_FAILED, "outputZip"),
        ] {
            assert!(contract(code).iter().any(|p| p == key));
            let mut message = serde_json::json!({"code":code,"params":{key:"private"}});
            presentable(&mut message);
            assert_eq!(message["params"], serde_json::json!({}));
        }
        // Exercise detail with its actual registry contract, even without separators.
        let registry: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../src/locales/_generated/rust-messages.json"
        ))
        .unwrap();
        let code = registry
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| {
                entry["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p == "detail")
            })
            .unwrap()["code"]
            .as_str()
            .unwrap();
        let mut message = serde_json::json!({"code":code,"params":{"detail":"private"}});
        presentable(&mut message);
        assert_eq!(message["params"], serde_json::json!({}));
        for text in [
            "/private/story",
            r"C:\private\story",
            r"\\server\story",
            "relative/story",
            r"relative\story",
        ] {
            let mut message = serde_json::json!({"code":codes::VALIDATION_PROJECT_TARGET_MISSING,
                "params":{"entry_name":text,"target_label":"Jour/Nuit"}});
            presentable(&mut message);
            assert_eq!(message["params"]["target_label"], "Jour/Nuit");
            if text.starts_with("relative") {
                assert_eq!(message["params"]["entry_name"], text);
            } else {
                assert!(message["params"].get("entry_name").is_none());
            }
            let mut value = serde_json::Value::String(text.into());
            assert!(!presentable_parameter("other", &mut value));
        }
        let mut label = serde_json::json!("Menu des héros");
        assert!(presentable_parameter("entry_name", &mut label));
        let mut label = serde_json::json!("Jour/Nuit");
        assert!(presentable_parameter("entry_name", &mut label));
    }
    #[test]
    fn refused_middle_item_keeps_selection_order_and_continues() {
        let mut processed = Vec::new();
        let mut snapshots = Vec::new();
        let items = run_batch(
            &selection(),
            &AtomicBool::new(false),
            |items| snapshots.push(items.iter().map(|i| i.step.clone()).collect::<Vec<_>>()),
            |s, stage| {
                processed.push(s.exemplar_id.clone());
                if s.exemplar_id == "refused" {
                    return Err(UserMessage::new(codes::STORYTELLER_OFFICIAL_REFUSED));
                }
                stage("generating", 20);
                stage("copying", 70);
                Ok(None)
            },
        );
        assert_eq!(processed, vec!["first", "refused", "last"]);
        assert_eq!(
            items.iter().map(|i| i.step.as_str()).collect::<Vec<_>>(),
            vec!["done", "refused", "done"]
        );
        assert_eq!(
            items[1].reason.as_ref().unwrap().code,
            codes::STORYTELLER_OFFICIAL_REFUSED
        );
        assert_eq!(snapshots[0], vec!["pending"; 3]);
        assert_eq!(items[2].progress, 100);
    }
    #[test]
    fn cancellation_preserves_committed_items_and_settles_pending_rows() {
        let cancel = AtomicBool::new(false);
        let mut processed = 0;
        let items = run_batch(
            &selection(),
            &cancel,
            |_| {},
            |_, _| {
                processed += 1;
                cancel.store(true, Ordering::SeqCst);
                Ok(None)
            },
        );
        assert_eq!(processed, 1);
        assert_eq!(items[0].step, "done");
        for item in &items[1..] {
            assert_eq!(item.step, "refused");
            assert_eq!(
                item.reason.as_ref().unwrap().code,
                codes::STORYTELLER_SEND_CANCELLED
            );
        }
    }

    #[test]
    fn prep_steps_map_to_distinct_stage_names_and_keep_the_progress() {
        assert_eq!(prep_stage(PrepStep::ConvertingSounds), "convertingSounds");
        assert_eq!(prep_stage(PrepStep::ConvertingImages), "convertingImages");
        let selection = &selection()[..1];
        let mut seen = Vec::new();
        let items = run_batch(
            selection,
            &AtomicBool::new(false),
            |items| seen.push((items[0].step.clone(), items[0].progress)),
            |_, stage| {
                stage("preparing", 5);
                stage(prep_stage(PrepStep::ConvertingSounds), 5);
                stage("encrypting", 5);
                stage("copying", 70);
                Ok(None)
            },
        );
        assert_eq!(items[0].step, "done");
        let steps: Vec<_> = seen.iter().map(|(s, p)| (s.as_str(), *p)).collect();
        assert_eq!(
            steps,
            vec![
                ("pending", 0),
                ("preparing", 5),
                ("preparing", 5),
                ("convertingSounds", 5),
                ("encrypting", 5),
                ("copying", 70),
                ("done", 100),
            ]
        );
    }

    #[test]
    fn copy_events_keep_the_range_and_finalizing_is_its_own_step() {
        let mut item = serde_json::json!({"exemplarId":"x","step":"copying","progress":70});
        apply_copy_event(
            &mut item,
            device::CopyEvent::Copied {
                copied: 50,
                total: 100,
            },
        );
        assert_eq!(
            (item["step"].as_str(), item["progress"].as_u64()),
            (Some("copying"), Some(84))
        );
        apply_copy_event(
            &mut item,
            device::CopyEvent::Copied {
                copied: 100,
                total: 100,
            },
        );
        apply_copy_event(&mut item, device::CopyEvent::Finalizing);
        assert_eq!(
            (item["step"].as_str(), item["progress"].as_u64()),
            (Some("finalizing"), Some(99))
        );
    }

    #[test]
    fn slow_work_is_announced_once_and_fast_work_never() {
        use std::{cell::Cell, time::Duration};
        let announced = Cell::new(0);
        let value = run_announcing_if_slow(
            Duration::from_millis(30),
            || {
                std::thread::sleep(Duration::from_millis(300));
                7
            },
            || announced.set(announced.get() + 1),
        );
        assert_eq!((value, announced.get()), (7, 1));
        let announced = Cell::new(0);
        let value = run_announcing_if_slow(
            Duration::from_secs(30),
            || 8,
            || announced.set(announced.get() + 1),
        );
        assert_eq!(
            (value, announced.get()),
            (8, 0),
            "a fast job returns without waiting for the delay"
        );
    }

    #[test]
    fn the_failure_log_names_the_real_step_even_when_it_was_never_shown() {
        let mut one = selection()[..1].to_vec();
        for (id, entered, expected) in [
            ("hidden-encrypting", "encrypting", "encrypting"),
            ("hidden-finalizing", "finalizing", "finalizing"),
        ] {
            one[0].exemplar_id = id.into();
            let items = run_batch_tracked(
                &one,
                &AtomicBool::new(false),
                |_| {},
                |_, stage, enter| {
                    stage("copying", 70);
                    enter(entered);
                    Err(UserMessage::new(codes::STORYTELLER_WRITE_FAILED))
                },
            );
            assert_eq!(items[0].step, "failed");
            assert_eq!(items[0].progress, 70, "the displayed step is untouched");
            assert_eq!(items[0].failed_at.as_deref(), Some(expected));
        }
    }
}
