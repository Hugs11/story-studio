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
    map.get(short).map(|p| p.to_string_lossy().into_owned())
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
