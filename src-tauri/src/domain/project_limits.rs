use crate::support::user_message;
use std::sync::OnceLock;
use user_message::UserMessage;

use serde::Deserialize;

use crate::domain::project::{Project, ProjectEntry};

const PROJECT_LIMITS_JSON: &str = include_str!("../../../src/shared/projectLimits.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectLimits {
    max_menu_depth: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct MenuDepthDiagnostic {
    pub(crate) observed_depth: usize,
    pub(crate) path: Vec<String>,
}

pub(crate) fn max_menu_depth() -> usize {
    static MAX_MENU_DEPTH: OnceLock<usize> = OnceLock::new();
    *MAX_MENU_DEPTH.get_or_init(|| {
        let limits: ProjectLimits = serde_json::from_str(PROJECT_LIMITS_JSON)
            .expect("src/shared/projectLimits.json doit être un JSON valide");
        assert!(
            limits.max_menu_depth > 0,
            "maxMenuDepth doit être strictement positif"
        );
        limits.max_menu_depth
    })
}

pub(crate) fn project_menu_depth_error(observed_depth: usize) -> String {
    UserMessage::new("VALIDATION_MENU_DEPTH_LIMIT")
        .param("observedDepth", observed_depth)
        .param("maxDepth", max_menu_depth())
        .into_transport()
}

pub(crate) fn project_menu_depth_diagnostic(
    project: &Project,
) -> Result<MenuDepthDiagnostic, MenuDepthDiagnostic> {
    let mut stack: Vec<(&ProjectEntry, usize, Vec<String>)> = project
        .root_entries
        .iter()
        .chain(project.shared_entries.iter())
        .rev()
        .map(|entry| (entry, 0, Vec::new()))
        .collect();
    let mut deepest = MenuDepthDiagnostic {
        observed_depth: 0,
        path: Vec::new(),
    };

    while let Some((entry, parent_depth, menu_path)) = stack.pop() {
        let is_menu = entry.entry_type == "menu";
        let depth = parent_depth + usize::from(is_menu);
        let next_path = if is_menu {
            let mut path = menu_path;
            path.push(if entry.name.trim().is_empty() {
                entry.id.clone()
            } else {
                entry.name.trim().to_string()
            });
            path
        } else {
            menu_path
        };

        if depth > deepest.observed_depth {
            deepest = MenuDepthDiagnostic {
                observed_depth: depth,
                path: next_path.clone(),
            };
        }

        if is_menu {
            for child in entry.children.iter().rev() {
                stack.push((child, depth, next_path.clone()));
            }
        }
    }

    if deepest.observed_depth > max_menu_depth() {
        Err(deepest)
    } else {
        Ok(deepest)
    }
}

pub(crate) fn validate_project_menu_depth(project: &Project) -> Result<(), String> {
    project_menu_depth_diagnostic(project)
        .map(|_| ())
        .map_err(|diagnostic| project_menu_depth_error(diagnostic.observed_depth))
}

/// Type de l'ancien nœud Lien, essai jamais publié retiré du modèle. Un projet qui
/// en contient encore un relève de l'éditeur graphe : il est refusé tel quel, sans
/// retrait silencieux ni conversion.
const LEGACY_LINK_ENTRY_TYPE: &str = "ref";

fn contains_legacy_link_entry(entries: &[ProjectEntry]) -> bool {
    entries.iter().any(|entry| {
        entry.entry_type == LEGACY_LINK_ENTRY_TYPE || contains_legacy_link_entry(&entry.children)
    })
}

/// Refus commun à tout projet par menus qui entre dans Rust (`parse_project_json`) ;
/// l'ouverture côté interface applique le même refus avant toute normalisation.
pub(crate) fn validate_project_has_no_legacy_link(project: &Project) -> Result<(), String> {
    if contains_legacy_link_entry(&project.root_entries)
        || contains_legacy_link_entry(&project.shared_entries)
    {
        return Err(
            UserMessage::new(user_message::codes::IMPORT_PROJECT_LEGACY_LINK_UNSUPPORTED)
                .into_transport(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::project::{AudioEdgeSilenceDuration, GlobalOptions};

    fn nested_project(depth: usize) -> Project {
        let mut child = ProjectEntry {
            id: "story".to_string(),
            entry_type: "story".to_string(),
            name: "Histoire".to_string(),
            ..ProjectEntry::default()
        };
        for level in (1..=depth).rev() {
            child = ProjectEntry {
                id: format!("folder-{level}"),
                entry_type: "menu".to_string(),
                name: format!("Dossier {level}"),
                children: vec![child],
                ..ProjectEntry::default()
            };
        }
        Project {
            name: "Profondeur".to_string(),
            project_type: Some("pack".to_string()),
            root_audio: None,
            root_image: None,
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            pack_version: 1,
            pack_description: String::new(),
            official_provenance: Default::default(),
            official_origin_uuid: None,
            contains_official_content: false,
            pack_uuid: String::new(),
            root_entries: vec![child],
            shared_entries: Vec::new(),
            global_options: GlobalOptions {
                add_silence: false,
                silence_mode: None,
                add_silence_duration_sec: AudioEdgeSilenceDuration::uniform(0.4),
                auto_next: false,
                night_mode: false,
                end_message_autoplay: true,
                harmonize_loudness: true,
            },
        }
    }

    #[test]
    fn shared_limit_is_loaded_from_the_frontend_source() {
        let source: serde_json::Value =
            serde_json::from_str(PROJECT_LIMITS_JSON).expect("shared limits");
        assert_eq!(
            max_menu_depth(),
            source["maxMenuDepth"].as_u64().expect("maxMenuDepth") as usize
        );
        assert_eq!(max_menu_depth(), 61);
    }

    #[test]
    fn sixty_one_folders_are_accepted_and_sixty_two_are_rejected() {
        let accepted = project_menu_depth_diagnostic(&nested_project(max_menu_depth()))
            .expect("la profondeur limite doit être acceptée");
        assert_eq!(accepted.observed_depth, max_menu_depth());

        let rejected = nested_project(max_menu_depth() + 1);
        let diagnostic = project_menu_depth_diagnostic(&rejected)
            .expect_err("un niveau supplémentaire doit être refusé");
        assert_eq!(diagnostic.observed_depth, max_menu_depth() + 1);
        assert_eq!(diagnostic.path.len(), max_menu_depth() + 1);
        assert_eq!(
            validate_project_menu_depth(&rejected),
            Err(project_menu_depth_error(max_menu_depth() + 1))
        );
    }

    #[test]
    fn a_project_holding_a_legacy_link_is_refused_even_nested() {
        let mut nested = nested_project(3);
        assert!(validate_project_has_no_legacy_link(&nested).is_ok());

        let mut folder = &mut nested.root_entries[0];
        while !folder.children[0].children.is_empty() {
            folder = &mut folder.children[0];
        }
        folder.children.push(ProjectEntry {
            id: "lien".to_string(),
            entry_type: "ref".to_string(),
            ..ProjectEntry::default()
        });
        let error = validate_project_has_no_legacy_link(&nested).expect_err("lien refusé");
        assert!(user_message::contains_code(
            &error,
            "IMPORT_PROJECT_LEGACY_LINK_UNSUPPORTED"
        ));

        let mut shared = nested_project(1);
        shared.shared_entries.push(ProjectEntry {
            id: "lien".to_string(),
            entry_type: "ref".to_string(),
            ..ProjectEntry::default()
        });
        assert!(validate_project_has_no_legacy_link(&shared).is_err());
    }

    #[test]
    fn parsing_a_project_json_refuses_a_legacy_link() {
        let with_link = serde_json::json!({
            "name": "Ancien",
            "projectType": "pack",
            "rootEntries": [{"id": "m", "type": "menu", "name": "Dossier", "children": [
                {"id": "s", "type": "story", "name": "Histoire"},
                {"id": "r", "type": "ref", "target": "story:s", "refKind": "return"}
            ]}],
            "globalOptions": {"autoNext": false, "nightMode": false}
        });
        let error = crate::commands::generation::parse_project_json(&with_link.to_string())
            .err()
            .expect("refus");
        assert!(user_message::contains_code(
            &error,
            "IMPORT_PROJECT_LEGACY_LINK_UNSUPPORTED"
        ));

        let mut without_link = with_link.clone();
        without_link["rootEntries"][0]["children"]
            .as_array_mut()
            .expect("children")
            .pop();
        crate::commands::generation::parse_project_json(&without_link.to_string())
            .expect("un projet sans lien se lit");
    }
}
