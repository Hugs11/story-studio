//! Removal plans retain exact identity evidence. Native unavailability is the
//! only route to a separate plan requiring two ordered confirmation receipts.
use super::{
    fail,
    models::*,
    patch, plan,
    trash_native::{self, Outcome},
    Result,
};
use crate::{
    services::catalogue::{
        store::{error, Store},
        writes,
    },
    support::user_message::codes,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
#[cfg(test)]
type AfterNativeHook = Box<dyn FnMut(&Path)>;
#[cfg(test)]
thread_local! {
    pub(super) static RECOVERY_AFTER_RECONCILE_HOOK: std::cell::RefCell<Option<AfterNativeHook>> = const { std::cell::RefCell::new(None) };
    pub(super) static RECOVERY_RECONCILE_HOOK: std::cell::RefCell<Option<AfterNativeHook>> = const { std::cell::RefCell::new(None) };
    pub(super) static FAIL_DETACH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static FAIL_AFTER_DETACH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static FAIL_DETACH_PROOF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static DETACHED_HOOK: std::cell::RefCell<Option<AfterNativeHook>> = const { std::cell::RefCell::new(None) };
    pub(super) static AFTER_DETACH_HOOK: std::cell::RefCell<Option<AfterNativeHook>> = const { std::cell::RefCell::new(None) };
    pub(super) static AFTER_NATIVE_HOOK: std::cell::RefCell<Option<AfterNativeHook>> = const { std::cell::RefCell::new(None) };
}
#[derive(Clone)]
pub(crate) struct RemovalState {
    unavailable: bool,
    attempted: bool,
    confirmations: Vec<String>,
    parent_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalConfirmation {
    pub plan_id: String,
    pub target_token: String,
    pub stage: String,
    pub token: String,
}
fn forbidden() -> crate::support::user_message::UserMessage {
    fail(codes::CATALOG_DELETE_TARGET_FORBIDDEN)
}
fn required() -> crate::support::user_message::UserMessage {
    fail(codes::CATALOG_DELETE_CONFIRMATION_REQUIRED)
}
fn validate_tree(path: &Path, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err(forbidden());
    }
    let m = patch::regular(path).map_err(|_| forbidden())?;
    if path
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("mbah"))
    {
        return Err(forbidden());
    }
    if m.is_dir() {
        for item in std::fs::read_dir(path).map_err(super::io_error)? {
            validate_tree(&item.map_err(super::io_error)?.path(), depth + 1)?;
        }
    }
    Ok(())
}
// A missing child proves nothing if its parent was replaced or disconnected.
pub(super) fn absence_confirmed(path: &Path, parent_id: Option<&str>) -> bool {
    let Some((parent, expected)) = path.parent().zip(parent_id) else {
        return false;
    };
    matches!(std::fs::symlink_metadata(path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        && writes::file_id(parent).as_deref() == Some(expected)
}
/// Catalogue evidence for the list, the fiche and destructive revalidation;
/// no file is read. Counts active exemplars of the same archive across ALL
/// cards, including stale/offline observations. The real pack count of the
/// archive is established by `require_sole_pack` (plan) and
/// `inspect_archive_removals` (opened fiche), never here.
pub(crate) fn archive_removal(c: &rusqlite::Connection, id: &str) -> rusqlite::Result<Value> {
    // Both terms of the OR are indexed (exemplar_container, exemplar_anchor_path);
    // `pathKey` always accompanies `path` in an anchor.
    let (member, path, state, count, present): (Option<String>, Option<String>, Option<String>, i64, bool) = c.query_row(
        "SELECT json_extract(e.anchor_json,'$.member'),json_extract(e.anchor_json,'$.path'),o.state,
         (SELECT count(*) FROM exemplar other WHERE other.retired=0 AND
           (other.container_id=e.container_id
            OR json_extract(other.anchor_json,'$.pathKey')=json_extract(e.anchor_json,'$.pathKey'))),
         e.retired=0 AND EXISTS(SELECT 1 FROM container k WHERE k.id=e.container_id AND k.retired=0 AND json_extract(k.anchor_json,'$.pathKey')=json_extract(e.anchor_json,'$.pathKey')) AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id
           LEFT JOIN source_health h ON h.source_id=s.id WHERE v.exemplar_id=e.id
           AND s.status='active' AND coalesce(h.availability,'available')!='unavailable')
         FROM exemplar e LEFT JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.id=?1",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get::<_,Option<bool>>(4)?.unwrap_or(false))))?;
    if member.is_none() {
        return Ok(json!({"enabled":true,"reason":null,"packCount":count}));
    }
    let reason = if path
        .as_deref()
        .is_none_or(|p| archive_extension(Path::new(p)).is_none())
    {
        // A member of a container that is not an archive file of the source.
        Some("notArchive")
    } else if !present
        || matches!(
            state.as_deref(),
            None | Some("missing" | "unavailable" | "fileDisappeared")
        )
    {
        Some("unavailable")
    } else if state.as_deref() != Some("available") {
        Some("unreadable")
    } else if count != 1 {
        Some("shared")
    } else {
        None
    };
    Ok(json!({"enabled":reason.is_none(),"reason":reason,"packCount":count}))
}
fn archive_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|s| matches!(s.as_str(), "zip" | "7z"))
}
/// Fingerprinted real pack counts (`None`: the archive could not be inspected).
pub(crate) type PackCounts =
    std::sync::Mutex<std::collections::HashMap<PathBuf, (String, Option<usize>)>>;
