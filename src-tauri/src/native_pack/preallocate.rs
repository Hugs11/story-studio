//! Préallocation des ids de stage natifs (Étape 2e).
//!
//! Construit la table `entryId → stageId` pour TOUT nœud référençable (menu/story/zip),
//! en PRÉFÉRANT le `nativeStageId` capturé à l'import (réutiliser l'UUID d'origine =
//! fidélité forte du round-trip), avec repli sur l'id projet (stable, unique).
//! Les `ref` ne possèdent pas de stage propre : ils ne sont pas dans la table — ils s'y résolvent.
//!
//! Fonction pure, NON branchée sur la génération : socle consommé à l'Étape 4 (résolution des refs).
#![allow(dead_code)]

use std::collections::HashMap;

use crate::domain::project::ProjectEntry;

/// `table[entry.id] = nativeStageId.unwrap_or(entry.id)` pour chaque entrée référençable,
/// en descendant dans les enfants des menus. Les entrées `ref` (et sans id) sont ignorées.
pub(crate) fn preallocate_stage_ids(entries: &[ProjectEntry]) -> HashMap<String, String> {
    let mut table = HashMap::new();
    collect(entries, &mut table);
    table
}

fn collect(entries: &[ProjectEntry], table: &mut HashMap<String, String>) {
    for entry in entries {
        if entry.entry_type != "ref" && !entry.id.trim().is_empty() {
            let stage_id = entry
                .native_stage_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(entry.id.as_str())
                .to_string();
            table.entry(entry.id.clone()).or_insert(stage_id);
        }
        collect(&entry.children, table);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        id: &str,
        entry_type: &str,
        native: Option<&str>,
        children: Vec<ProjectEntry>,
    ) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            entry_type: entry_type.to_string(),
            native_stage_id: native.map(str::to_string),
            children,
            ..Default::default()
        }
    }

    #[test]
    fn prefers_native_stage_id_when_present() {
        let table = preallocate_stage_ids(&[entry("story-1", "story", Some("native-uuid-1"), vec![])]);
        assert_eq!(table.get("story-1").map(String::as_str), Some("native-uuid-1"));
    }

    #[test]
    fn falls_back_to_entry_id_without_native() {
        let table = preallocate_stage_ids(&[entry("story-2", "story", None, vec![])]);
        assert_eq!(table.get("story-2").map(String::as_str), Some("story-2"));
    }

    #[test]
    fn maps_menus_and_children_but_skips_refs() {
        let table = preallocate_stage_ids(&[entry(
            "menu-1",
            "menu",
            Some("native-menu"),
            vec![
                entry("story-a", "story", None, vec![]),
                entry("ref-1", "ref", None, vec![]),
            ],
        )]);
        assert_eq!(table.get("menu-1").map(String::as_str), Some("native-menu"));
        assert_eq!(table.get("story-a").map(String::as_str), Some("story-a"));
        assert!(!table.contains_key("ref-1"), "une ref ne possède pas de stage propre");
    }

    #[test]
    fn ignores_blank_native_stage_id() {
        let table = preallocate_stage_ids(&[entry("story-3", "story", Some("  "), vec![])]);
        assert_eq!(table.get("story-3").map(String::as_str), Some("story-3"));
    }
}
