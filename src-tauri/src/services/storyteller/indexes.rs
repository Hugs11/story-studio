//! Binary layout from specification §4: little endian, 512 + 44*N.
use super::{failure, Result};
use crate::native_pack::{Presence, StoryDocument, Transition};
use std::collections::HashMap;

pub(super) struct Indexes {
    pub ni: Vec<u8>,
    pub li: Vec<u8>,
    pub images: Vec<String>,
    pub sounds: Vec<String>,
}
fn number(value: usize) -> Result<i32> {
    i32::try_from(value).map_err(failure)
}
fn put(bytes: &mut Vec<u8>, value: i32) {
    bytes.extend(value.to_le_bytes());
}
/// The short-file padding rule does not append a block to aligned files.
pub(super) fn pad(bytes: &mut Vec<u8>) {
    if bytes.len() < 512 {
        bytes.resize(bytes.len().div_ceil(16) * 16, 0);
    }
}
pub(super) fn media_index(count: usize) -> Result<Vec<u8>> {
    number(count)?;
    let mut bytes = Vec::new();
    for index in 0..count {
        bytes.extend(format!("000\\{index:08X}").as_bytes());
    }
    pad(&mut bytes);
    Ok(bytes)
}
fn asset_index(value: &Presence<String>, assets: &mut Vec<String>) -> Result<i32> {
    let Some(value) = value.value() else {
        return Ok(-1);
    };
    if value.is_empty() {
        return Err(failure("empty media reference"));
    }
    let index = assets
        .iter()
        .position(|known| known == value)
        .unwrap_or_else(|| {
            assets.push(value.clone());
            assets.len() - 1
        });
    number(index)
}

pub(super) fn encode(document: &StoryDocument) -> Result<Indexes> {
    // Entry first, retaining relative order of every other stage.
    let mut stages: Vec<_> = document.stage_nodes.iter().collect();
    let entry = stages
        .iter()
        .position(|s| s.is_square_one())
        .ok_or_else(|| failure("missing entry stage"))?;
    let first = stages.remove(entry);
    stages.insert(0, first);
    let stage_indexes: HashMap<_, _> = stages
        .iter()
        .enumerate()
        .map(|(i, s)| (s.uuid.as_str(), i))
        .collect();
    let mut li = Vec::new();
    let mut actions = HashMap::new();
    for action in &document.action_nodes {
        let start = number(li.len() / 4)?;
        let count = number(action.options.len())?;
        if count == 0 {
            return Err(failure("empty action"));
        }
        for target in &action.options {
            // null is the dialect's return to the entry screen.
            let index = match target.as_deref() {
                None => 0,
                Some(target) => *stage_indexes
                    .get(target)
                    .ok_or_else(|| failure("invalid action target"))?,
            };
            put(&mut li, number(index)?);
        }
        actions.insert(action.id.as_str(), (start, count));
    }
    let transition = |value: &Presence<Transition>, ni: &mut Vec<u8>| -> Result<()> {
        if let Some(t) = value.value() {
            let (start, count) = actions
                .get(t.action_node.as_str())
                .ok_or_else(|| failure("unknown action"))?;
            // -1 : à confirmer sur appareil (E6).
            let selected = i32::try_from(t.selection.to_dialect_index()).map_err(failure)?;
            if selected < -1 || selected >= *count {
                return Err(failure("option index out of range"));
            }
            for n in [*start, *count, selected] {
                put(ni, n);
            }
        } else {
            for _ in 0..3 {
                put(ni, -1);
            }
        }
        Ok(())
    };
    let mut ni = vec![0; 512];
    ni[0..2].copy_from_slice(&1u16.to_le_bytes());
    let version = u16::try_from(document.version.value().copied().unwrap_or(1)).map_err(failure)?;
    ni[2..4].copy_from_slice(&version.to_le_bytes());
    ni[4..8].copy_from_slice(&512u32.to_le_bytes());
    ni[8..12].copy_from_slice(&44u32.to_le_bytes());
    ni[12..16].copy_from_slice(&number(stages.len())?.to_le_bytes());
    ni[24] = 1;
    let mut images = Vec::new();
    let mut sounds = Vec::new();
    for stage in stages {
        put(&mut ni, asset_index(&stage.image, &mut images)?);
        // No sound uses the native sentinel; firmware confirmation is E6.
        let sound = if stage.audio.value().is_none_or(|r| r.trim().is_empty()) {
            -1
        } else {
            asset_index(&stage.audio, &mut sounds)?
        };
        put(&mut ni, sound);
        transition(&stage.ok_transition, &mut ni)?;
        transition(&stage.home_transition, &mut ni)?;
        let c = &stage.control_settings;
        for flag in [c.wheel(), c.ok(), c.home(), c.pause(), c.autoplay()] {
            ni.extend(u16::from(flag).to_le_bytes());
        }
        ni.extend(0u16.to_le_bytes());
    }
    ni[16..20].copy_from_slice(&number(images.len())?.to_le_bytes());
    ni[20..24].copy_from_slice(&number(sounds.len())?.to_le_bytes());
    pad(&mut li);
    Ok(Indexes {
        ni,
        li,
        images,
        sounds,
    })
}
