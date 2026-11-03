mod after_playback;
pub mod bundle;
mod chaining;
#[cfg(test)]
mod edge_class;
mod extraction;
mod graph_import;
mod navigation_targets;
mod night_mode;
mod projection;
mod sequence_menus;
mod stage;
mod story_entry;
mod transitions;
mod validation;

pub use bundle::{inspect_pack_archive, PackArchiveInspection};
pub(crate) use extraction::import_pack_as_advanced_document_with_catalogue;
pub use extraction::{
    check_pack_editability, classify_pack_editability, get_pack_asset, load_pack_zip,
    load_pack_zip_for_simulation, unpack_zip_to_entries, unpack_zip_to_entries_named,
    PackEditabilityReport,
};
#[cfg(test)]
pub(crate) use extraction::{
    import_pack_as_advanced_document, import_pack_as_free_project,
    imported_native_graph_document_for_test, unpack_zip_to_entries_unchecked,
};

#[cfg(test)]
mod tests;

pub(crate) use graph_import::story_audio;

pub(crate) use extraction::read_pack_uuid;

pub(crate) use validation::{validate_pack_asset_name, MAX_STORY_JSON_BYTES};
