//! Read-only adapter; recognition never opens or downloads the catalogue.
use super::{store::Store, CatalogueState, Result};
use crate::domain::official_provenance::{is_official_origin, OfficialProvenance};
use crate::services::official_packs::OfficialCatalogue;
use serde_json::Value;

/// An open catalogue connection (list snapshot) answers without opening another one.
impl OfficialCatalogue for rusqlite::Connection {
    type Error = rusqlite::Error;
    fn contains_official(&self, uuid: &str) -> rusqlite::Result<bool> {
        // Primary-key lookup: one indexed read per listed copy, no file access.
        self.query_row(
            "SELECT EXISTS(SELECT 1 FROM lunii_pack WHERE uuid=?1)",
            [uuid],
            |r| r.get(0),
        )
    }
}

impl OfficialCatalogue for Store {
    type Error = crate::support::user_message::UserMessage;
    fn contains_official(&self, uuid: &str) -> Result<bool> {
        self.read(|c| c.contains_official(uuid))
    }
}

/// Official origin of a stored catalogue observation: the one decision shared
/// by the catalogue list (`official`) and the Lunii send gate. Same data in
/// both places: the observed identity UUID and, for a project, its recorded
/// provenance; same rule as every output, `is_official_origin`.
pub(crate) fn observed_official<C: OfficialCatalogue + ?Sized>(
    observation: &Value,
    catalogue: Option<&C>,
) -> bool {
    let uuid = observation["identity"]["value"]
        .as_str()
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .map(|id| id.to_string())
        .unwrap_or_default();
    let provenance = if observation["format"] == "project" {
        serde_json::from_value(observation["raw"]["officialProvenance"].clone()).unwrap_or_default()
    } else {
        OfficialProvenance::Unknown
    };
    // `is_official_origin` already degrades a broken catalogue to the embedded list.
    is_official_origin(provenance, &uuid, catalogue).unwrap_or(false)
}

impl OfficialCatalogue for CatalogueState {
    type Error = crate::support::user_message::UserMessage;
    fn contains_official(&self, uuid: &str) -> Result<bool> {
        let slot = self.store.lock().map_err(super::store::error)?;
        match slot.as_ref() {
            Some(Ok(store)) => store.contains_official(uuid),
            Some(Err(error)) => Err(error.clone()),
            None => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::official_packs::is_official;

    #[test]
    fn official_packs_open_catalogue_fallback() {
        let root =
            std::env::temp_dir().join(format!("official-packs-test-{}", uuid::Uuid::new_v4()));
        let state = CatalogueState::default();
        let uuid = "00000000-0000-4000-8000-00000000000a";
        assert!(!is_official(uuid, Some(&state)).unwrap());
        let store = state
            .store(&root.join("data"), &root.join("cache"))
            .unwrap();
        store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO lunii_pack(uuid,document_json) VALUES (?1,'{}')",
                    [uuid],
                )
                .map_err(super::super::store::error)?;
                Ok(())
            })
            .unwrap();
        assert!(is_official(&uuid.to_uppercase(), Some(&state)).unwrap());
        assert!(!is_official("00000000-0000-4000-8000-00000000000b", Some(&state)).unwrap());
        drop(store);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
