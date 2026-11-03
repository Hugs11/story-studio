//! Filename cleaning adapted from STUdio Perso PackNameCleaner (MPL-2.0).
//! This file is subject to the Mozilla Public License, v. 2.0.
//! https://mozilla.org/MPL/2.0/
use super::super::{age_prefix, data::mutate::names::normalize};
fn strip_prefix(text: &str) -> &str {
    if age_prefix::extract_bounds(text).is_some() {
        if let Some((_, rest)) = text.split_once('+') {
            return rest.trim_start_matches([' ', '\t', ']']);
        }
    }
    text
}
pub fn clean(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let mut text = base;
    if let Some((stem, ext)) = base.rsplit_once('.') {
        if matches!(
            ext.to_ascii_lowercase().as_str(),
            "zip" | "7z" | "studio" | "pk" | "json" | "mbah"
        ) {
            text = stem;
        }
    }
    text = strip_prefix(text).trim();
    let digits = text.bytes().rev().take_while(u8::is_ascii_digit).count();
    if digits >= 9 {
        let prefix = &text[..text.len() - digits];
        if prefix.ends_with(['-', '_', ' ']) {
            text = prefix[..prefix.len() - 1].trim();
        }
    }
    if let Some((left, right)) = text.split_once(" - ") {
        let left = strip_prefix(left).trim();
        let right = strip_prefix(right).trim();
        if !left.is_empty() && normalize(left) == normalize(right) {
            text = left;
        }
    }
    let out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.is_empty() {
        base.to_owned()
    } else {
        out
    }
}
