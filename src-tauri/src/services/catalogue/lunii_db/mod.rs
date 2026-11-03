//! Official fill tool and immutable fiche metadata; never personal corrections.
use super::{
    scan,
    store::{error, Store},
    Result,
};
use crate::support::{
    network::bounded::{self, Failure},
    user_message::{codes, UserMessage},
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
mod covers;
mod device_covers;
mod fill;
mod legacy;
mod names;
pub mod parse;
#[cfg(test)]
mod tests;
pub(crate) use fill::{
    missing as fill_missing, missing_in_mutation as fill_missing_in_mutation, restore_covers,
    retained_covers,
};
pub use names::clean;
const MAX_BYTES: usize = 32 * 1024 * 1024;
#[cfg(not(test))]
const AUTH: &str = "https://server-auth-prod.lunii.com/guest/create";
#[cfg(not(test))]
const PACKS: &str = "https://server-data-prod.lunii.com/v2/packs";
#[derive(Default)]
pub(crate) struct Runtime {
    #[cfg(test)]
    download_responses: Mutex<std::collections::VecDeque<Vec<u8>>>,
    #[cfg(test)]
    download_requests: std::sync::atomic::AtomicUsize,
    network_cancel: Mutex<Arc<AtomicBool>>,
    job: Mutex<Option<Arc<scan::Operation>>>,
    automatic: Mutex<()>,
    opened: AtomicBool,
    attempted: AtomicBool,
    cover_attempted: Mutex<std::collections::HashSet<String>>,
    device_covers: Mutex<device_covers::DeviceCovers>,
    #[cfg(test)]
    endpoints: Mutex<Option<(String, String)>>,
    #[cfg(test)]
    cover_base: Mutex<Option<String>>,
    #[cfg(test)]
    cover_response: Mutex<Option<Vec<u8>>>,
    #[cfg(test)]
    cover_response_configured: AtomicBool,
    cover: Mutex<std::collections::VecDeque<(String, Arc<covers::Acquisition>)>>,
    #[cfg(test)]
    cover_pause: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    #[cfg(test)]
    cover_requests: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    cover_waiters: std::sync::atomic::AtomicUsize,
}
fn message(code: &str) -> UserMessage {
    UserMessage::new(code)
}
fn failure(e: Failure) -> UserMessage {
    message(match e {
        Failure::Offline | Failure::Refused | Failure::Status => codes::CATALOG_LUNII_OFFLINE,
        Failure::Timeout => codes::CATALOG_LUNII_TIMEOUT,
        Failure::TooLarge => codes::CATALOG_LUNII_TOO_LARGE,
        Failure::Cancelled => codes::GENERATION_CANCELLED,
        Failure::Busy => codes::CATALOG_LUNII_BUSY,
    })
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
impl Store {
    fn download_lunii(
        &self,
        url: &str,
        token: Option<&str>,
        max: usize,
        cancel: &AtomicBool,
        deadline: Instant,
        progress: impl Fn(usize),
    ) -> std::result::Result<Vec<u8>, Failure> {
        if !self.lunii_allowed() {
            return Err(Failure::Cancelled);
        }
        #[cfg(test)]
        {
            self.lunii.download_requests.fetch_add(1, Ordering::SeqCst);
            if let Some(bytes) = self.lunii.download_responses.lock().unwrap().pop_front() {
                return Ok(bytes);
            }
        }
        download(url, token, max, cancel, deadline, progress)
    }
    pub fn lunii_permission(&self) -> Result<Option<bool>> {
        self.read(|c| {
            c.query_row("SELECT allowed FROM lunii_permission WHERE id=1", [], |r| {
                r.get(0)
            })
        })
    }
    pub fn set_lunii_permission(&self, allowed: bool) -> Result<()> {
        self.write(|tx| {
            tx.execute(
                "UPDATE lunii_permission SET allowed=?1 WHERE id=1",
                [allowed],
            )
            .map_err(error)?;
            Ok(())
        })?;
        {
            let mut cancel = self.lunii.network_cancel.lock().map_err(error)?;
            if allowed {
                if cancel.load(Ordering::SeqCst) {
                    *cancel = Arc::new(AtomicBool::new(false));
                }
            } else {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        if !allowed {
            if let Some(op) = self.lunii.job.lock().map_err(error)?.as_ref() {
                op.cancel.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
    pub(crate) fn lunii_allowed(&self) -> bool {
        self.lunii_permission().is_ok_and(|v| v == Some(true))
    }
    #[cfg(test)]
    pub fn lunii_status(&self) -> Result<Value> {
        self.read_snapshot(|c| {
            let state=c.query_row("SELECT cached_at,source FROM lunii_state WHERE id=1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional()?;
            let count:i64=c.query_row("SELECT count(*) FROM lunii_pack",[],|r|r.get(0))?;
            Ok(json!({"cachedAt":state.as_ref().map(|s|s.0),"source":state.map(|s|s.1),"entryCount":count}))
        })
    }
    pub fn lunii_locale(&self, locale: &str) -> Result<()> {
        let normalized = locale.replace('-', "_").to_ascii_lowercase();
        let locale = match normalized.as_str() {
            "en_gb" => "en_GB",
            "en_us" => "en_US",
            "en" => "en",
            "it" | "it_it" => "it_IT",
            "fr" | "fr_fr" => "fr_FR",
            _ => "en",
        };
        self.write(|tx| {
            let changed = tx
                .execute(
                    "UPDATE lunii_context SET locale=?1 WHERE id=1 AND locale!=?1",
                    [locale],
                )
                .map_err(error)?;
            let _ = changed;
            Ok(())
        })
    }
    fn publish_lunii(&self, index: &parse::Index, source: &str, cancel: &AtomicBool) -> Result<()> {
        self.write(|tx| {
            bounded::check(cancel, Instant::now() + Duration::from_secs(30)).map_err(failure)?;
            for (uuid, value) in index {
                tx.execute(
                    "INSERT INTO lunii_pack VALUES (?1,?2) ON CONFLICT(uuid) DO UPDATE SET document_json=excluded.document_json",
                    rusqlite::params![uuid, value.to_string()],
                )
                .map_err(error)?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO lunii_state(id,cached_at,source,projection_version) VALUES (1,?1,?2,?3)",
                rusqlite::params![now() as i64, source, parse::PROJECTION_VERSION],
            )
            .map_err(error)?;
            fill::missing(tx)?;
            tx.execute("UPDATE catalogue SET revision=revision+1", []).map_err(error)?;
            bounded::check(cancel, Instant::now() + Duration::from_secs(30)).map_err(failure)?;
            Ok(())
        })
    }
    #[cfg(test)]
    pub(crate) fn load_lunii_fixture(&self, path: &Path) -> Result<Value> {
        let index = legacy::read(path)?;
        self.publish_lunii(&index, "import", &AtomicBool::new(false))?;
        self.lunii_status()
    }
    pub fn open_lunii(self: &Arc<Self>, locale: &str, sink: scan::Sink) -> Result<Value> {
        #[cfg(test)]
        let (auth, packs) = ("http://127.0.0.1:9/auth", "http://127.0.0.1:9/packs");
        #[cfg(not(test))]
        let (auth, packs) = (AUTH, PACKS);
        self.open_lunii_from(locale, sink, auth.to_owned(), packs.to_owned())
    }
    fn open_lunii_from(
        self: &Arc<Self>,
        locale: &str,
        sink: scan::Sink,
        auth: String,
        packs: String,
    ) -> Result<Value> {
        #[cfg(test)]
        {
            *self.lunii.endpoints.lock().map_err(error)? = Some((auth.clone(), packs.clone()));
        }
        self.lunii_locale(locale)?;
        self.write(|tx| {
            fill::missing(tx)?;
            Ok(())
        })?;
        let operation = self.automatic_lunii_from(sink.clone(), auth, packs)?;
        self.download_lunii_covers(sink);
        Ok(json!({"operation":operation}))
    }
    fn ensure_lunii(self: &Arc<Self>, sink: scan::Sink) {
        #[cfg(test)]
        let (auth, packs) = self
            .lunii
            .endpoints
            .lock()
            .ok()
            .and_then(|e| e.clone())
            .unwrap_or_else(|| {
                (
                    "http://127.0.0.1:9/auth".into(),
                    "http://127.0.0.1:9/packs".into(),
                )
            });
        #[cfg(not(test))]
        let (auth, packs) = (AUTH.into(), PACKS.into());
        if let Err(reason) = self.automatic_lunii_from(sink, auth, packs) {
            log::warn!("Official metadata deferred: {}", reason.code);
        }
    }
    pub(crate) fn prepare_lunii_scan(self: &Arc<Self>, sink: scan::Sink) {
        self.ensure_lunii(sink);
        let until = Instant::now() + Duration::from_millis(350);
        while Instant::now() < until {
            let running = self
                .lunii
                .job
                .lock()
                .ok()
                .and_then(|j| j.clone())
                .is_some_and(|op| {
                    op.progress
                        .lock()
                        .is_ok_and(|p| matches!(p.status.as_str(), "queued" | "running"))
                });
            if !running {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn lunii_refresh_path(&self) -> std::path::PathBuf {
        self.images_root().parent().unwrap().join("lunii-refresh")
    }
    fn automatic_lunii_from(
        self: &Arc<Self>,
        sink: scan::Sink,
        auth: String,
        packs: String,
    ) -> Result<Option<Value>> {
        let _automatic = self.lunii.automatic.lock().map_err(error)?;
        if !self.lunii_allowed() {
            return Ok(None);
        }
        let first = !self.lunii.opened.swap(true, Ordering::SeqCst);
        let force = first && self.lunii_refresh_path().is_file();
        let due = self.read(|c| {
            let empty: bool =
                c.query_row("SELECT NOT EXISTS(SELECT 1 FROM lunii_pack)", [], |r| {
                    r.get(0)
                })?;
            let outdated: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM lunii_state WHERE projection_version<?1)",
                [parse::PROJECTION_VERSION],
                |r| r.get(0),
            )?;
            Ok(force || ((empty || outdated) && !self.lunii.attempted.load(Ordering::SeqCst)))
        })?;
        if !due {
            return Ok(None);
        }
        if self
            .lunii
            .job
            .lock()
            .map_err(error)?
            .as_ref()
            .is_some_and(|o| {
                o.progress
                    .lock()
                    .is_ok_and(|p| matches!(p.status.as_str(), "queued" | "running" | "cancelling"))
            })
        {
            return Ok(None);
        }
        self.lunii.attempted.store(true, Ordering::SeqCst);
        self.refresh_lunii_from(
            format!("lunii-auto-{}", uuid::Uuid::new_v4()),
            sink,
            auth,
            packs,
        )
        .map(Some)
    }
    fn refresh_lunii_from(
        self: &Arc<Self>,
        request: String,
        sink: scan::Sink,
        auth: String,
        packs: String,
    ) -> Result<Value> {
        if !self.lunii_allowed() {
            return Err(message(codes::CATALOG_LUNII_OFFLINE));
        }
        if request.is_empty() || request.len() > 200 {
            return Err(message(codes::CATALOG_MUTATION_INVALID));
        }
        let mut job = self.lunii.job.lock().map_err(error)?;
        if let Some(op) = job.as_ref() {
            let p = op.progress.lock().map_err(error)?;
            if p.request_id == request {
                return Ok(
                    json!({"operationId":p.operation_id,"requestId":p.request_id,"sourcesRevision":p.sources_revision,"catalogueRevision":p.catalogue_revision}),
                );
            }
            if matches!(p.status.as_str(), "queued" | "running" | "cancelling") {
                return Err(message(codes::CATALOG_LUNII_BUSY));
            }
        }
        // Diagnostic trace only; automatic scheduling uses the session flag.
        self.write(|tx| {
            tx.execute(
                "UPDATE lunii_automatic SET attempted_at=?1 WHERE id=1",
                [now() as i64],
            )
            .map_err(error)?;
            Ok(())
        })?;
        let (receipt, op) = self.begin_file_report(&request, "lunii", 1, sink.clone())?;
        *job = Some(Arc::clone(&op));
        drop(job);
        let consume_refresh = self.lunii_refresh_path().is_file();
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            store.update_file_report(&op, &sink, |p| {
                p.status = "running".into();
                p.phase = "download".into();
            });
            let result: Result<()> = (|| {
                let deadline = Instant::now() + Duration::from_secs(300);
                if !store.lunii_allowed() {
                    return Err(message(codes::CATALOG_LUNII_OFFLINE));
                }
                let token = store
                    .download_lunii(&auth, None, 64 * 1024, &op.cancel, deadline, |_| {
                        op.emit(&sink, false)
                    })
                    .map_err(failure)?;
                let token: Value = serde_json::from_slice(&token)
                    .map_err(|_| message(codes::CATALOG_LUNII_INVALID))?;
                let token = token
                    .pointer("/response/token/server")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty() && s.len() <= 8192)
                    .ok_or_else(|| message(codes::CATALOG_LUNII_INVALID))?;
                if !store.lunii_allowed() {
                    return Err(message(codes::CATALOG_LUNII_OFFLINE));
                }
                let bytes = store
                    .download_lunii(&packs, Some(token), MAX_BYTES, &op.cancel, deadline, |n| {
                        store.update_file_report(&op, &sink, |p| {
                            p.download_bytes = Some(n as u64);
                        })
                    })
                    .map_err(failure)?;
                let index = parse::parse(&bytes)?;
                bounded::check(&op.cancel, deadline).map_err(failure)?;
                let _gate = store.lunii.job.lock().map_err(error)?;
                store.publish_lunii(&index, "network", &op.cancel)?;
                op.published.store(true, Ordering::SeqCst);
                store.update_file_report(&op, &sink, |p| {
                    p.record(String::new(), None, "updated", None);
                });
                Ok(())
            })();
            if let Err(reason) = &result {
                log::warn!("Official metadata unavailable: {}", reason.code);
            }
            let marker = store.lunii_refresh_path();
            if result.is_ok() && consume_refresh && marker.is_file() {
                if let Err(reason) = std::fs::remove_file(marker) {
                    log::warn!("Official refresh marker unavailable: {:?}", reason.kind());
                }
            }
            store.download_lunii_covers(sink.clone());
            let revision = store
                .list_sources()
                .map(|s| s.catalogue_revision)
                .unwrap_or(0);
            let cancelled =
                !op.published.load(Ordering::SeqCst) && op.cancel.load(Ordering::SeqCst);
            Store::finish_file_report(&op, &sink, result, revision, cancelled);
        });
        serde_json::to_value(receipt).map_err(error)
    }
}
pub fn values(
    c: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<(serde_json::Map<String, Value>, Option<String>)> {
    let rows=c.prepare("SELECT v.field,v.value_json,p.language,v.image_sha256 FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind='lunii' ORDER BY v.field,v.language")?.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let locale: String = c.query_row("SELECT locale FROM lunii_context WHERE id=1", [], |r| {
        r.get(0)
    })?;
    let mut infos = serde_json::Map::new();
    for (_, _, language, _) in &rows {
        if let Some(language) = language {
            infos.insert(language.clone(), json!({}));
        }
    }
    let chosen = parse::localized(&json!({"localized_infos":infos}), &locale).map(|v| v.0);
    let mut values = serde_json::Map::new();
    for (field, raw, language, sha) in rows {
        if field != "cover" && language != chosen {
            continue;
        }
        if let Ok(mut value) = serde_json::from_str::<Value>(&raw) {
            if field == "cover" {
                if let Some(sha) = sha {
                    value["sha256"] = json!(sha);
                }
            }
            values.entry(field).or_insert(value);
        }
    }
    let locale = chosen;
    Ok((values, locale))
}
pub fn ordered_names(entries: &[Value]) -> Vec<String> {
    let mut entries: Vec<_> = entries
        .iter()
        .filter(|e| e["retired"] != true && e["state"] != "missing")
        .collect();
    let rank = |e: &Value| match e["format"].as_str().unwrap_or("") {
        "project" => 0,
        "zip" => 1,
        "7z" => 2,
        "studioDirectory" | "fsDirectory" | "fsZip" => 3,
        _ => 4,
    };
    let compare_text = |a: Option<&str>, b: Option<&str>| match (a, b) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, _) => std::cmp::Ordering::Greater,
        (_, None) => std::cmp::Ordering::Less,
        (Some(a), Some(b)) => a.cmp(b),
    };
    entries.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| b["modifiedAt"].as_i64().cmp(&a["modifiedAt"].as_i64()))
            .then_with(|| {
                compare_text(a["locator"]["path"].as_str(), b["locator"]["path"].as_str())
            })
            .then_with(|| {
                compare_text(
                    a["locator"]["member"].as_str(),
                    b["locator"]["member"].as_str(),
                )
            })
            .then_with(|| compare_text(a["id"].as_str(), b["id"].as_str()))
    });
    entries
        .iter()
        .filter_map(|e| {
            e["locator"]["member"]
                .as_str()
                .or_else(|| e["locator"]["path"].as_str())
        })
        .map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p).to_owned())
        .collect()
}
fn image_path(pack: &Value, locale: &str) -> Option<String> {
    pack["localized_infos"][locale]["imagePath"]
        .as_str()
        .map(str::to_owned)
}
fn image_key(path: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(path.as_bytes()))
}

