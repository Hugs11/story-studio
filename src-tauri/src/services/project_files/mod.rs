mod audio;
mod delete;
mod media_copy;
mod paths;
mod project_storage;
mod recording;

pub use audio::*;
pub use delete::*;
pub(crate) use paths::*;
pub use project_storage::{rename_project_folder, resolve_project_folder, ProjectFolderMove};
pub(crate) use recording::*;

#[cfg(test)]
mod tests;

pub(crate) use project_storage::{project_media_dir, ProjectMediaDestination};

pub use media_copy::{copy_project_media, ProjectMediaCopy};