fn fingerprint(path: &Path) -> Option<String> {
    let m = patch::regular(path).ok().filter(|m| m.is_file())?;
    Some(format!(
        "{}:{:?}:{:?}",
        m.len(),
        m.modified().ok(),
        writes::file_id(path)
    ))
}
/// The archive must hold exactly one real pack; an inventory that cannot be
/// established is refused, never read as "no other pack".
fn require_sole_pack(path: &Path, cancel: &AtomicBool) -> Result<()> {
    match super::super::analyze::archive_pack_count(path, cancel) {
        Ok(1) => Ok(()),
        Ok(n) if n > 1 => Err(fail(codes::CATALOG_TRASH_ARCHIVE_MULTIPLE).param("count", n)),
        Err(reason) if reason == "cancelled" => {
            patch::check(cancel)?;
            Err(fail(codes::CATALOG_TRASH_ARCHIVE_UNINSPECTABLE))
        }
        _ => Err(fail(codes::CATALOG_TRASH_ARCHIVE_UNINSPECTABLE)),
    }
}
impl Store {
    fn removal_target(&self, t: &PlannedTarget, cancel: &AtomicBool) -> Result<()> {
        let path = Path::new(&t.source_path);
        if !matches!(
            t.source_format.as_str(),
            "zip" | "7z" | "studioDirectory" | "fsDirectory" | "fsZip" | "project"
        ) {
            return Err(forbidden());
        }
        self.require_no_recovery(path)?;
        for ancestor in crate::support::paths::filesystem_ancestors(path) {
            patch::regular(ancestor).map_err(|_| forbidden())?;
        }
        for source in self.all_sources()?.items {
            if super::super::path_identity::contains(path, &source.native_path)
                || super::super::path_identity::contains(path, &source.resolved_path)
            {
                return Err(forbidden());
            }
        }
        if !self.all_sources()?.items.iter().any(|s| {
            s.status == "active"
                && (super::super::path_identity::contains(&s.native_path, path)
                    || super::super::path_identity::contains(&s.resolved_path, path))
        }) {
            return Err(forbidden());
        }
        let availability = self.read(|c| archive_removal(c, &t.exemplar_id))?;
        if !t.member_chain.is_empty() && availability["reason"] == "shared" {
            return Err(fail(codes::CATALOG_TRASH_ARCHIVE_SHARED));
        }
        if !t.member_chain.is_empty() && availability["enabled"] != true {
            return Err(forbidden());
        }
        let target = self.resolve_target(&t.exemplar_id, t.expected_revision)?;
        let card = self.get_card(&t.fiche_id)?;
        if super::super::path_identity::key(&target.path) != super::super::path_identity::key(path)
            || !card["exemplars"].as_array().is_some_and(|es| {
                es.iter().any(|e| {
                    e["id"] == t.exemplar_id && (e["member"].is_null() == t.member_chain.is_empty())
                })
            })
        {
            return Err(forbidden());
        }
        let obs = target.observation.ok_or_else(forbidden)?;
        if obs.state != "available"
            || (t.member_chain.is_empty() && obs.format != t.source_format)
            || obs.raw["chain"].as_array().cloned().unwrap_or_default() != t.member_chain
            || (!t.member_chain.is_empty()
                && (!patch::regular(path)?.is_file()
                    || !matches!(t.source_format.as_str(), "zip" | "7z" | "fsZip")))
        {
            return Err(forbidden());
        }
        patch::check(cancel)?;
        if t.source_format == "project" {
            self.require_project_idle(path)?;
            if !patch::regular(path)?.is_file() {
                return Err(forbidden());
            }
        } else {
            validate_tree(path, 0)?;
        }
        Ok(())
    }
    pub(super) fn plan_trash(
        &self,
        targets: Vec<TargetRequest>,
        options: Options,
    ) -> Result<FilePlan> {
        if targets.len() != 1
            || options.mode != "replace"
            || !options.correction_resolutions.is_empty()
        {
            return Err(forbidden());
        }
        let request = &targets[0];
        let resolved = self.resolve_target(&request.exemplar_id, request.expected_revision)?;
        let obs = resolved.observation.clone().ok_or_else(forbidden)?;
        let mut t: PlannedTarget = serde_json::from_value(json!({
            "ficheId":request.fiche_id,"exemplarId":request.exemplar_id,"expectedRevision":request.expected_revision,
            "sourcePath":crate::support::paths::path_for_frontend(&resolved.path),"sourceFormat":obs.format,
            "memberChain":obs.raw["chain"].as_array().cloned().unwrap_or_default(),
            "sourceToken":"","destinationPath":crate::support::paths::path_for_frontend(&resolved.path),"destinationToken":null,
            "mode":"replace","changes":[],"proposedName":"","renameDefaultChecked":false,"conflicts":[],
            "capability":{"state":"available","reason":null}
        })).map_err(error)?;
        let cancel = AtomicBool::new(false);
        if !t.member_chain.is_empty() {
            // The target is the archive file of the source, whatever the depth
            // of the member inside it; never an inner archive or a parent.
            t.source_format = archive_extension(&resolved.path).ok_or_else(forbidden)?;
        }
        self.removal_target(&t, &cancel)?;
        resolved
            .require_unchanged(Duration::from_secs(2))
            .map_err(|_| fail(codes::CATALOG_FILE_SOURCE_CHANGED))?;

        let snap = patch::snapshot(&resolved.path, &cancel)?;
        if archive_extension(&resolved.path).is_some() && patch::regular(&resolved.path)?.is_file()
        {
            // Any archive file, member or direct pack: the analyzers may index
            // fewer packs than it holds. Counted between two identical
            // snapshots; execution compares the same snapshot, so the count
            // holds until the archive is removed.
            require_sole_pack(&resolved.path, &cancel)?;
            patch::unchanged(&resolved.path, &snap, &cancel)?;
        }
        t.source_token = patch::token(&snap);
        // Refuse a replaced indexed target even when the bytes are identical.
        let indexed: Option<String> = self.read(|c| {
            c.query_row(
                "SELECT file_id FROM exemplar_file_state WHERE exemplar_id=?1",
                [&t.exemplar_id],
                |r| r.get(0),
            )
        })?;
        if indexed.is_none() || indexed != writes::file_id(&resolved.path) {
            return Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED));
        }
        let parent_id =
            writes::file_id(resolved.path.parent().ok_or_else(forbidden)?).ok_or_else(forbidden)?;
        let dto = FilePlan {
            plan_id: uuid::Uuid::new_v4().to_string(),
            catalogue_revision: request.expected_revision,
            expires_at: plan::stamp() + 600,
            action: "trash".into(),
            targets: vec![t],
            total_bytes: snap.bytes,
            required_free_bytes: 0,
            issues: vec![],
        };
        let mut plans = self.file_plans.lock().map_err(error)?;
        plans.retain(|_, p| p.dto.expires_at > plan::stamp());
        if plans.len() >= 32 {
            return Err(fail(codes::CATALOG_FILE_PLAN_EXPIRED));
        }
        let unavailable = plans.values().any(|p| {
            p.dto.expires_at > plan::stamp()
                && p.removal.is_some()
                && !p.dto.targets.is_empty()
                && p.dto.targets[0].source_token == dto.targets[0].source_token
                && p.dto.targets[0].exemplar_id == dto.targets[0].exemplar_id
                && p.removal.as_ref().is_some_and(|r| {
                    r.unavailable && (r.attempted || p.dto.action == "deletePermanently")
                })
        });
        plans.insert(
            dto.plan_id.clone(),
            StoredPlan {
                identities_survive_moves: vec![],
                dto: dto.clone(),
                snapshots: vec![snap],
                removal: Some(RemovalState {
                    unavailable,
                    attempted: unavailable,
                    confirmations: vec![],
                    parent_id,
                }),
            },
        );
        Ok(dto)
    }
    /// Opened fiche only: an archive file (direct pack, or member the
    /// catalogue allows) is checked against the packs it really holds. The
    /// verdict is display; the plan recounts.
    pub fn inspect_archive_removals(&self, card: &mut Value) -> Result<()> {
        let Some(exemplars) = card["exemplars"].as_array_mut() else {
            return Ok(());
        };
        for e in exemplars {
            let member = !e["member"].is_null();
            if member && e["archiveRemoval"]["enabled"] != true {
                continue;
            }
            let Some(path) = e["path"]
                .as_str()
                .map(PathBuf::from)
                .filter(|p| archive_extension(p).is_some())
            else {
                continue;
            };
            if !member && (e["state"] != "available" || e["availability"] == "unavailable") {
                continue;
            }
            let key = fingerprint(&path);
            let cached = key.as_ref().and_then(|key| {
                self.archive_pack_counts
                    .lock()
                    .ok()?
                    .get(&path)
                    .filter(|(k, _)| k == key)
                    .map(|(_, count)| *count)
            });
            let count = match cached {
                Some(count) => count,
                None => {
                    let count = key.as_ref().and_then(|_| {
                        super::super::analyze::archive_pack_count(&path, &AtomicBool::new(false))
                            .ok()
                    });
                    if let Some(key) = key {
                        let mut counts = self.archive_pack_counts.lock().map_err(error)?;
                        if counts.len() >= 256 {
                            counts.clear();
                        }
                        counts.insert(path, (key, count));
                    }
                    count
                }
            };
            e["archiveRemoval"] = match count {
                // A direct pack keeps the ordinary trash rules.
                Some(1) if !member => Value::Null,
                Some(1) => json!({"enabled":true,"reason":null,"packCount":1}),
                Some(n) if n > 1 => json!({"enabled":false,"reason":"multiple","packCount":n}),
                _ => json!({"enabled":false,"reason":"uninspectable","packCount":null}),
            };
        }
        Ok(())
    }
    pub(super) fn require_unshared_archive(&self, p: &StoredPlan) -> Result<()> {
        let t = &p.dto.targets[0];
        if t.member_chain.is_empty() {
            return Ok(());
        }
        match self.read(|c| archive_removal(c, &t.exemplar_id))?["packCount"].as_i64() {
            Some(1) => Ok(()),
            // The exemplar itself was retired between plan and execution.
            Some(0) => Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED)),
            _ => Err(fail(codes::CATALOG_TRASH_ARCHIVE_SHARED)),
        }
    }
    fn revalidate_removal(&self, p: &StoredPlan, cancel: &AtomicBool) -> Result<()> {
        if p.dto.expires_at <= plan::stamp() {
            return Err(fail(codes::CATALOG_FILE_PLAN_EXPIRED));
        }
        self.require_unshared_archive(p)?;
        if self.list_sources()?.catalogue_revision != p.dto.catalogue_revision {
            return Err(fail(codes::CATALOG_REVISION_CONFLICT));
        }
        let t = &p.dto.targets[0];
        self.removal_target(t, cancel)?;
        let path = Path::new(&t.source_path);
        if writes::file_id(path.parent().ok_or_else(forbidden)?).as_ref()
            != p.removal.as_ref().map(|s| &s.parent_id)
        {
            return Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED));
        }
        patch::unchanged(path, &p.snapshots[0], cancel)
    }
    pub fn prepare_permanent_delete(&self, trash_plan_id: &str) -> Result<FilePlan> {
        let mut p = self
            .file_plans
            .lock()
            .map_err(error)?
            .get(trash_plan_id)
            .cloned()
            .ok_or_else(required)?;
        let state = p.removal.as_ref().ok_or_else(required)?;
        if p.dto.action != "trash" || !state.unavailable || !state.attempted {
            return Err(required());
        }
        self.revalidate_removal(&p, &AtomicBool::new(false))?;
        // Non-exclusive, so deletion stays available on SMB/FUSE. A failed
        // probe keeps the strict identity proof (never refuses the deletion).
        let parent = Path::new(&p.dto.targets[0].source_path)
            .parent()
            .ok_or_else(forbidden)?;
        p.identities_survive_moves = vec![super::publish::probe(parent, false).unwrap_or(true)];
        p.dto.plan_id = uuid::Uuid::new_v4().to_string();
        p.dto.action = "deletePermanently".into();
        p.removal.as_mut().unwrap().confirmations.clear();
        p.removal.as_mut().unwrap().attempted = false;
        let dto = p.dto.clone();
        let mut plans = self.file_plans.lock().map_err(error)?;
        if plans.remove(trash_plan_id).is_none() {
            return Err(required());
        }
        plans.insert(dto.plan_id.clone(), p);
        Ok(dto)
    }
    pub fn confirm_file_removal(
        &self,
        plan_id: &str,
        stage: &str,
        previous_token: Option<String>,
    ) -> Result<RemovalConfirmation> {
        let p = self
            .file_plans
            .lock()
            .map_err(error)?
            .get(plan_id)
            .cloned()
            .ok_or_else(required)?;
        self.revalidate_removal(&p, &AtomicBool::new(false))?;
        let state = p.removal.as_ref().ok_or_else(required)?;
        let expected_stage = match (p.dto.action.as_str(), state.confirmations.len()) {
            ("trash", 0) => "trash",
            ("deletePermanently", 0) if state.unavailable => "targets",
            ("deletePermanently", 1) if state.unavailable => "irreversible",
            _ => return Err(required()),
        };
        if state.attempted
            || stage != expected_stage
            || previous_token.as_ref() != state.confirmations.last()
        {
            return Err(required());
        }
        let confirmation = RemovalConfirmation {
            plan_id: plan_id.into(),
            target_token: p.dto.targets[0].source_token.clone(),
            stage: stage.into(),
            token: uuid::Uuid::new_v4().to_string(),
        };
        let mut plans = self.file_plans.lock().map_err(error)?;
        let current = plans
            .get_mut(plan_id)
            .and_then(|p| p.removal.as_mut())
            .ok_or_else(required)?;
        if current.confirmations != state.confirmations || current.attempted {
            return Err(required());
        }
        current.confirmations.push(confirmation.token.clone());
        Ok(confirmation)
    }
    pub(super) fn validate_removal_launch(&self, p: &StoredPlan, d: &Decisions) -> Result<()> {
        let state = p.removal.as_ref().ok_or_else(required)?;
        let count = if p.dto.action == "trash" {
            1
        } else if p.dto.action == "deletePermanently" && state.unavailable {
            2
        } else {
            return Err(required());
        };
        if state.attempted
            || !d.skip_exemplar_ids.is_empty()
            || state.confirmations.len() != count
            || state.confirmations != d.removal_confirmations
        {
            return Err(required());
        }
        self.revalidate_removal(p, &AtomicBool::new(false))
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) fn apply_removal(
        &self,
        p: &StoredPlan,
        operation: &str,
        cancel: &AtomicBool,
        revision: &mut i64,
        cache: &Path,
        data: &Path,
        phase: impl Fn(&str),
    ) -> Result<()> {
        let path = PathBuf::from(&p.dto.targets[0].source_path);
        let tombstone = patch::neighbor(&path, operation, "deleted");
        let own = writes::OwnWrite::begin(
            writes::Declaration::new("catalogueRemoval")
                .temporary(&tombstone)
                .subtree(&path)
                .exact(&path)
                .exact(path.parent().unwrap()),
        );
        self.revalidate_removal(p, cancel)?;
        if p.dto.action == "deletePermanently" && super::recovery::present(&tombstone)? {
            return Err(fail(codes::CATALOG_DELETE_FAILED));
        }
        // The identity mode is durable before the detach: recovery of a move
        // whose new identities were never recorded depends on it.
        let relearn_after_move = p.dto.action == "deletePermanently"
            && !p.identities_survive_moves.first().copied().unwrap_or(true);
        let mut evidence = json!({"plan":p.dto,"parentId":p.removal.as_ref().unwrap().parent_id,"tombstone":tombstone,"snapshot":p.snapshots[0],"relearnAfterMove":relearn_after_move});
        self.reserve_removal(&path, || {
            self.write(|tx| {
                tx.execute(
                    "INSERT INTO file_removal VALUES (?1,?2,'pending')",
                    rusqlite::params![operation, evidence.to_string()],
                )
                .map_err(error)?;
                Ok(())
            })
        })?;
        if let Err(cancelled) = patch::check(cancel) {
            self.write(|tx| {
                tx.execute(
                    "UPDATE file_removal SET state='complete' WHERE id=?1",
                    [operation],
                )
                .map_err(error)?;
                Ok(())
            })?;
            return Err(cancelled);
        }
        phase("finalization");
        let mut trash_receipt = None;
        let outcome = if p.dto.action == "trash" {
            let (outcome, receipt) = trash_native::discard_tracked(&path);
            trash_receipt = receipt;
            outcome
        } else {
            // Detach the entire pack atomically before recursive deletion.
            // A failed detach leaves every original byte at its original path.
            match super::recovery::present(&tombstone) {
                Ok(false) => match detach(&path, &tombstone) {
                    Ok(()) => {
                        let detached_result = (|| {
                            #[cfg(test)]
                            DETACHED_HOOK.with(|slot| {
                                if let Some(hook) = slot.borrow_mut().as_mut() {
                                    hook(&tombstone);
                                }
                            });
                            #[cfg(test)]
                            if FAIL_DETACH_PROOF.with(|v| v.get()) {
                                return Err(fail(codes::CATALOG_DELETE_FAILED));
                            }
                            let _ = super::publish::sync_directory(path.parent().unwrap());
                            let mut detached = p.snapshots[0].clone();
                            detached.identities = patch::physical_ids(&tombstone, &detached)?;
                            evidence["snapshot"] =
                                serde_json::to_value(&detached).map_err(error)?;
                            self.write(|tx| {
                                tx.execute(
                                    "UPDATE file_removal SET evidence_json=?2 WHERE id=?1",
                                    rusqlite::params![operation, evidence.to_string()],
                                )
                                .map_err(error)?;
                                Ok(())
                            })?;
                            #[cfg(test)]
                            AFTER_DETACH_HOOK.with(|slot| {
                                if let Some(hook) = slot.borrow_mut().as_mut() {
                                    hook(&tombstone);
                                }
                            });
                            super::recovery::remove_owned(&tombstone, &detached)
                        })();
                        if detached_result.is_ok() {
                            Outcome::Removed
                        } else {
                            Outcome::Uncertain
                        }
                    }
                    // A refusal is proven only when nothing moved. A network
                    // rename may report an error after it has taken effect.
                    Err(_) => match (
                        super::recovery::present(&path),
                        super::recovery::present(&tombstone),
                    ) {
                        (Ok(true), Ok(false)) => Outcome::Failed,
                        _ => Outcome::Uncertain,
                    },
                },
                _ => Outcome::Failed,
            }
        };
        if let Some(receipt) = trash_receipt {
            evidence["trashReceipt"] = serde_json::to_value(receipt).map_err(error)?;
            self.write(|tx| {
                tx.execute(
                    "UPDATE file_removal SET evidence_json=?2 WHERE id=?1",
                    rusqlite::params![operation, evidence.to_string()],
                )
                .map_err(error)?;
                Ok(())
            })?;
        }
        #[cfg(test)]
        AFTER_NATIVE_HOOK.with(|slot| {
            if let Some(hook) = slot.borrow_mut().as_mut() {
                hook(&path);
            }
        });
        // Source absence alone does not prove a detached permanent copy was erased.
        let removal_complete = p.dto.action == "trash" || matches!(outcome, Outcome::Removed);
        let detach_failed =
            matches!(outcome, Outcome::Failed) && p.dto.action == "deletePermanently";
        let mut result = match outcome {
            Outcome::Removed => Ok(()),
            Outcome::UnavailableForTarget => {
                self.write(|tx| {
                    tx.execute(
                        "UPDATE file_removal SET state='complete' WHERE id=?1",
                        [operation],
                    )
                    .map_err(error)?;
                    Ok(())
                })?;
                self.revalidate_removal(p, &AtomicBool::new(false))?;
                let mut next = p.clone();
                let state = next.removal.as_mut().unwrap();
                state.unavailable = true;
                state.attempted = true;
                let mut plans = self.file_plans.lock().map_err(error)?;
                plans.retain(|_, p| p.dto.expires_at > plan::stamp());
                if plans.len() >= 32 || p.dto.expires_at <= plan::stamp() {
                    return Err(fail(codes::CATALOG_FILE_PLAN_EXPIRED));
                }
                plans.insert(p.dto.plan_id.clone(), next);
                Err(fail(codes::CATALOG_TRASH_UNAVAILABLE))
            }
            Outcome::Failed => Err(fail(if p.dto.action == "deletePermanently" {
                codes::CATALOG_DELETE_FAILED
            } else {
                codes::CATALOG_TRASH_FAILED
            })),
            Outcome::Uncertain => Err(fail(if p.dto.action == "deletePermanently" {
                codes::CATALOG_DELETE_FAILED
            } else {
                codes::CATALOG_TRASH_UNCERTAIN
            })),
        };
        // An absent target is established only with an accessible unchanged
        // parent. An unavailable/disconnected volume is never a deletion proof.
        let absent = absence_confirmed(&path, Some(&p.removal.as_ref().unwrap().parent_id));
        if result.is_ok() && !absent {
            result = Err(fail(if p.dto.action == "deletePermanently" {
                codes::CATALOG_DELETE_FAILED
            } else {
                codes::CATALOG_TRASH_UNCERTAIN
            }));
        }
        if absent {
            self.reconcile_removal(&path, cache, data)?;
            if absence_confirmed(&path, Some(&p.removal.as_ref().unwrap().parent_id)) {
                self.retire_removed_exemplar(&p.dto.targets[0], operation, removal_complete)?;
            } else {
                result = Err(fail(if p.dto.action == "deletePermanently" {
                    codes::CATALOG_DELETE_FAILED
                } else {
                    codes::CATALOG_TRASH_UNCERTAIN
                }));
            }
        }
        own.finish(&result, |_| vec![path.clone()]);
        self.write(|tx| {
            tx.execute(
                "UPDATE file_removal SET state=?2 WHERE id=?1 AND state!='purgePending'",
                rusqlite::params![
                    operation,
                    if !detach_failed
                        && result.as_ref().err().is_some_and(|e| matches!(
                            e.code.as_str(),
                            codes::CATALOG_TRASH_UNCERTAIN | codes::CATALOG_DELETE_FAILED
                        ))
                    {
                        "uncertain"
                    } else {
                        "complete"
                    }
                ],
            )
            .map_err(error)?;
            Ok(())
        })?;
        self.retry_removal_purges();
        *revision = self.list_sources()?.catalogue_revision;
        result
    }
    fn retire_removed_exemplar(
        &self,
        t: &PlannedTarget,
        operation: &str,
        removal_complete: bool,
    ) -> Result<()> {
        let trash = self.write(|tx| {
            let raw: String = tx
                .query_row(
                    "SELECT evidence_json FROM file_removal WHERE id=?1",
                    [operation],
                    |r| r.get(0),
                )
                .map_err(error)?;
            let mut evidence: Value = serde_json::from_str(&raw).map_err(error)?;
            let trash = evidence["plan"]["action"] == "trash";
            if trash {
                evidence["retainedInTrash"] = Value::Bool(true);
                tx.execute(
                    "UPDATE file_removal SET evidence_json=?2 WHERE id=?1",
                    rusqlite::params![operation, evidence.to_string()],
                )
                .map_err(error)?;
            }
            Ok(trash)
        })?;
        let last = self.retire_exemplar(&t.fiche_id, &t.exemplar_id)?;
        if last && removal_complete && !trash {
            self.write(|tx| {
                tx.execute(
                    "UPDATE file_removal SET state='purgePending' WHERE id=?1",
                    [operation],
                )
                .map_err(error)?;
                Ok(())
            })?;
        }
        Ok(())
    }
    /// Durable retirement once a pack left its place; true when it was the
    /// fiche's last exemplar.
    pub(crate) fn retire_exemplar(&self, fiche_id: &str, exemplar_id: &str) -> Result<bool> {
        self.write(|tx| {
            let changed = tx
                .execute(
                    "UPDATE exemplar SET retired=1 WHERE id=?1 AND retired=0",
                    [exemplar_id],
                )
                .map_err(error)?;
            tx.execute(
                crate::services::catalogue::grouping::RETIRE_OBSERVATION,
                [exemplar_id],
            )
            .map_err(error)?;
            tx.execute(
                "DELETE FROM cache.coverage WHERE exemplar_id=?1",
                [exemplar_id],
            )
            .map_err(error)?;
            if changed > 0 {
                tx.execute(
                    "UPDATE fiche SET revision=revision+1 WHERE id=?1",
                    [fiche_id],
                )
                .map_err(error)?;
                tx.execute(
                    "DELETE FROM cache.search_projection WHERE fiche_id=?1",
                    [fiche_id],
                )
                .map_err(error)?;
                tx.execute("UPDATE catalogue SET revision=revision+1", [])
                    .map_err(error)?;
            }
            let remaining: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM exemplar WHERE fiche_id=?1 AND retired=0)",
                    [fiche_id],
                    |r| r.get(0),
                )
                .map_err(error)?;
            Ok(!remaining)
        })
    }
    // Best effort, after durable retirement and operation completion. Evidence
    // remains in the removal journal when an unrelated recovery blocks purge.
    pub(crate) fn retry_removal_purges(&self) -> bool {
        let rows: Result<Vec<(String, String)>> = self.read(|c| {
            c.prepare("SELECT id,evidence_json FROM file_removal WHERE state='purgePending' AND NOT EXISTS(SELECT 1 FROM file_operation o WHERE o.id=file_removal.id AND o.state='running')")?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect()
        });
        let Ok(rows) = rows else {
            return false;
        };
        let mut changed = false;
        for (id, evidence) in rows {
            let result = self.write(|tx| {
                let mut v: Value = serde_json::from_str(&evidence).map_err(error)?;
                let current: Option<String> = tx
                    .query_row(
                        "SELECT fiche_id FROM exemplar WHERE id=?1",
                        [v["plan"]["targets"][0]["exemplarId"].as_str()],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(error)?;
                let fiche = current
                    .or_else(|| {
                        v["retentionFicheId"]
                            .as_str()
                            .or_else(|| v["plan"]["targets"][0]["ficheId"].as_str())
                            .map(str::to_owned)
                    })
                    .ok_or_else(forbidden)?;
                if v["plan"]["action"] != "deletePermanently" {
                    // Older versions queued trash disappearance as a purge.
                    // That durable state is not positive deletion evidence.
                    v["retainedInTrash"] = Value::Bool(false);
                    tx.execute(
                        "UPDATE file_removal SET state='complete',evidence_json=?2 WHERE id=?1",
                        rusqlite::params![id, v.to_string()],
                    )
                    .map_err(error)?;
                    tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [&fiche])
                        .map_err(error)?;
                    tx.execute(
                        "DELETE FROM cache.search_projection WHERE fiche_id=?1",
                        [&fiche],
                    )
                    .map_err(error)?;
                    tx.execute("UPDATE catalogue SET revision=revision+1", [])
                        .map_err(error)?;
                    return Ok(true);
                }
                let remaining: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM exemplar WHERE fiche_id=?1 AND retired=0)",
                        [&fiche],
                        |r| r.get(0),
                    )
                    .map_err(error)?;
                let retained = super::trash_retention::retains(tx, &fiche)?;
                if retained || super::trash_retention::has_unresolved_exemplar(tx, &fiche)? {
                    return Ok(false);
                }
                if !remaining {
                    crate::services::catalogue::removal::purge_after_file_removal(
                        tx,
                        std::slice::from_ref(&fiche),
                        &id,
                    )?;
                    tx.execute("UPDATE catalogue SET revision=revision+1", [])
                        .map_err(error)?;
                }
                tx.execute(
                    "UPDATE file_removal SET state='complete' WHERE id=?1",
                    [&id],
                )
                .map_err(error)?;
                Ok(!remaining)
            });
            match result {
                Ok(true) => {
                    changed = true;
                    self.finish_erasure_cleanup();
                }
                Ok(false) => {}
                Err(reason) => log::warn!("Catalogue deferred purge {id}: {}", reason.code),
            }
        }
        changed
    }
    fn reconcile_removal(&self, path: &Path, cache: &Path, data: &Path) -> Result<()> {
        let exclusions = self.exclusions_raw(cache, data)?;
        for source in self
            .all_sources()?
            .items
            .into_iter()
            .filter(|s| s.status == "active")
        {
            self.refresh_paths(
                &crate::services::catalogue::refresh::Root {
                    source_id: source.id,
                    path: source.native_path,
                },
                &[crate::services::catalogue::refresh::Change {
                    path: path.into(),
                    settled: true,
                    structural: true,
                }],
                &exclusions,
                Duration::ZERO,
                &AtomicBool::new(false),
                &writes::Registry::default(),
            )?;
        }
        Ok(())
    }
    fn mark_removal_uncertain(&self, id: &str) -> Result<()> {
        self.write(|tx| {
            tx.execute(
                "UPDATE file_removal SET state='uncertain' WHERE id=?1",
                [id],
            )
            .map_err(error)?;
            Ok(())
        })
    }
    /// Erase a detached tombstone. Its proof may no longer match the native
    /// identities: the move changed them (FAT/exFAT) before the new ones were
    /// recorded, or a remount changed them all (Unix device number of a
    /// replugged drive, FAT/exFAT inode renumbering). The tombstone name
    /// derives from the operation id and the source path: at that reserved
    /// name only, the untouched complete content is relearned, recorded, then
    /// erased. A partial erasure only starts after that record. That proven
    /// tombstone also attests the parent directory (same volume, mounted):
    /// its new identity is recorded with it for the absence proof.
    fn remove_tombstone(
        &self,
        id: &str,
        evidence: &mut Value,
        source: &Path,
        tombstone: &Path,
        snapshot: &patch::Snapshot,
    ) -> Result<()> {
        let strict = super::recovery::remove_owned(tombstone, snapshot);
        if strict.is_ok()
            || patch::neighbor(source, id, "deleted") != tombstone
            || !super::recovery::present(tombstone)?
        {
            return strict;
        }
        let relearned = super::recovery::relearn_moved(tombstone, snapshot)?;
        let parent = writes::file_id(source.parent().ok_or_else(forbidden)?)
            .ok_or_else(|| fail(codes::CATALOG_DELETE_FAILED))?;
        evidence["snapshot"] = serde_json::to_value(&relearned).map_err(error)?;
        evidence["parentId"] = json!(parent);
        self.write(|tx| {
            tx.execute(
                "UPDATE file_removal SET evidence_json=?2 WHERE id=?1",
                rusqlite::params![id, evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })?;
        super::recovery::remove_owned(tombstone, &relearned)
    }
    pub(crate) fn recover_removals_from(
        &self,
        rows: Vec<(String, String)>,
    ) -> Result<Vec<crate::support::user_message::UserMessage>> {
        let mut warnings = Vec::new();
        for (id, evidence) in rows {
            let recovered = (|| -> Result<()> {
                let mut v: Value = match serde_json::from_str(&evidence) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("Ignoring unreadable catalogue removal {id}: {e}");
                        return Ok(());
                    }
                };
                let Some(source) = v["plan"]["targets"][0]["sourcePath"].as_str() else {
                    log::warn!("Ignoring removal {id} without source path");
                    return Ok(());
                };
                let path = PathBuf::from(source);
                if !path.is_absolute() || path.parent().is_none() {
                    log::warn!("Ignoring removal {id} with invalid source path");
                    return Ok(());
                }
                if v["plan"]["action"] == "deletePermanently" {
                    if let Some(tombstone) = v["tombstone"].as_str().map(PathBuf::from) {
                        let snapshot: patch::Snapshot =
                            match serde_json::from_value(v["snapshot"].clone()) {
                                Ok(s) => s,
                                Err(e) => {
                                    log::warn!("Ignoring removal {id} without deletion proof: {e}");
                                    return Ok(());
                                }
                            };
                        if let Err(e) =
                            self.remove_tombstone(&id, &mut v, &path, &tombstone, &snapshot)
                        {
                            log::warn!("Catalogue deletion {id}: {e}");
                            warnings.push(fail(codes::CATALOG_DELETE_FAILED));
                            return Ok(());
                        }
                    }
                }
                let absent = absence_confirmed(&path, v["parentId"].as_str());
                if absent {
                    // Recovery publishes disappearance, never repeats the mutation.
                    let cache = self
                        .staging_root()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .to_path_buf();
                    let data = self.file_root().parent().unwrap().to_path_buf();
                    #[cfg(test)]
                    RECOVERY_RECONCILE_HOOK.with(|slot| {
                        if let Some(hook) = slot.borrow_mut().as_mut() {
                            hook(&path);
                        }
                    });
                    self.reconcile_removal(&path, &cache, &data)?;
                    #[cfg(test)]
                    RECOVERY_AFTER_RECONCILE_HOOK.with(|slot| {
                        if let Some(hook) = slot.borrow_mut().as_mut() {
                            hook(&path);
                        }
                    });
                    if !absence_confirmed(&path, v["parentId"].as_str()) {
                        self.mark_removal_uncertain(&id)?;
                        warnings.push(fail(codes::CATALOG_TRASH_UNCERTAIN));
                        return Ok(());
                    }
                    let target: PlannedTarget =
                        match serde_json::from_value(v["plan"]["targets"][0].clone()) {
                            Ok(t) => t,
                            Err(e) => {
                                log::warn!("Ignoring malformed removal {id}: {e}");
                                return Ok(());
                            }
                        };
                    self.retire_removed_exemplar(&target, &id, true)?;
                    self.write(|tx| {
                    tx.execute("UPDATE file_removal SET state='complete' WHERE id=?1 AND state!='purgePending'", [&id])
                        .map_err(error)?;
                    Ok(())
                })?;
                } else if std::fs::symlink_metadata(&path).is_ok()
                    && writes::file_id(path.parent().unwrap()).as_deref() == v["parentId"].as_str()
                {
                    log::warn!("Catalogue removal {id} was not performed; source still present");
                    self.write(|tx| {
                        tx.execute(
                            "UPDATE file_removal SET state='complete' WHERE id=?1",
                            [&id],
                        )
                        .map_err(error)?;
                        Ok(())
                    })?;
                } else {
                    self.mark_removal_uncertain(&id)?;
                    warnings.push(fail(codes::CATALOG_TRASH_UNCERTAIN));
                }
                Ok(())
            })();
            if let Err(reason) = recovered {
                log::warn!("Catalogue removal recovery {id}: {}", reason.code);
                warnings.push(reason);
            }
            self.retry_removal_purges();
        }
        if let Err(warning) = self.reconcile_trash_retention() {
            warnings.push(warning);
        }
        Ok(warnings)
    }
}

// Permanent deletion remains available on SMB/FUSE without exclusive rename.
fn detach(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_DETACH.with(|v| v.get()) {
        return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    }
    #[cfg(test)]
    if FAIL_AFTER_DETACH.with(|v| v.get()) {
        std::fs::rename(from, to)?;
        return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
    }
    std::fs::rename(from, to)
}
