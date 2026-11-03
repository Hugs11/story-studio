//! Conversion shares consultation's format readers and preserves their bytes.
use super::{fail, formats, patch, Result};
use crate::support::user_message::codes;
use std::{path::Path, sync::atomic::AtomicBool};
#[cfg(test)]
thread_local! {
    pub(super) static ASSEMBLY_CONVERSION_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn prepare(
    catalogue: Option<
        &dyn crate::services::official_packs::OfficialCatalogue<
            Error = crate::support::user_message::UserMessage,
        >,
    >,
    source: &Path,
    format: &str,
    chain: &[serde_json::Value],
    output: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let scratch = formats::Scratch::new()?;
    let input = formats::view(source, format, chain, &scratch.path, cancel)?;
    let input = if input.is_dir() {
        crate::support::imported_pack::ensure_studio_pack_zip_from_dir_cancellable(
            &input.to_string_lossy(),
            &scratch.path.join("converted"),
            cancel,
        )
        .map_err(|e| {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                fail(codes::GENERATION_CANCELLED)
            } else {
                fail(codes::CATALOG_FILE_CONVERSION_FAILED).with_detail(e)
            }
        })?
        .zip_path
    } else {
        input
    };
    #[cfg(test)]
    ASSEMBLY_CONVERSION_HOOK.with(|hook| {
        if let Some(callback) = hook.borrow_mut().take() {
            callback();
        }
    });
    // No checker corrections. Only the shared identity decision may change story metadata.
    patch::prepare(catalogue, &input, output, cancel).map_err(|e| {
        if matches!(
            e.code.as_str(),
            codes::GENERATION_CANCELLED
                | codes::OFFICIAL_CONTENT_OUTPUT_REFUSED
                | codes::OFFICIAL_IDENTITY_LOCKED
        ) {
            e
        } else {
            fail(codes::CATALOG_FILE_CONVERSION_FAILED).with_detail(e.to_string())
        }
    })
}
