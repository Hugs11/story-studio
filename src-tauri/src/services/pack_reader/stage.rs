use std::collections::HashMap;
use std::path::PathBuf;

/// Extrait { autoplay, wheel, pause, ok, home } du controlSettings d'un stage.
pub(super) fn stage_controls(stage: &serde_json::Value) -> serde_json::Value {
    let cs = stage
        .get("controlSettings")
        .unwrap_or(&serde_json::Value::Null);
    let get = |k: &str, def: bool| cs.get(k).and_then(|v| v.as_bool()).unwrap_or(def);
    serde_json::json!({
        "autoplay": get("autoplay", false),
        "wheel":    get("wheel",    false),
        "pause":    get("pause",    false),
        "ok":       get("ok",       false),
        "home":     get("home",     false),
    })
}

/// Retourne le chemin sur disque d'un asset (ou None si absent/vide).
pub(super) fn resolve_asset(name: Option<&str>, map: &HashMap<String, PathBuf>) -> Option<String> {
    let name = name?.trim();
    if name.is_empty() {
        return None;
    }
    // Accepte aussi "assets/xxx.mp3" en plus de "xxx.mp3"
    let short = if let Some(s) = name.strip_prefix("assets/") {
        s
    } else {
        name
    };
    map.get(short).map(crate::support::paths::path_for_frontend)
}

pub(super) fn is_stage_autoplay(stage: &serde_json::Value) -> bool {
    stage
        .get("controlSettings")
        .and_then(|cs| cs.get("autoplay"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub(super) fn stage_uuid(stage: &serde_json::Value) -> Option<&str> {
    stage
        .get("uuid")
        .or_else(|| stage.get("id"))
        .and_then(|v| v.as_str())
        .filter(|value| !value.trim().is_empty())
}

/// Retrouve le nom éditable d'une histoire générée par Story Studio.
///
/// La génération nomme ses deux stages techniques `Titre - X` et `Histoire - X`.
/// On ne retire ces préfixes que lorsque la paire reconnue porte exactement le même
/// suffixe, afin de préserver les noms légitimes et les libellés génériques des packs tiers.
pub(super) fn imported_story_name<'a>(title_name: &'a str, play_name: &str) -> &'a str {
    let Some(title_suffix) = title_name.strip_prefix("Titre - ") else {
        return title_name;
    };
    let Some(play_suffix) = play_name.strip_prefix("Histoire - ") else {
        return title_name;
    };
    if !title_suffix.trim().is_empty() && title_suffix == play_suffix {
        title_suffix
    } else {
        title_name
    }
}

pub(super) fn stage_control_bool(stage: &serde_json::Value, key: &str, default: bool) -> bool {
    stage
        .get("controlSettings")
        .and_then(|cs| cs.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

/// Retourne les stage_id options d'une action.
pub(super) fn action_options(action: &serde_json::Value) -> Vec<&str> {
    action
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default()
}

/// Options de l'action liée au okTransition d'un stage.
pub(super) fn stage_action_options<'a>(
    stage: &serde_json::Value,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Vec<&'a str> {
    let action_id = stage
        .get("okTransition")
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str());
    match action_id.and_then(|id| actions.get(id)) {
        Some(a) => action_options(a),
        None => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_assets_cross_the_native_to_frontend_path_boundary() {
        let assets = HashMap::from([(
            "voice.mp3".to_string(),
            PathBuf::from(r"\\?\C:\Workspace Été\voice.mp3"),
        )]);
        assert_eq!(
            resolve_asset(Some("assets/voice.mp3"), &assets),
            Some(r"C:\Workspace Été\voice.mp3".to_string())
        );
    }

    #[test]
    fn generated_title_and_play_pair_restores_the_authoring_name() {
        assert_eq!(
            imported_story_name(
                "Titre - épisode 5, un réveil difficile",
                "Histoire - épisode 5, un réveil difficile"
            ),
            "épisode 5, un réveil difficile"
        );
    }

    #[test]
    fn unrelated_or_mismatched_stage_names_are_preserved() {
        assert_eq!(imported_story_name("Stage", "Stage"), "Stage");
        assert_eq!(
            imported_story_name("Titre de noblesse", "Histoire - Titre de noblesse"),
            "Titre de noblesse"
        );
        assert_eq!(
            imported_story_name("Titre - Episode 5", "Histoire - Episode 6"),
            "Titre - Episode 5"
        );
        assert_eq!(imported_story_name("Titre - ", "Histoire - "), "Titre - ");
    }
}
