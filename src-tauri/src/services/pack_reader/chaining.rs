//! Helpers de chainage / linearisation utilises pendant la projection.
//!
//! Extraits de `projection.rs` pour reduire la surface du fichier orchestrateur
//! et permettre des tests unitaires futurs.

use std::collections::{HashMap, HashSet};

use super::stage::{is_stage_autoplay, stage_action_options};

/// Replie une chaine d'intro lineaire (autoplay) devant un menu de contenu.
///
/// Si `content_entries` contient exactement un seul menu, on imbrique les
/// intros en cascade pour preserver la sequence narrative tout en gardant
/// la racine "menu". Sinon, on concatene simplement les intros devant.
pub(super) fn chain_intro_entries_before_content(
    intro_entries: Vec<serde_json::Value>,
    mut content_entries: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    if intro_entries.is_empty() {
        return content_entries;
    }

    if content_entries.len() != 1
        || content_entries[0].get("type").and_then(|v| v.as_str()) != Some("menu")
    {
        let mut all = intro_entries;
        all.extend(content_entries);
        return all;
    }

    let mut next = content_entries.pop().unwrap_or(serde_json::Value::Null);

    for intro in intro_entries.into_iter().rev() {
        let audio = intro
            .get("audio")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let control_settings = intro
            .get("controlSettings")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        next = serde_json::json!({
            "id": intro.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "type": "menu",
            "name": intro.get("name").cloned().unwrap_or_else(|| serde_json::json!("Intro")),
            "audio": audio,
            "image": serde_json::Value::Null,
            "autoBlackImage": true,
            "controlSettings": control_settings,
            "children": [next],
        });
    }

    vec![next]
}

/// Suit la chaine single-option jusqu'au premier stage ayant 0 ou N>=2 options,
/// ou jusqu'au premier stage autoplay (qui est lui-meme le stage de lecture).
pub(super) fn chase_single_chain(
    start_id: &str,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    visited: &mut HashSet<String>,
) -> String {
    let mut current = start_id.to_string();
    loop {
        let stage = match stages.get(current.as_str()) {
            Some(s) => s,
            None => return current,
        };
        // Un stage autoplay est un stage de lecture -- ne pas traverser.
        if is_stage_autoplay(stage) {
            return current;
        }
        let opts = stage_action_options(stage, actions);
        if opts.len() != 1 {
            return current;
        }
        let next_id = opts[0];
        if visited.contains(next_id) {
            return current;
        }
        visited.insert(next_id.to_string());
        current = next_id.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_intro_returns_content_when_intros_empty() {
        let content = vec![serde_json::json!({ "type": "story", "name": "A" })];
        let result = chain_intro_entries_before_content(vec![], content.clone());
        assert_eq!(result, content);
    }

    #[test]
    fn chain_intro_nests_intros_in_front_of_single_menu() {
        let intros = vec![serde_json::json!({
            "id": "intro-1",
            "name": "Intro",
            "audio": "intro.mp3",
            "controlSettings": { "ok": true },
        })];
        let content = vec![serde_json::json!({
            "id": "menu-1",
            "type": "menu",
            "name": "Menu",
            "children": [],
        })];
        let result = chain_intro_entries_before_content(intros, content);
        assert_eq!(result.len(), 1);
        let root = &result[0];
        assert_eq!(root.get("id").unwrap(), "intro-1");
        assert_eq!(root.get("type").unwrap(), "menu");
        assert_eq!(root.get("audio").unwrap(), "intro.mp3");
        let children = root.get("children").unwrap().as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].get("id").unwrap(), "menu-1");
    }

    #[test]
    fn chain_intro_appends_when_content_is_not_a_single_menu() {
        let intros = vec![serde_json::json!({ "id": "intro-1", "name": "Intro" })];
        let content = vec![
            serde_json::json!({ "id": "story-1", "type": "story" }),
            serde_json::json!({ "id": "story-2", "type": "story" }),
        ];
        let result = chain_intro_entries_before_content(intros, content);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].get("id").unwrap(), "intro-1");
        assert_eq!(result[1].get("id").unwrap(), "story-1");
    }
}
