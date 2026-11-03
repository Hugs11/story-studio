//! Complete recoverable snapshots; each terminal outcome has one main reason.
use serde::Serialize;
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Roots {
    pub total: u64,
    pub completed: u64,
    pub failed: u64,
}
#[derive(Clone, Default, Serialize)]
pub struct Directories {
    pub visited: u64,
    pub errors: u64,
    pub total: Option<u64>,
}
#[derive(Clone, Default, Serialize)]
pub struct Candidates {
    pub discovered: u64,
    pub processed: u64,
    pub total: Option<u64>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcomes {
    pub indexed_new: u64,
    pub updated: u64,
    pub removed: u64,
    pub unchanged: u64,
    pub ignored: u64,
    pub refused: u64,
    pub error: u64,
    pub not_processed: u64,
}
#[derive(Clone, Default, Serialize)]
pub struct Cards {
    pub created: u64,
    pub updated: u64,
}
#[derive(Clone, Serialize)]
pub struct Reason {
    pub reason: String,
    pub outcome: String,
    pub count: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportItem {
    pub path: String,
    pub member: Option<String>,
    pub outcome: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_bytes: Option<u64>,
    pub operation_id: String,
    pub request_id: String,
    pub sequence: u64,
    pub sources_revision: i64,
    pub catalogue_revision: i64,
    pub timestamp: u64,
    pub error: Option<crate::support::user_message::UserMessage>,
    pub status: String,
    pub phase: String,
    pub discovery_complete: bool,
    pub scan_complete: bool,
    pub unvisited_extent_unknown: bool,
    pub current_source_id: Option<String>,
    pub current_directory: Option<String>,
    pub roots: Roots,
    pub directories: Directories,
    pub candidates: Candidates,
    pub outcomes: Outcomes,
    pub cards: Cards,
    pub reasons: Vec<Reason>,
    #[serde(skip)]
    pub report: Vec<ReportItem>,
    /// Set once a publication changed the catalogue, cancelled scans included.
    #[serde(skip)]
    pub catalogue_changed: bool,
}
impl Progress {
    /// Root and directory failures are reported apart from pack outcomes and
    /// never counted as processed candidates.
    pub fn record_scope_error(&mut self, path: String, reason: &str, detail: String) {
        self.count_reason(reason, "scopeError");
        self.report.push(ReportItem {
            path,
            member: None,
            outcome: "scopeError".into(),
            reason: Some(reason.into()),
            detail: Some(detail),
        });
    }
    /// An entry skipped by an exclusion rule: counted as ignored with an
    /// explicit reason, but never as a processed candidate.
    pub fn record_ignored(&mut self, path: String, role: &str) {
        self.outcomes.ignored += 1;
        self.count_reason("excludedByRule", "ignored");
        self.report.push(ReportItem {
            path,
            member: None,
            outcome: "ignored".into(),
            reason: Some("excludedByRule".into()),
            detail: Some(role.into()),
        });
    }
    fn count_reason(&mut self, reason: &str, outcome: &str) {
        if let Some(item) = self
            .reasons
            .iter_mut()
            .find(|r| r.reason == reason && r.outcome == outcome)
        {
            item.count += 1;
        } else {
            self.reasons.push(Reason {
                reason: reason.into(),
                outcome: outcome.into(),
                count: 1,
            });
        }
    }
    pub fn record(
        &mut self,
        path: String,
        member: Option<String>,
        outcome: &str,
        reason: Option<&str>,
    ) {
        self.candidates.processed += 1;
        match outcome {
            "indexedNew" => self.outcomes.indexed_new += 1,
            "updated" => self.outcomes.updated += 1,
            "removed" => self.outcomes.removed += 1,
            "unchanged" => self.outcomes.unchanged += 1,
            "ignored" => self.outcomes.ignored += 1,
            "refused" => self.outcomes.refused += 1,
            _ => self.outcomes.error += 1,
        };
        if let Some(reason) = reason {
            self.count_reason(reason, outcome);
        }
        self.report.push(ReportItem {
            path,
            member,
            outcome: outcome.into(),
            reason: reason.map(str::to_owned),
            detail: None,
        });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPage {
    #[serde(flatten)]
    pub progress: Progress,
    pub items: Vec<ReportItem>,
    pub total_matching: usize,
    pub cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::Progress;

    #[test]
    fn removed_is_a_processed_outcome_in_the_snapshot_contract() {
        let mut progress = Progress::default();
        progress.record(
            "/source/known.zip".into(),
            None,
            "removed",
            Some("fileDisappeared"),
        );
        progress.record(
            "/source/unknown.zip".into(),
            None,
            "error",
            Some("fileDisappeared"),
        );
        let dto = serde_json::to_value(&progress).unwrap();
        assert_eq!(dto["outcomes"]["removed"], 1);
        assert_eq!(dto["outcomes"]["updated"], 0);
        assert_eq!(dto["outcomes"]["error"], 1);
        assert_eq!(dto["outcomes"]["notProcessed"], 0);
        assert_eq!(dto["candidates"]["processed"], 2);
        assert_eq!(dto["reasons"][0]["outcome"], "removed");
        assert_eq!(progress.report[0].outcome, "removed");
    }
}
