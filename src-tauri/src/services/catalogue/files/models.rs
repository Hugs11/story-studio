use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetRequest {
    pub fiche_id: String,
    pub exemplar_id: String,
    pub expected_revision: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub mode: String,
    #[serde(default)]
    pub correction_resolutions: Vec<Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decisions {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removal_confirmations: Vec<String>,
    pub summary_validated: bool,
    /// Changing a conflicting name needs a new plan.
    pub skip_exemplar_ids: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub field: String,
    pub before: Value,
    pub after: Value,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub state: String,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTarget {
    pub fiche_id: String,
    pub exemplar_id: String,
    pub expected_revision: i64,
    pub source_path: String,
    pub source_format: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub member_chain: Vec<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub destination_format: String,
    pub source_token: String,
    pub destination_path: String,
    pub destination_token: Option<String>,
    pub mode: String,
    pub changes: Vec<Change>,
    pub proposed_name: String,
    /// Always false: kept in the plan DTO contract.
    pub rename_default_checked: bool,
    pub conflicts: Vec<String>,
    pub capability: Capability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_target_fiche_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub correction_resolutions: Vec<Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub plan_id: String,
    pub catalogue_revision: i64,
    pub expires_at: u64,
    pub action: String,
    pub targets: Vec<PlannedTarget>,
    pub total_bytes: u64,
    pub required_free_bytes: u64,
    pub issues: Vec<String>,
}
#[derive(Clone)]
pub(crate) struct StoredPlan {
    pub identities_survive_moves: Vec<bool>,
    pub removal: Option<super::trash::RemovalState>,
    pub dto: FilePlan,
    pub snapshots: Vec<super::patch::Snapshot>,
}
