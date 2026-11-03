//! Revalidated descriptions of editor targets. No project/session is opened here.
use super::target::{self, Target};
use crate::services::catalogue::{analyze, store::Store, Result};
use crate::support::{
    imported_pack,
    paths::path_for_frontend,
    user_message::{codes, UserMessage},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditorEntry {
    #[serde(rename_all = "camelCase")]
    Project {
        path: String,
        project_kind: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Pack {
        path: String,
        pack_label: String,
        format: String,
        existing_project: Option<Value>,
    },
    #[serde(rename_all = "camelCase")]
    BundleChild {
        container_path: String,
        container_fingerprint: String,
        child_id: String,
        pack_label: String,
        existing_project: Option<Value>,
    },
}
fn failed(path: &Path, detail: impl ToString) -> UserMessage {
    UserMessage::new(codes::CATALOG_PACK_READ_FAILED)
        .param("path", path_for_frontend(path))
        .with_detail(detail.to_string())
}
fn unsupported(path: &Path) -> UserMessage {
    UserMessage::new(codes::CATALOG_EDITOR_UNSUPPORTED).param("path", path_for_frontend(path))
}

impl Store {
    pub fn prepare_editor_entry(
        &self,
        exemplar: &str,
        revision: i64,
        purpose: &str,
    ) -> Result<EditorEntry> {
        let target = self.resolve_target(exemplar, revision)?;
        self.require_active_source(&target.path)?;
        target.require_unchanged(Duration::from_secs(2))?;
        let observed = target.observation.as_ref().expect("validated observation");
        if !["edit", "editAndGenerate"].contains(&purpose) || observed.state != "available" {
            return Err(unsupported(&target.path));
        }
        let path = target.display_path();
        if observed.format == "project" {
            let raw = analyze::project(&target.path)
                .map_err(|e| failed(&target.path, e))?
                .raw;
            let project_kind = raw
                .get("projectType")
                .and_then(Value::as_str)
                .map(str::to_owned);
            target.require_unchanged(Duration::from_secs(2))?;
            self.resolve_target(exemplar, revision)?;
            return Ok(EditorEntry::Project { path, project_kind });
        }
        if !["zip", "7z", "studioDirectory", "fsDirectory", "fsZip"]
            .contains(&observed.format.as_str())
        {
            return Err(unsupported(&target.path));
        }
        let existing_project = self.read_snapshot(|c| {
            let mut statement = c.prepare("SELECT e.id,e.anchor_json,o.modified_at FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.fiche_id=(SELECT fiche_id FROM exemplar WHERE id=?1) AND e.retired=0 AND o.format='project' AND o.state='available' AND EXISTS(SELECT 1 FROM cache.coverage cv JOIN source s ON s.id=cv.source_id WHERE cv.exemplar_id=e.id AND s.status='active') ORDER BY o.modified_at DESC,e.id")?;
            let rows = statement.query_map([exemplar], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, Option<i64>>(2)?)))?;
            for row in rows {
                let (id, anchor, modified) = row?;
                let anchor: Value = serde_json::from_str(&anchor).unwrap_or(Value::Null);
                if let Some(path) = anchor["path"].as_str().filter(|p| Path::new(p).is_file()) {
                    return Ok(Some(json!({"exemplarId":id,"path":path,"modifiedAt":modified})));
                }
            }
            Ok(None)
        })?;
        let label = observed.raw["title"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                target
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let member = observed.raw["chain"]
            .as_array()
            .is_some_and(|v| !v.is_empty());
        let result = if member {
            let fingerprint = imported_pack::bundle_container_fingerprint(&path)
                .map_err(|e| failed(&target.path, e))?;
            let inventory = analyze::analyze(&target.path, &AtomicBool::new(false))
                .map_err(|e| failed(&target.path, e))?;
            let selected = inventory
                .iter()
                .find(|entry| {
                    serde_json::to_value(&entry.chain).ok().as_ref() == Some(&observed.raw["chain"])
                })
                .ok_or_else(|| target::changed(&path))?;
            let child_id = format!(
                "catalogue:{}",
                selected
                    .member_key()
                    .ok_or_else(|| unsupported(&target.path))?
            );
            if imported_pack::bundle_container_fingerprint(&path)
                .map_err(|e| failed(&target.path, e))?
                != fingerprint
            {
                return Err(target::changed(&path));
            }
            EditorEntry::BundleChild {
                container_path: path,
                container_fingerprint: fingerprint,
                child_id,
                pack_label: selected.title.clone().unwrap_or(label),
                existing_project,
            }
        } else {
            EditorEntry::Pack {
                path,
                pack_label: label,
                format: observed.format.clone(),
                existing_project,
            }
        };
        target.require_unchanged(Duration::from_secs(2))?;
        // The expensive fresh inventory must not mask a concurrent rescan.
        self.resolve_target(exemplar, revision)?;
        Ok(result)
    }
}

/// Catalogue child IDs refer to the fresh analyzer inventory, including pack
/// directories inside archives. The regular import inventory stays unchanged.
/// Called by the existing extraction command, never with a retained cache path.
pub fn extract_child(
    path: &str,
    fingerprint: &str,
    child_id: &str,
    registry: &std::sync::Arc<super::editor_extractions::Registry>,
    owner: &str,
    catalogue: Option<&dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>>,
) -> Result<String> {
    let path_ref = Path::new(path);
    if imported_pack::bundle_container_fingerprint(path).map_err(|e| failed(path_ref, e))?
        != fingerprint
    {
        return Err(target::changed(path));
    }
    let inventory =
        analyze::analyze(path_ref, &AtomicBool::new(false)).map_err(|e| failed(path_ref, e))?;
    let key = child_id
        .strip_prefix("catalogue:")
        .ok_or_else(|| unsupported(path_ref))?;
    let entry = inventory
        .into_iter()
        .find(|entry| entry.member_key().as_deref() == Some(key))
        .ok_or_else(|| target::changed(path))?;
    let mut lease = registry.acquire(owner)?;
    let target = Target {
        path: path_ref.to_owned(),
        observation: Some(super::target::Observed {
            format: entry.format.clone(),
            state: entry.state.clone(),
            token: String::new(),
            raw: serde_json::to_value(entry).map_err(|e| failed(path_ref, e))?,
        }),
    };
    (|| {
        let output = super::materialize::pack_zip(
            &target,
            lease.path(),
            &AtomicBool::new(false),
            catalogue,
        )?;
        if imported_pack::bundle_container_fingerprint(path).map_err(|e| failed(path_ref, e))?
            != fingerprint
        {
            return Err(target::changed(path));
        }
        lease.publish()?;
        Ok(path_for_frontend(&output))
    })()
}
