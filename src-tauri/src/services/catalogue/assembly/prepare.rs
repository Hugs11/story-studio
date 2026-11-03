use super::{failed, ownership::Preparation};
use crate::services::catalogue::{
    data::card,
    files, scan,
    store::{error, Store},
    writes, Result,
};
use crate::support::{
    paths::path_for_frontend,
    user_message::{codes, UserMessage},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub fiche_id: String,
    pub expected_fiche_revision: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub ordered_selection: Vec<Selection>,
    #[serde(default)]
    pub exemplar_choices: BTreeMap<String, String>,
    pub request_id: String,
}
fn changed() -> UserMessage {
    UserMessage::new(codes::CATALOG_ASSEMBLY_SOURCE_CHANGED)
}
fn check(cancel: &AtomicBool) -> Result<()> {
    files::assembly_check(cancel)
}
impl Store {
    pub fn prepare_assembly(self: &Arc<Self>, request: Request, sink: scan::Sink) -> Result<Value> {
        if request.ordered_selection.is_empty() {
            return Err(UserMessage::new(codes::CATALOG_ASSEMBLY_EMPTY));
        }
        let ids: HashSet<_> = request
            .ordered_selection
            .iter()
            .map(|s| &s.fiche_id)
            .collect();
        if ids.len() != request.ordered_selection.len()
            || ids.len() > 128
            || request.request_id.is_empty()
            || request.request_id.len() > 200
            || request.exemplar_choices.keys().any(|id| !ids.contains(id))
        {
            return Err(failed());
        }
        let signature = serde_json::to_string(&request).map_err(error)?;
        let mut registry = self.assemblies.lock().map_err(error)?;
        if let Some((before, receipt)) = registry.requests.get(&request.request_id) {
            return if before == &signature {
                Ok(receipt.clone())
            } else {
                Err(failed())
            };
        }
        if registry.requests.len() - registry.terminal_requests.len() >= 128 {
            return Err(failed());
        }
        let (receipt, operation) =
            self.begin_file_report(&request.request_id, "assembly", ids.len(), sink.clone())?;
        let dto = serde_json::to_value(&receipt).map_err(error)?;
        registry
            .requests
            .insert(request.request_id.clone(), (signature, dto.clone()));
        drop(registry);
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            let (stop, heartbeat) = std::sync::mpsc::channel::<()>();
            let op = Arc::clone(&operation);
            let beat_sink = Arc::clone(&sink);
            let beat = std::thread::spawn(move || {
                while heartbeat.recv_timeout(Duration::from_millis(500))
                    == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    op.emit(&beat_sink, false);
                }
            });
            let result = (|| {
                let _heavy = store.scans.heavy.lock().map_err(error)?;
                check(&operation.cancel)?;
                store.update_file_report(&operation, &sink, |p| p.status = "running".into());
                let result = store.assembly_inputs(&request, &operation.cancel, |id, reason| {
                    store.update_file_report(&operation, &sink, |p| {
                        p.record(
                            id.into(),
                            None,
                            if reason.is_some() {
                                "refused"
                            } else {
                                "unchanged"
                            },
                            reason,
                        )
                    });
                })?;
                let empty = result["entries"].as_array().is_none_or(Vec::is_empty);
                store.update_file_report(&operation, &sink, |p| p.result = Some(result));
                if empty {
                    Err(UserMessage::new(codes::CATALOG_ASSEMBLY_EMPTY))
                } else {
                    Ok(())
                }
            })();
            let _ = stop.send(());
            let _ = beat.join();
            let cancelled = operation.cancel.load(Ordering::Relaxed);
            Store::finish_file_report(
                &operation,
                &sink,
                result,
                receipt.catalogue_revision,
                cancelled,
            );
            if let Ok(mut registry) = store.assemblies.lock() {
                registry.complete_request(request.request_id);
            }
        });
        Ok(dto)
    }
    pub(crate) fn assembly_inputs(
        &self,
        request: &Request,
        cancel: &AtomicBool,
        progress: impl Fn(&str, Option<&str>),
    ) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let root = self.file_root().join("assembly").join(&id);
        let revision = self.list_sources()?.catalogue_revision;
        let own =
            writes::OwnWrite::begin(writes::Declaration::new("catalogueAssembly").temporary(&root));
        std::fs::create_dir_all(&root).map_err(error)?;
        let result = (|| {
            let mut entries = Vec::new();
            let mut excluded = Vec::new();
            let mut ages = Vec::new();
            let mut proofs = Vec::new();
            let mut selected_state = Vec::new();
            // Capture the selected identities before materializing any input.
            let details = self.read_snapshot(|c| {
                request
                    .ordered_selection
                    .iter()
                    .map(|s| {
                        let Some(detail) = card::snapshot(c, &s.fiche_id)? else {
                            return Ok(None);
                        };
                        let names = selection_names(&detail);
                        let resolved = card::resolution(c, &s.fiche_id, &names)?;
                        let sha = retained_cover(c, &s.fiche_id, &resolved)?;
                        Ok(Some((detail, resolved, sha)))
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?;
            for (index, (selection, detail)) in
                request.ordered_selection.iter().zip(details).enumerate()
            {
                check(cancel)?;
                let (detail, resolved, sha) = detail.ok_or_else(changed)?;
                selected_state.push((
                    selection.fiche_id.clone(),
                    detail["ficheRevision"].clone(),
                    detail["reference"].clone(),
                    assembly_values(&resolved),
                    sha.clone(),
                ));
                if detail["ficheRevision"].as_i64() != Some(selection.expected_fiche_revision) {
                    return Err(changed());
                }
                let candidates = detail["exemplars"].as_array().ok_or_else(failed)?;
                let usable = |e: &&Value| {
                    e["state"] == "available"
                        && e["availability"] != "unavailable"
                        && matches!(
                            e["format"].as_str(),
                            Some("zip" | "7z" | "studioDirectory" | "fsDirectory")
                        )
                };
                // A compatible ZIP always wins over a conversion.
                let selected = candidates
                    .iter()
                    .filter(usable)
                    .find(|e| e["format"] == "zip")
                    .or_else(|| {
                        request
                            .exemplar_choices
                            .get(&selection.fiche_id)
                            .and_then(|chosen| {
                                candidates
                                    .iter()
                                    .filter(usable)
                                    .find(|e| e["id"].as_str() == Some(chosen))
                            })
                    })
                    .or_else(|| candidates.iter().find(usable));
                let Some(exemplar) = selected else {
                    let reason = if candidates.iter().any(|e| e["format"] == "project") {
                        "generateFirst"
                    } else {
                        "assemblyUnavailable"
                    };
                    excluded.push(json!({"ficheId":selection.fiche_id,"reason":reason}));
                    progress(&selection.fiche_id, Some(reason));
                    continue;
                };
                let eid = exemplar["id"].as_str().ok_or_else(failed)?;
                let target = self.assembly_target(eid).map_err(|_| changed())?;
                self.require_active_source(&target.path)?;
                target
                    .require_unchanged(Duration::from_secs(2))
                    .map_err(|_| changed())?;
                files::assembly_identity(self, eid, &target.path)?;
                let before = files::assembly_snapshot(&target.path, cancel)?;
                let observed = target.observation.as_ref().ok_or_else(changed)?;
                let chain = observed.raw["chain"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let zip = root.join(format!("{index}.zip"));
                files::assembly_convert(
                    self,
                    &target.path,
                    &observed.format,
                    &chain,
                    &zip,
                    cancel,
                )?;
                files::assembly_unchanged(&target.path, &before, cancel).map_err(|_| changed())?;
                target
                    .require_unchanged(Duration::from_secs(2))
                    .map_err(|_| changed())?;
                files::assembly_identity(self, eid, &target.path)?;
                self.assembly_target(eid).map_err(|_| changed())?;
                let title = resolved
                    .values
                    .get("title")
                    .cloned()
                    .or_else(|| {
                        resolved
                            .fields
                            .iter()
                            .find(|f| f.field == "title" && f.language.is_empty())
                            .and_then(|f| f.derived.as_ref())
                            .map(|v| v["value"].clone())
                    })
                    .unwrap_or(Value::Null);
                let mut cover = None;
                if let Some(value) = resolved.values.get("cover") {
                    let sha = sha.as_deref();
                    if let Some(sha) =
                        sha.filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
                    {
                        let path = root.join(format!("{index}.jpg"));
                        std::fs::copy(self.images_root().join(sha), &path).map_err(error)?;
                        cover = Some(path_for_frontend(&path));
                    } else if value["kind"] == "lunii" {
                        let bytes = self.lunii_cover_bytes_cancel(
                            &selection.fiche_id,
                            value["key"].as_str().ok_or_else(failed)?,
                            cancel,
                        )?;
                        check(cancel)?;
                        let path = root.join(format!("{index}.jpg"));
                        std::fs::write(&path, bytes).map_err(error)?;
                        cover = Some(path_for_frontend(&path));
                    } else {
                        let reference = self
                            .read_snapshot(|c| {
                                crate::services::catalogue::data::card::cover_exemplar(
                                    c,
                                    &selection.fiche_id,
                                )
                            })?
                            .ok_or_else(changed)?;
                        let source = self.assembly_target(&reference).map_err(|_| changed())?;
                        self.require_active_source(&source.path)?;
                        source
                            .require_unchanged(Duration::from_secs(2))
                            .map_err(|_| changed())?;
                        let proof = files::assembly_snapshot(&source.path, cancel)?;
                        let observation = &source.observation.as_ref().ok_or_else(changed)?.raw;
                        // Durable values are never interpreted as arbitrary file locators.
                        // The observed supplying exemplar must still own this cover.
                        if observation["cover"] == *value {
                            let allowed = if observation["cover"]["kind"] == "archiveEntry"
                                || source
                                    .observation
                                    .as_ref()
                                    .is_some_and(|o| o.format == "project")
                            {
                                true
                            } else {
                                observation["cover"]["path"]
                                    .as_str()
                                    .or_else(|| observation["cover"].as_str())
                                    .and_then(|p| std::fs::canonicalize(p).ok())
                                    .zip(std::fs::canonicalize(&source.path).ok())
                                    .is_some_and(|(cover, root)| cover.starts_with(root))
                            };
                            if allowed {
                                if let Ok(bytes) = crate::services::catalogue::analyze::read_cover(
                                    &json!({"path":path_for_frontend(&source.path)}),
                                    observation,
                                    10 * 1024 * 1024,
                                ) {
                                    if let Ok((bytes, _, _)) =
                                        crate::services::catalogue::data::images::normalized_cover(
                                            &bytes,
                                        )
                                    {
                                        let path = root.join(format!("{index}.jpg"));
                                        std::fs::write(&path, bytes).map_err(error)?;
                                        cover = Some(path_for_frontend(&path));
                                    }
                                }
                            }
                        }
                        files::assembly_unchanged(&source.path, &proof, cancel)
                            .map_err(|_| changed())?;
                        proofs.push((source.path.clone(), proof, reference.to_owned()));
                    }
                }
                if let Some(age) = resolved.values.get("ageMin").and_then(Value::as_u64) {
                    ages.push(age);
                }
                let pack_uuid = crate::services::pack_reader::read_pack_uuid(&zip)
                    .map_err(UserMessage::from)?;
                let official_provenance =
                    crate::domain::official_provenance::imported_provenance_with_catalogue(
                        &pack_uuid,
                        Some(self),
                    );
                entries.push(json!({"ficheId":selection.fiche_id,"exemplarId":eid,"expectedRevision":revision,"zipPath":path_for_frontend(&zip),"packUuid":pack_uuid,"officialProvenance":official_provenance,"officialOriginUuid":(official_provenance == crate::domain::official_provenance::OfficialProvenance::Official).then_some(&pack_uuid),"title":title.as_str().unwrap_or(""),"coverPath":cover,"ageMin":resolved.values.get("ageMin").cloned().unwrap_or(Value::Null),"provenance":detail["fields"],"temporary":true}));
                proofs.push((target.path.clone(), before, eid.to_owned()));
                progress(&selection.fiche_id, None);
            }
            check(cancel)?;
            self.read_snapshot(|c| {
                for (id, revision, reference, values, sha) in &selected_state {
                    let detail =
                        card::snapshot(c, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                    let names = selection_names(&detail);
                    let resolved = card::resolution(c, id, &names)?;
                    if detail["ficheRevision"] != *revision
                        || detail["reference"] != *reference
                        || assembly_values(&resolved) != *values
                        || retained_cover(c, id, &resolved)? != *sha
                    {
                        return Err(rusqlite::Error::QueryReturnedNoRows);
                    }
                }
                Ok(())
            })
            .map_err(|_| changed())?;
            for (path, proof, eid) in &proofs {
                files::assembly_unchanged(path, proof, cancel).map_err(|_| changed())?;
                files::assembly_identity(self, eid, path)?;
            }
            let result = json!({"preparationId":id,"catalogueRevision":revision,"entries":entries,"excluded":excluded,"suggestedAgeMin":ages.into_iter().max(),"ownership":"assistant"});
            self.assemblies.lock().map_err(error)?.preparations.insert(
                id.clone(),
                Preparation {
                    root: root.clone(),
                    readers: 0,
                    release_requested: false,
                },
            );
            Ok(result)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&root);
        }
        own.finish(&result, |_| vec![root]);
        result
    }
    fn assembly_target(
        &self,
        id: &str,
    ) -> Result<crate::services::catalogue::open::target::Target> {
        use crate::services::catalogue::open::target::{Observed, Target};
        self.read_snapshot(|c| {
            c.query_row("SELECT e.anchor_json,o.format,o.state,o.content_token,o.raw_observation_json FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.id=?1 AND e.retired=0",[id],|r| {
                let anchor:Value=serde_json::from_str(&r.get::<_,String>(0)?).unwrap_or(Value::Null);
                let raw:Value=serde_json::from_str(&r.get::<_,String>(4)?).unwrap_or(Value::Null);
                Ok(Target {path: std::path::PathBuf::from(anchor["path"].as_str().unwrap_or_default()),observation:Some(Observed {format:r.get(1)?,state:r.get(2)?,token:r.get(3)?,raw})})
            })
        }).map_err(|_|changed())
    }
    pub fn retain_assembly_task(&self, id: &str) -> Result<String> {
        self.assemblies.lock().map_err(error)?.retain_task(id)
    }
    pub fn finish_assembly_task(&self, token: &str) -> Result<()> {
        self.assemblies.lock().map_err(error)?.finish_task(token)?;
        Ok(())
    }
    pub fn release_assembly(&self, id: &str) -> Result<Value> {
        Ok(json!({"released":self.assemblies.lock().map_err(error)?.release(id)?}))
    }
}

// The official key identifies the image before and after local retention.
// Its optional local digest is materialization state, not an authored value.
fn assembly_values(
    resolved: &crate::services::catalogue::data::resolver::Resolution,
) -> serde_json::Map<String, Value> {
    let mut values = resolved.values.clone();
    if resolved
        .fields
        .iter()
        .any(|f| f.field == "cover" && f.language.is_empty() && f.effective["origin"] == "lunii")
    {
        if let Some(cover) = values.get_mut("cover").and_then(Value::as_object_mut) {
            cover.remove("sha256");
        }
    }
    values
}

fn retained_cover(
    c: &rusqlite::Connection,
    id: &str,
    resolved: &crate::services::catalogue::data::resolver::Resolution,
) -> rusqlite::Result<Option<String>> {
    // Cover is an unqualified field. Never read a retained reference asset when
    // the resolver selected an official cover, a correction or a cleared value.
    let Some(field) = resolved
        .fields
        .iter()
        .find(|f| f.field == "cover" && f.language.is_empty())
    else {
        return Ok(None);
    };
    if resolved.values.get("cover") != Some(&field.effective["value"]) {
        return Ok(None);
    }
    if field.effective["value"]["kind"] == "lunii" {
        return Ok(None);
    }
    let row: Option<(String,Option<String>)>=match field.effective["origin"].as_str() {
        Some("correction") => c.query_row(
            "SELECT value_json,image_sha256 FROM correction WHERE fiche_id=?1 AND field='cover' AND language=(SELECT language FROM correction WHERE fiche_id=?1 AND field='cover' AND state IN ('defined','cleared') ORDER BY language='' DESC,language LIMIT 1) AND state='defined'",
            [id],|r|Ok((r.get(0)?,r.get(1)?)),
        ).optional()?,
        Some("reference") => {
            let provenance=field.reference_value.as_ref().and_then(|v|v["provenanceId"].as_str());
            c.query_row(
                "SELECT value_json,image_sha256 FROM reference_value WHERE fiche_id=?1 AND field='cover' AND language=?2 AND provenance_id=?3",
                rusqlite::params![id,field.language,provenance],|r|Ok((r.get(0)?,r.get(1)?)),
            ).optional()?
        }
        _ => None,
    };
    Ok(row.and_then(|(raw, sha)| {
        (serde_json::from_str::<Value>(&raw).ok().as_ref() == Some(&field.effective["value"]))
            .then_some(sha)
            .flatten()
    }))
}

fn selection_names(detail: &Value) -> Vec<String> {
    detail["exemplars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["state"] != "missing")
        .filter_map(|e| e["member"].as_str().or_else(|| e["path"].as_str()))
        .map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p).to_owned())
        .collect()
}
