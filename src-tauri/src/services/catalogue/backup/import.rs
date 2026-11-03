//! Cancellable preparation and atomic application through the common operation registry.
use super::{
    matching::{self, Plan},
    staging::{self, Staged},
    *,
};
use crate::services::catalogue::scan;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Conflict {
    pub id: String,
    pub target: Value,
    pub local: Value,
    pub incoming: Value,
    pub default_choice: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Unresolved {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportPreview {
    pub preview_id: String,
    pub format_version: u32,
    pub backup_digest: String,
    pub expected_catalogue_revision: i64,
    pub additions: Vec<Value>,
    pub changes: Vec<Value>,
    pub conflicts: Vec<Conflict>,
    pub unresolved: Vec<Unresolved>,
    pub counts: format::Counts,
    pub issues: Vec<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImport {
    pub preview_id: String,
    pub choices: BTreeMap<String, String>,
    pub associations: BTreeMap<String, String>,
    pub expected_catalogue_revision: i64,
    pub request_id: String,
}
pub(super) struct Prepared {
    pub staged: Staged,
    pub plan: Plan,
    pub source: PathBuf,
    pub created: Instant,
    pub associations: BTreeMap<String, String>,
}
pub(super) fn invalid() -> UserMessage {
    UserMessage::new(codes::CATALOG_IMPORT_INVALID)
}
pub(super) fn association_invalid() -> UserMessage {
    UserMessage::new(codes::CATALOG_IMPORT_ASSOCIATION_INVALID)
}
fn expired() -> UserMessage {
    UserMessage::new(codes::CATALOG_IMPORT_PREVIEW_EXPIRED)
}
fn revision_conflict() -> UserMessage {
    UserMessage::new(codes::CATALOG_REVISION_CONFLICT)
}
fn request_valid(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 200 {
        return Err(invalid());
    }
    Ok(())
}
impl Store {
    pub fn preview_catalogue_import(
        self: &Arc<Self>,
        path: PathBuf,
        request: String,
        associations: BTreeMap<String, String>,
        sink: scan::Sink,
    ) -> Result<Value> {
        request_valid(&request)?;
        if !path.is_absolute() || associations.len() > format::MAX_ROWS {
            return Err(invalid());
        }
        let signature = json!({"preview":path,"associations":associations}).to_string();
        let mut registry = self.backup_exports.lock().map_err(error)?;
        if let Some((before, receipt)) = registry.requests.get(&request) {
            return if before == &signature {
                Ok(receipt.clone())
            } else {
                Err(invalid())
            };
        }
        registry
            .previews
            .retain(|_, p| p.created.elapsed().as_secs() < 900);
        if registry.previews.len() >= 2 {
            if let Some(id) = registry
                .previews
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(id, _)| id.clone())
            {
                registry.previews.remove(&id);
            }
        }
        if registry.requests.len() >= 128 {
            let operations = self.scans.operations.lock().map_err(error)?;
            registry.requests.retain(|_, (_, r)| {
                r["operationId"]
                    .as_str()
                    .is_some_and(|id| operations.contains_key(id))
            });
        }
        let (receipt, op) = self.begin_file_report(&request, "catalogueImport", 1, sink.clone())?;
        let dto = serde_json::to_value(&receipt).map_err(error)?;
        registry.requests.insert(request, (signature, dto.clone()));
        drop(registry);
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            store.import_worker(&op,&sink,|| {
                let staged=staging::prepare(&store,&path,&op.cancel)?;
                let preview_id=uuid::Uuid::new_v4().to_string();
                let plan=store.read_snapshot(|c| Ok(matching::plan_cancellable(c,&staged,&preview_id,&associations,&op.cancel)))??;
                let mut registry=store.backup_exports.lock().map_err(error)?;
                registry.previews.retain(|_,p|p.created.elapsed().as_secs()<900);
                if registry.previews.len()>=2 {
                    if let Some(id)=registry.previews.iter().min_by_key(|(_,p)|p.created).map(|(id,_)|id.clone()) {registry.previews.remove(&id);}
                }
                super::export::check(&op.cancel)?;
                // The operation carries only a summary. Detail is explicitly paginated.
                let summary=json!({"previewId":preview_id,"formatVersion":format::VERSION,"backupDigest":staged.digest,"expectedCatalogueRevision":plan.preview.expected_catalogue_revision,"counts":plan.preview.counts});
                registry.previews.insert(preview_id,Prepared {staged,plan,source:path,created:Instant::now(),associations});
                drop(registry);
                let revision=summary["expectedCatalogueRevision"].as_i64().unwrap();
                store.update_file_report(&op,&sink,|p|{p.result=Some(summary);p.record(String::new(),None,"unchanged",None);});
                Ok(revision)
            });
        });
        Ok(dto)
    }
    pub fn import_preview_page(&self, id: &str, offset: usize, limit: usize) -> Result<Value> {
        if limit == 0 || limit > 100 {
            return Err(invalid());
        }
        let registry = self.backup_exports.lock().map_err(error)?;
        let prepared = registry
            .previews
            .get(id)
            .filter(|p| p.created.elapsed().as_secs() < 900)
            .ok_or_else(expired)?;
        let p = &prepared.plan.preview;
        fn page<T: Serialize>(rows: &[T], offset: usize, limit: usize) -> Value {
            json!({"items":rows.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":rows.len()})
        }
        let forgotten = prepared
            .plan
            .forget_intents
            .iter()
            .map(|intent| intent.target.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        Ok(
            json!({"forgottenCount":forgotten,"previewId":p.preview_id,"formatVersion":p.format_version,"backupDigest":p.backup_digest,"expectedCatalogueRevision":p.expected_catalogue_revision,"counts":p.counts,"issues":p.issues,"offset":offset,"limit":limit,"additions":page(&p.additions,offset,limit),"changes":page(&p.changes,offset,limit),"conflicts":page(&p.conflicts,offset,limit),"unresolved":page(&p.unresolved,offset,limit)}),
        )
    }
    pub fn apply_catalogue_import(
        self: &Arc<Self>,
        args: ApplyImport,
        sink: scan::Sink,
    ) -> Result<Value> {
        request_valid(&args.request_id)?;
        let signature = serde_json::to_string(&args).map_err(error)?;
        let mut registry = self.backup_exports.lock().map_err(error)?;
        if let Some((before, receipt)) = registry.requests.get(&args.request_id) {
            return if before == &signature {
                Ok(receipt.clone())
            } else {
                Err(invalid())
            };
        }
        if registry.requests.len() >= 128 {
            let operations = self.scans.operations.lock().map_err(error)?;
            registry.requests.retain(|_, (_, r)| {
                r["operationId"]
                    .as_str()
                    .is_some_and(|id| operations.contains_key(id))
            });
        }
        let prepared = registry
            .previews
            .get(&args.preview_id)
            .filter(|p| p.created.elapsed().as_secs() < 900)
            .ok_or_else(expired)?;
        if prepared.plan.preview.expected_catalogue_revision != args.expected_catalogue_revision
            || self.list_sources()?.catalogue_revision != args.expected_catalogue_revision
        {
            return Err(revision_conflict());
        }
        if args.associations != prepared.associations {
            return Err(association_invalid());
        }
        let conflict_ids = prepared
            .plan
            .preview
            .conflicts
            .iter()
            .map(|c| &c.id)
            .collect::<std::collections::BTreeSet<_>>();
        if args.choices.iter().any(|(id, choice)| {
            !matches!(choice.as_str(), "local" | "incoming") || !conflict_ids.contains(id)
        }) {
            return Err(invalid());
        }
        let (receipt, op) =
            self.begin_file_report(&args.request_id, "catalogueImport", 1, sink.clone())?;
        let prepared = registry.previews.remove(&args.preview_id).unwrap();
        let dto = serde_json::to_value(&receipt).map_err(error)?;
        registry
            .requests
            .insert(args.request_id.clone(), (signature, dto.clone()));
        drop(registry);
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            store.import_worker(&op, &sink, || {
                if super::export::digest(&prepared.source, &op.cancel)
                    .map_err(|e| {
                        if op.cancel.load(Ordering::Relaxed) {
                            e
                        } else {
                            UserMessage::new(codes::CATALOG_IMPORT_SOURCE_CHANGED)
                                .with_detail(e.to_string())
                        }
                    })?
                    .sha256
                    != prepared.staged.digest
                {
                    return Err(UserMessage::new(codes::CATALOG_IMPORT_SOURCE_CHANGED));
                }
                let result = super::merge::apply(&store, &prepared, &args, &op)?;
                let revision = result["catalogueRevision"].as_i64().unwrap();
                store.update_file_report(&op, &sink, |p| {
                    p.result = Some(result);
                    p.record(String::new(), None, "updated", None);
                });
                Ok(revision)
            });
        });
        Ok(dto)
    }
    fn import_worker(
        &self,
        op: &Arc<scan::Operation>,
        sink: &scan::Sink,
        work: impl FnOnce() -> Result<i64>,
    ) {
        let (stop, receiver) = std::sync::mpsc::channel::<()>();
        let beat_op = Arc::clone(op);
        let beat_sink = Arc::clone(sink);
        let beat = std::thread::spawn(move || {
            while receiver.recv_timeout(Duration::from_millis(500))
                == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            {
                beat_op.emit(&beat_sink, false);
            }
        });
        self.update_file_report(op, sink, |p| {
            p.status = "running".into();
            p.phase = "preparation".into();
        });
        let result = (|| {
            let _heavy = self.scans.heavy.lock().map_err(error)?;
            super::export::check(&op.cancel)?;
            work()
        })();
        let _ = stop.send(());
        let _ = beat.join();
        let revision = result.as_ref().copied().unwrap_or_else(|_| {
            self.list_sources()
                .map(|s| s.catalogue_revision)
                .unwrap_or(0)
        });
        let cancelled = result.is_err() && op.cancel.load(Ordering::Relaxed);
        Store::finish_file_report(
            op,
            sink,
            result.map(|_| ()).map_err(|e| {
                if e.code == codes::CATALOG_STORE_ERROR {
                    UserMessage::new(codes::CATALOG_IMPORT_FAILED).with_detail(e.to_string())
                } else {
                    e
                }
            }),
            revision,
            cancelled,
        );
    }
}
