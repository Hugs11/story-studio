// Cache de vue local de l'éditeur avancé : hors projet, hors dépôt,
// perdable par construction. Il n'a jamais autorité sur le document.
pub mod advanced_view_cache;
pub mod catalogue;
pub mod comfyui;
pub mod community_pack_checker;
pub mod official_packs;
pub mod pack_reader;
pub mod piper;
pub mod podcast;
pub mod project_files;
pub mod xtts;
pub mod youtube;

// Headless plain storyteller staging; device transport belongs to the driver.
#[allow(dead_code)]
pub(crate) mod storyteller;

// Headless mounted-volume driver; wired to IPC in a later lot.
#[allow(dead_code)]
pub(crate) mod storyteller_device;
