//! Recognition rules and example cases adapted from STUdio Perso
//! web-ui/javascript/src/utils/agePrefix.js and agePrefix.test.js (MPL-2.0).
//! This file is subject to the Mozilla Public License, v. 2.0.
//! https://mozilla.org/MPL/2.0/
use std::collections::BTreeSet;

pub fn extract_bounds(name: &str) -> Option<(Option<u8>, Option<u8>)> {
    let mut value = name.trim_start();
    if let Some(after) = value.strip_prefix('[') {
        if let Some((marker, rest)) = after.split_once(']') {
            if matches!(marker.to_ascii_lowercase().as_str(), "fr" | "fr_fr" | "it") {
                value = rest.trim_start();
            }
        }
    }
    value = value.strip_prefix('[').unwrap_or(value).trim_start();
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    let min = if digits == 0 {
        None
    } else {
        Some(value[..digits].parse::<u8>().ok()?)
    };
    let tail = value[digits..].trim_start();
    let (max, tail) = if let Some(after) = tail.strip_prefix('-') {
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        (
            Some(after[..digits].parse::<u8>().ok()?),
            after[digits..].trim_start(),
        )
    } else {
        (None, tail)
    };
    if min.is_none() && max.is_none()
        || min.is_some_and(|a| a > 18)
        || max.is_some_and(|a| a > 18)
        || min.zip(max).is_some_and(|(a, b)| a > b)
    {
        return None;
    }
    let rest = tail.strip_prefix('+')?;
    if rest.starts_with('+') || rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    Some((min, max))
}
pub fn extract(name: &str) -> Option<u8> {
    extract_bounds(name)?.0
}

/// None is unknown; conflicting candidates remain separate for the caller.
pub fn candidates<'a>(names: impl Iterator<Item = &'a str>) -> BTreeSet<u8> {
    names.filter_map(extract).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefixes() {
        for (name, expected) in [
            ("3+] Titre.zip", 3),
            ("[3+] Titre.zip", 3),
            ("5+Hector.zip", 5),
            ("7+Kéra-Kid.7z", 7),
            ("[IT] 5+Lisa e Leo.7z", 5),
            ("7 + Titre.zip", 7),
            (" [fr_FR] [0+] Titre.mbah", 0),
            ("18+Titre", 18),
        ] {
            assert_eq!(extract(name), Some(expected), "{name}");
        }
        for name in ["3+4", "3++", "Titre 3+]", "3 ans Titre", "19+]", "-3+Titre"] {
            assert_eq!(extract(name), None, "{name}");
        }
        assert_eq!(
            candidates(["3+Titre", "5+Titre", "Titre"].into_iter()).len(),
            2
        );
    }
}
