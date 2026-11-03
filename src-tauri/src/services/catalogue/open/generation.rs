//! Generation evidence comes only from a successful Story Studio generation.
use crate::services::catalogue::{
    analyze,
    refresh::{Change, Root},
    store::{error, Store},
    writes, Result,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

/// Additive IPC envelope: the engine result is unchanged, publication evidence
/// is captured by the command before yielding back to the interface.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published<T: Serialize> {
    #[serde(flatten)]
    result: T,
    output_fingerprint: Option<String>,
}
impl<T: Serialize> Published<T> {
    pub fn capture(result: T, output: &Path) -> Self {
        Self {
            result,
            output_fingerprint: output_fingerprint(output).ok(),
        }
    }
}

/// Stream the complete archive, without loading large packs into memory.
pub fn output_fingerprint(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Debug, Serialize)]
pub struct Recorded {
    pub recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}
fn skipped(reason: &'static str) -> Recorded {
    Recorded {
        recorded: false,
        reason: Some(reason),
    }
}
/// Full saved envelope, including absent/null distinctions; never a file date.
pub fn project_token(raw: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(raw).unwrap_or_default())
    )
}

impl Store {
    // Paths, registry and the two independent publication proofs are explicit.
    #[allow(clippy::too_many_arguments)]
    pub fn record_generation(
        &self,
        project: &Path,
        output: &Path,
        cache: &Path,
        data: &Path,
        registry: &writes::Registry,
        generated_project_json: Option<&str>,
        generated_output_fingerprint: Option<&str>,
    ) -> Result<Recorded> {
        if project.as_os_str().is_empty() || !project.is_file() {
            return Ok(skipped("projectUnsaved"));
        }
        let project = super::super::refresh::resolve_existing(project);
        let output = super::super::refresh::resolve_existing(output);
        let project = project.as_path();
        let output = output.as_path();
        let sources = self.all_sources()?;
        let Some(source) = sources
            .items
            .iter()
            .filter(|s| s.status == "active" && output.starts_with(&s.resolved_path))
            .max_by_key(|s| s.resolved_path.components().count())
        else {
            return Ok(skipped("outputNotCovered"));
        };
        let exclusions = self.exclusions_raw(cache, data)?;
        if exclusions.reason_for_resolved(output, None).is_some() {
            return Ok(skipped("outputNotCovered"));
        }
        // Immutable evidence was captured before the engine call and checked
        // against its queued input. Never mint it from the file found now.
        let Some(generated_raw) = generated_project_json
            .and_then(|text| analyze::json(text.as_bytes()).ok())
            .filter(Value::is_object)
        else {
            return Ok(skipped("generationUnproven"));
        };
        let generated_token = project_token(&generated_raw);
        let Some(expected_output) = generated_output_fingerprint else {
            return Ok(skipped("generationUnproven"));
        };
        let _heavy = self.scans.heavy.lock().map_err(error)?;
        self.refresh_paths(
            &Root {
                source_id: source.id.clone(),
                path: source.resolved_path.clone(),
            },
            &[Change {
                path: output.to_owned(),
                settled: true,
                structural: false,
            }],
            &exclusions,
            Duration::ZERO,
            &AtomicBool::new(false),
            registry,
        )?;
        if let Some(project_source) = sources
            .items
            .iter()
            .filter(|s| s.status == "active" && project.starts_with(&s.resolved_path))
            .max_by_key(|s| s.resolved_path.components().count())
        {
            self.refresh_paths(
                &Root {
                    source_id: project_source.id.clone(),
                    path: project_source.resolved_path.clone(),
                },
                &[Change {
                    path: project.to_owned(),
                    settled: true,
                    structural: false,
                }],
                &exclusions,
                Duration::ZERO,
                &AtomicBool::new(false),
                registry,
            )?;
        }
        let locate = |path: &Path, project_only: bool| -> Result<Option<(String, String)>> {
            let display = crate::support::paths::path_for_frontend(path);
            self.read_snapshot(|c|c.query_row("SELECT e.id,o.content_token FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.retired=0 AND o.state='available' AND ((?2=1 AND o.format='project') OR (?2=0 AND o.format!='project')) AND json_extract(e.anchor_json,'$.path')=?1 AND json_extract(e.anchor_json,'$.member') IS NULL",params![display,project_only],|r|Ok((r.get(0)?,r.get(1)?))).optional())
        };
        let Some((project_id, _)) = locate(project, true)? else {
            return Ok(skipped("projectNotIndexed"));
        };
        let Some((output_id, output_token)) = locate(output, false)? else {
            return Ok(skipped("outputNotCovered"));
        };
        let before = super::super::scan::token(project).map_err(error)?.0;
        let raw = analyze::project(project)
            .map_err(crate::support::user_message::UserMessage::from)?
            .raw;
        if super::super::scan::token(project).map_err(error)?.0 != before {
            return Ok(skipped("projectUnsaved"));
        }
        if project_token(&raw) != generated_token {
            return Ok(skipped("projectChanged"));
        }
        // Recheck after the scan wait and refresh. A replacement must never
        // inherit the attestation of the archive published by the engine.
        if output_fingerprint(output).ok().as_deref() != Some(expected_output)
            || super::super::scan::token(output).map_err(error)?.0 != output_token
        {
            return Ok(skipped("outputChanged"));
        }
        let token = generated_token;
        self.write(|c|{
            c.execute("INSERT INTO generation_receipt(id,project_exemplar_id,output_exemplar_id,generated_project_token,output_content_token,generated_at,evidence_json) VALUES(?1,?2,?3,?4,?5,unixepoch(),?6)",params![uuid::Uuid::new_v4().to_string(),project_id,output_id,token,output_token,json!({"origin":"storyStudio","revision":"capturedBeforeGeneration"}).to_string()]).map_err(error)?;
            c.execute("UPDATE catalogue SET revision=revision+1",[]).map_err(error)?;
            Ok(())
        })?;
        Ok(Recorded {
            recorded: true,
            reason: None,
        })
    }
}

/// Called within the list snapshot; no filesystem probe and no UUID inference.
pub fn state(
    c: &rusqlite::Connection,
    exemplar: &str,
    observation: &Value,
) -> rusqlite::Result<Value> {
    let receipt = c.query_row("SELECT r.generated_project_token,r.output_exemplar_id,r.output_content_token,o.content_token FROM (SELECT * FROM generation_receipt WHERE project_exemplar_id=?1 ORDER BY generated_at DESC,rowid DESC LIMIT 1) r LEFT JOIN exemplar e ON e.id=r.output_exemplar_id AND e.retired=0 LEFT JOIN cache.observation o ON o.exemplar_id=e.id AND o.state='available'", [exemplar], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?))).optional()?;
    Ok(match receipt {
        Some((token, output, expected, current))
            if current.as_deref() == Some(expected.as_str()) =>
        {
            json!({"state":if token==project_token(&observation["raw"]) {"upToDate"} else {"modifiedSince"},"outputExemplarId":output})
        }
        _ => json!({"state":"unknown"}),
    })
}
