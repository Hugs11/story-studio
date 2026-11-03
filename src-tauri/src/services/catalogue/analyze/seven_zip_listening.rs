//! One bounded streaming pass over a solid archive, after metadata publication.
use super::*;
use crate::support::{audio_duration as audio, fs_pack_reader as fs};
use std::{
    collections::HashMap,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};

/// Why a solid-archive listening pass produced no values.
#[derive(Debug, PartialEq)]
pub enum ListeningFailure {
    /// Nothing is published; the pass runs again on the next scan.
    Cancelled,
    /// The tool, not the archive, failed (missing 7-Zip, silence, abnormal
    /// exit, I/O): the pack stays pending and is retried on the next scan.
    Retry(String),
    /// The archive itself is corrupt, over a limit or hostile: settled for
    /// good, without listening values.
    Settled(String),
}
fn listing_failure(reason: String) -> ListeningFailure {
    match reason.as_str() {
        "cancelled" => ListeningFailure::Cancelled,
        "archiveCorrupt" | "archiveProtected" | "readLimitExceeded" | "invalidArchivePath" => {
            ListeningFailure::Settled(reason)
        }
        _ => ListeningFailure::Retry(reason),
    }
}

/// Measures every pending observation of `path` in one streaming pass. The
/// observations are changed only when the whole pass succeeds.
pub(crate) fn enrich(
    path: &Path,
    observations: &mut [Observation],
    cancel: &AtomicBool,
) -> Result<(), ListeningFailure> {
    let mut measured = observations.to_vec();
    measure(path, &mut measured, cancel)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(ListeningFailure::Cancelled);
    }
    observations.clone_from_slice(&measured);
    Ok(())
}
fn measure(
    path: &Path,
    observations: &mut [Observation],
    cancel: &AtomicBool,
) -> Result<(), ListeningFailure> {
    use ListeningFailure::{Cancelled, Settled};
    let binary =
        crate::support::imported_pack::resolve_7z_path().map_err(ListeningFailure::Retry)?;
    let listing = super::seven_zip::run_with_binary(
        &binary,
        path,
        &["l", "-slt", "-ba"],
        cancel,
        4 * 1024 * 1024,
        None,
    )
    .map_err(listing_failure)?;
    let entries: Vec<_> = super::seven_zip::parse_listing(
        std::str::from_utf8(&listing).map_err(|_| Settled("archiveCorrupt".into()))?,
    )
    .map_err(Settled)?
    .into_iter()
    .map(|(name, size, _)| (name, size))
    .collect();
    let mut command = Command::new(binary);
    command.args(["x", "-so", "-p", "--"]).arg(path);
    let metadata = &*observations;
    let (durations, indexes, images, mut nested, descriptors) =
        super::seven_zip::stream_child(command, cancel, move |stdout| {
            let mut nested = HashMap::new();
            let mut images = HashMap::new();
            let mut descriptors = Vec::new();
            let mut durations = HashMap::new();
            let mut indexes = HashMap::new();
            for (name, size) in &entries {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".to_owned());
                }
                let mut entry = (&mut *stdout).take(*size);
                let lower = name.to_ascii_lowercase();
                let basename = lower.rsplit('/').next().unwrap_or(&lower);
                let device = metadata.iter().find_map(|o| {
                    let variant = o.raw["variant"]
                        .as_str()
                        .and_then(fs::FsPackVariant::from_preview_name)?;
                    let root = o
                        .member
                        .as_ref()
                        .map(|m| format!("{m}/"))
                        .unwrap_or_default();
                    // Same ASCII case rule as the device-pack ZIP lookup.
                    lower
                        .starts_with(&format!("{root}sf/").to_ascii_lowercase())
                        .then_some(variant)
                });
                if lower.ends_with(".zip")
                    && metadata.iter().any(|o| {
                        o.state == "available"
                            && o.member.as_deref().is_some_and(|member| {
                                member == name
                                    || member
                                        .strip_prefix(name)
                                        .is_some_and(|s| s.starts_with('/'))
                            })
                    })
                {
                    // Metadata failures have already settled these children.
                    // Drain their bytes below without aborting readable siblings.
                    match super::stream_zip::read(&mut entry, 1, true, cancel) {
                        Ok(children) => {
                            nested.insert(name.clone(), children);
                        }
                        // Read again alone, buffered, once this pass is over.
                        Err(reason) if reason == super::stream_zip::DATA_DESCRIPTOR => {
                            descriptors.push((name.clone(), *size));
                        }
                        Err(reason) => return Err(reason),
                    }
                } else if let Some(variant) = device {
                    durations.insert(
                        name.clone(),
                        audio::fs_stream(&mut entry, variant, *size, cancel),
                    );
                } else if name.contains("assets/") && !name.ends_with('/') {
                    // The first bytes tell a picture (decoded like the send
                    // preparation does) from a sound (a header read).
                    let mut prefix = vec![0; (*size as usize).min(512)];
                    entry.read_exact(&mut prefix).map_err(|e| e.to_string())?;
                    if super::images::looks_like_image(name, &prefix) {
                        let verdict = super::images::judge(
                            std::io::Cursor::new(prefix).chain(&mut entry),
                            *size,
                            cancel,
                        );
                        if let Some(damaged) = verdict {
                            images.insert(name.clone(), damaged);
                        }
                    } else {
                        durations.insert(
                            name.clone(),
                            audio::duration(
                                std::io::Cursor::new(prefix).chain(&mut entry),
                                *size,
                                None,
                                cancel,
                            ),
                        );
                    }
                } else if matches!(
                    basename,
                    "ni" | "ri" | "si" | "li" | "ri.plain" | "si.plain" | "li.plain"
                ) {
                    if *size > JSON_LIMIT {
                        return Err("readLimitExceeded".into());
                    }
                    let mut b = Vec::new();
                    entry.read_to_end(&mut b).map_err(|e| e.to_string())?;
                    indexes.insert(name.clone(), b);
                }
                let mut buffer = [0; 65536];
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("cancelled".into());
                    }
                    let n = entry.read(&mut buffer).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                }
                if entry.limit() != 0 {
                    return Err("archiveCorrupt".into());
                }
            }
            Ok((durations, indexes, images, nested, descriptors))
        })?;
    for (name, size) in descriptors {
        let children = super::seven_zip::stream_member(path, &name, cancel, |reader| {
            super::stream_zip::buffered(reader, 1, true, cancel, &name, size)
        })?;
        nested.insert(name, children);
    }
    for out in observations {
        if cancel.load(Ordering::Relaxed) {
            return Err(Cancelled);
        }
        let nested_observation = nested.iter().find_map(|(archive, children)| {
            children.iter().find(|child| {
                out.member.as_deref()
                    == Some(
                        format!(
                            "{archive}{}",
                            child
                                .member
                                .as_ref()
                                .map(|m| format!("/{m}"))
                                .unwrap_or_default()
                        )
                        .as_str(),
                    )
            })
        });
        if let Some(child) = nested_observation {
            for pointer in LISTENING_FIELDS {
                let pointer = pointer.to_owned();
                if let Some(field) = child.fields.get(&pointer) {
                    out.fields.insert(pointer, field.clone());
                }
            }
            out.listening_pending = false;
            continue;
        }
        let root = out
            .member
            .as_ref()
            .map(|m| format!("{m}/"))
            .unwrap_or_default();
        if let Some(variant) = out.raw["variant"]
            .as_str()
            .and_then(fs::FsPackVariant::from_preview_name)
        {
            super::listening::fs(
                out,
                variant,
                variant == fs::FsPackVariant::Cleartext,
                |name, _| {
                    let b = super::listening::get_ignore_case(&indexes, &format!("{root}{name}"))
                        .ok_or("invalidPackStructure")?;
                    Ok((b.clone(), b.len() as u64))
                },
                cancel,
                |name, _| {
                    super::listening::get_ignore_case(&durations, &format!("{root}{name}"))
                        .copied()
                        .flatten()
                },
            );
        } else if let Some(stories) = super::listening::stories(&out.raw) {
            let sounds = stories
                .iter()
                .map(|(_, a)| a)
                .collect::<std::collections::BTreeSet<_>>();
            let duration = sounds.into_iter().try_fold(0.0, |total, a| {
                Some(total + durations.get(&format!("{root}assets/{a}"))?.as_ref()?)
            });
            super::listening::record(out, stories.len(), duration);
        }
        // Pictures are judged whether or not the stories could be classified.
        super::images::record(out, |a| images.get(&format!("{root}assets/{a}")).copied());
        out.listening_pending = false;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_failures_are_retried_and_archive_failures_settled() {
        let dir = std::env::temp_dir().join(format!("story-studio-solid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        struct Clean(std::path::PathBuf);
        impl Drop for Clean {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _clean = Clean(dir.clone());
        let cancel = AtomicBool::new(false);
        // The archive vanished or 7-Zip could not read it: the tool failed.
        let missing = dir.join("missing.7z");
        assert!(matches!(
            enrich(&missing, &mut [], &cancel),
            Err(ListeningFailure::Retry(_))
        ));
        // The archive's own bytes are wrong: settled, never extracted again.
        let corrupt = dir.join("corrupt.7z");
        std::fs::write(
            &corrupt,
            b"7z\xbc\xaf\x27\x1c\x00\x04garbage-garbage-garbage",
        )
        .unwrap();
        assert!(matches!(
            enrich(&corrupt, &mut [], &cancel),
            Err(ListeningFailure::Settled(_))
        ));
        // Cancelled: nothing is changed or published.
        let mut observations = vec![Observation::new("7z")];
        observations[0].listening_pending = true;
        assert_eq!(
            enrich(&corrupt, &mut observations, &AtomicBool::new(true)),
            Err(ListeningFailure::Cancelled)
        );
        assert!(observations[0].listening_pending);
    }
    #[test]
    fn a_silent_or_failing_tool_is_retried_not_settled() {
        let tool = crate::support::imported_pack::resolve_7z_path().unwrap();
        let mut command = Command::new(tool);
        // Unknown command: 7-Zip exits with an error and no archive data.
        command.arg("unknown-command");
        assert!(matches!(
            super::super::seven_zip::stream_child(command, &AtomicBool::new(false), |r| {
                let mut b = Vec::new();
                r.read_to_end(&mut b).map_err(|e| e.to_string())?;
                Ok(b)
            }),
            Err(ListeningFailure::Retry(_))
        ));
    }
}
