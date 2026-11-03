//! Read-only explanation: no pack content is opened, and no source is mutated.
use super::{
    sources::{native, Exclusion},
    store::Store,
    Result,
};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedPath {
    exemplar_id: String,
    fiche_id: String,
    availability: String,
}
#[derive(Serialize)]
pub struct LastOutcome {
    outcome: String,
    reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathExplanation {
    covered_by_source_id: Option<String>,
    excluded: Option<Exclusion>,
    indexed: Vec<IndexedPath>,
    last_outcome: Option<LastOutcome>,
}
impl Store {
    pub fn explain_path(&self, path: &Path, cache: &Path, data: &Path) -> Result<PathExplanation> {
        let display = crate::support::paths::path_for_frontend(path);
        let (covered_by_source_id, indexed, resolved) = self.read_snapshot(|tx| {
            let sources = tx.prepare("SELECT id,path,coalesce(resolved_path,path) FROM source WHERE status='active'")?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, native(r.get(1)?),native(r.get(2)?))))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let coverage = sources.iter().filter_map(|(id, declared, resolved)| {
                path.strip_prefix(declared).ok().map(|suffix| (id, declared.components().count(), resolved.join(suffix)))
                    .or_else(|| path.strip_prefix(resolved).ok().map(|_| (id, resolved.components().count(), path.to_path_buf())))
            }).max_by_key(|(_, depth, _)| *depth);
            let covered = coverage.as_ref().map(|(id, _, _)| (*id).clone());
            let indexed_path = coverage.as_ref().map(|(_, _, resolved)| crate::support::paths::path_for_frontend(resolved)).unwrap_or_else(|| display.clone());
            let indexed = tx.prepare("SELECT e.id,e.fiche_id,coalesce(o.state,'missing') FROM exemplar e LEFT JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.retired=0 AND json_extract(e.anchor_json,'$.path')=?1")?
                .query_map([&indexed_path], |r| Ok(IndexedPath { exemplar_id:r.get(0)?, fiche_id:r.get(1)?, availability: if r.get::<_, String>(2)? == "available" && covered.is_some() { "available" } else { "unavailable" }.into() }))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((covered, indexed, coverage.map(|(_, _, resolved)| resolved)))
        })?;
        let exclusions = self.exclusions_raw(cache, data)?;
        let excluded = exclusions
            .reason_for_resolved(path, resolved.as_deref())
            .cloned();
        let last_outcome = self
            .list_operations(20)?
            .items
            .into_iter()
            .find_map(|p| p.report.into_iter().rev().find(|item| item.path == display))
            .map(|item| LastOutcome {
                outcome: item.outcome,
                reason: item.reason,
            });
        Ok(PathExplanation {
            covered_by_source_id,
            excluded,
            indexed,
            last_outcome,
        })
    }
}
