use super::{error, fail, models::*, Result};
use crate::{services::catalogue::store::Store, support::user_message::codes};
pub(super) fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
impl Store {
    pub fn release_file_plan(&self, plan_id: &str) -> Result<()> {
        self.file_plans.lock().map_err(error)?.remove(plan_id);
        Ok(())
    }

    pub fn plan_file_operation(
        &self,
        action: String,
        targets: Vec<TargetRequest>,
        options: Options,
    ) -> Result<FilePlan> {
        match action.as_str() {
            "trash" => self.plan_trash(targets, options),
            "deletePermanently" => Err(fail(codes::CATALOG_DELETE_CONFIRMATION_REQUIRED)),
            _ => Err(fail(codes::CATALOG_MUTATION_INVALID)),
        }
    }
}