pub(crate) fn valid_cover(value: &Value) -> bool {
    value["kind"] == "lunii"
        && value["imagePath"]
            .as_str()
            .is_some_and(|p| parse::image_path_valid(p) && value["key"] == image_key(p))
}

/// Inactivity is independent of the generous global budget for token + index.
fn download(
    url: &str,
    token: Option<&str>,
    max: usize,
    cancel: &AtomicBool,
    deadline: Instant,
    progress: impl Fn(usize),
) -> std::result::Result<Vec<u8>, Failure> {
    download_idle(
        url,
        token,
        max,
        cancel,
        deadline,
        Duration::from_secs(15),
        progress,
    )
}
fn download_idle(
    url: &str,
    token: Option<&str>,
    max: usize,
    cancel: &AtomicBool,
    deadline: Instant,
    idle: Duration,
    progress: impl Fn(usize),
) -> std::result::Result<Vec<u8>, Failure> {
    bounded::check(cancel, deadline)?;
    let stop = AtomicBool::new(false);
    let last = std::cell::Cell::new((0, Instant::now()));
    let result = bounded::get(url, token, max, &stop, deadline, |n| {
        if n != last.get().0 {
            last.set((n, Instant::now()));
        }
        stop.store(
            cancel.load(Ordering::SeqCst) || last.get().1.elapsed() >= idle,
            Ordering::SeqCst,
        );
        progress(n);
    });
    match result {
        Err(Failure::Cancelled) if !cancel.load(Ordering::SeqCst) => Err(Failure::Timeout),
        result => result,
    }
}
