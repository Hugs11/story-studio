//! A recipe supplies intent only. The archive supplies identity and media.
//! Every refusal is silent and leaves the existing importer in charge.
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::native_pack::recipe::{
    build_project_model, build_role_model, reconstruct, Entry, ProjectType, Recipe, FILE_NAME,
};

use super::extraction::resolve_zip_asset_name;
use super::stage::resolve_asset;
use super::validation::{validate_pack_asset_name, MAX_STORY_JSON_BYTES};

/// This exact resolver is used by classification and extraction.
pub(super) fn resolve(zip_path: &Path, pack: &Value) -> Option<Value> {
    let mut archive = zip::ZipArchive::new(File::open(zip_path).ok()?).ok()?;
    let mut recipe = {
        let entry = archive.by_name(FILE_NAME).ok()?;
        if entry.size() > MAX_STORY_JSON_BYTES {
            return None;
        }
        serde_json::from_reader::<_, Recipe>(entry.take(MAX_STORY_JSON_BYTES + 1)).ok()?
    };
    let (model, names) = build_role_model(&recipe)?;
    let generated = serde_json::to_value(model).ok()?;
    let pairing = pair(&generated, pack)?;
    let mut roles: HashMap<String, String> = HashMap::new();
    let mut digests = HashMap::new();
    for &(left, right) in &pairing {
        let a = &generated["stageNodes"][left];
        let b = &pack["stageNodes"][right];
        for field in ["audio", "image"] {
            match (a[field].as_str(), b[field].as_str()) {
                (None, None) => (),
                (Some(source), Some(actual)) => {
                    let short = actual.strip_prefix("assets/").unwrap_or(actual);
                    validate_pack_asset_name(&format!("assets/{short}")).ok()?;
                    let role = names.get(source)?;
                    // Several roles may use one file. A repeated role may use
                    // differently named files only when their CONTENT is equal.
                    if let Some(previous) = roles.get(role) {
                        if previous != short
                            && digest(&mut archive, previous, &mut digests)?
                                != digest(&mut archive, short, &mut digests)?
                        {
                            return None;
                        }
                    } else {
                        roles.insert(role.clone(), short.into());
                    }
                }
                _ => return None,
            }
        }
    }
    let restored_pack_name_ids = restore_pack_names(&mut recipe, &generated, pack, &pairing)?;
    let rebuilt = reconstruct(&recipe, |r| {
        Some(
            roles
                .get(r)
                .cloned()
                .unwrap_or_else(|| format!("recipe-inactive/{r}")),
        )
    })
    .ok()?;
    let mut value = serde_json::to_value(rebuilt).ok()?;
    // An inactive role has no observable media in the pack. Do not invent one.
    map_media(&mut value, &|s| {
        (!s.starts_with("recipe-inactive/")).then(|| s.to_owned())
    });
    // Real media sharing (or removal of inactive roles) can change topology.
    // Certify the final project with the same complete structural pairing.
    let final_project = serde_json::from_value(value.clone()).ok()?;
    let final_document = serde_json::to_value(build_project_model(&final_project)?).ok()?;
    pair(&final_document, pack)?;
    value["entries"] = value["rootEntries"].take();
    value["title"] = pack["title"].clone();
    value["packVersion"] = pack["version"].clone();
    value["packDescription"] = pack["description"].clone();
    for key in ["autoNext", "nightMode", "endMessageAutoplay"] {
        value[key] = value["globalOptions"][key].clone();
    }
    value["recipeReopened"] = json!(true);
    value["restoredPackNameIds"] = json!(restored_pack_name_ids);
    Some(value)
}

/// Probe the builder with unique names to identify each entry/step's screens and
/// their exact generated prefixes. This also covers combined story screens and
/// unnamed sequence steps without duplicating the builder's naming conventions.
fn restore_pack_names(
    recipe: &mut Recipe,
    generated: &Value,
    pack: &Value,
    pairing: &[(usize, usize)],
) -> Option<Vec<String>> {
    fn visit(entries: &mut [Entry], f: &mut impl FnMut(&mut String, String)) {
        for entry in entries {
            match entry {
                Entry::Menu(m) => {
                    f(&mut m.name, format!("recipe-{}", m.id));
                    visit(&mut m.children, f);
                }
                Entry::Story(s) => {
                    f(&mut s.name, format!("recipe-{}", s.id));
                    for step in &mut s.sequence {
                        f(&mut step.name, format!("recipe-{}/step-{}", s.id, step.id));
                    }
                    if let Some(step) = &mut s.home_step {
                        f(&mut step.name, format!("recipe-{}/step-{}", s.id, step.id));
                    }
                }
            }
        }
    }
    let mut marked = recipe.clone();
    let mut markers = Vec::new();
    visit(&mut marked.entries, &mut |name, _| {
        *name = format!("recipe-name-{}-marker", markers.len());
        markers.push(name.clone());
    });
    let (model, _) = build_role_model(&marked)?;
    let model = serde_json::to_value(model).ok()?;
    let marked_pairing: HashMap<_, _> = pair(generated, &model)?.into_iter().collect();
    let mut replacements = HashMap::new();
    // Use model order so multiple renamed screens for one story have a stable
    // precedence, independent of pack array order and the traversal's HashMap.
    let mut pairing = pairing.to_vec();
    pairing.sort_unstable();
    for (left, right) in pairing {
        let Some(actual) = pack["stageNodes"][right]["name"].as_str() else {
            continue;
        };
        if actual.trim().is_empty() || generated["stageNodes"][left]["name"] == actual {
            continue;
        }
        let template = model["stageNodes"][marked_pairing[&left]]["name"].as_str()?;
        // builder/root.rs gives the sole Simple story a fixed screen name.
        if recipe.project_type == ProjectType::Simple && template == "histoire" {
            replacements.entry(0).or_insert_with(|| actual.to_owned());
        }
        for (index, marker) in markers.iter().enumerate() {
            if let Some((prefix, suffix)) = template.split_once(marker) {
                let name = actual
                    .strip_prefix(prefix)
                    .and_then(|s| s.strip_suffix(suffix))
                    .unwrap_or(actual);
                if !name.trim().is_empty() {
                    replacements.entry(index).or_insert_with(|| name.to_owned());
                }
                break;
            }
        }
    }
    let mut index = 0;
    let mut restored_ids = Vec::new();
    visit(&mut recipe.entries, &mut |name, id| {
        if let Some(actual) = replacements.remove(&index) {
            *name = actual;
            restored_ids.push(id);
        }
        index += 1;
    });
    Some(restored_ids)
}

fn digest(
    archive: &mut zip::ZipArchive<File>,
    name: &str,
    cache: &mut HashMap<String, Vec<u8>>,
) -> Option<Vec<u8>> {
    if let Some(d) = cache.get(name) {
        return Some(d.clone());
    }
    let name_in_zip = resolve_zip_asset_name(archive, &format!("assets/{name}"));
    let mut entry = archive.by_name(&name_in_zip).ok()?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = entry.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let bytes = hash.finalize().to_vec();
    cache.insert(name.into(), bytes.clone());
    Some(bytes)
}

/// Strict paired traversal, with inverse maps for BOTH stages and actions.
/// Names, IDs and media identities are intentionally not structural evidence.
fn pair(a: &Value, b: &Value) -> Option<Vec<(usize, usize)>> {
    if a["nightModeAvailable"] != b["nightModeAvailable"] {
        return None;
    }
    let arrays = ["stageNodes", "actionNodes"];
    let keys = ["uuid", "id"];
    let mut indexes = Vec::new();
    for doc in [a, b] {
        let mut kinds = Vec::new();
        for (array, key) in arrays.iter().zip(keys) {
            let nodes = doc[*array].as_array()?;
            let mut index = HashMap::new();
            for (i, n) in nodes.iter().enumerate() {
                if index.insert(n[key].as_str()?, i).is_some() {
                    return None;
                }
            }
            kinds.push(index);
        }
        indexes.push(kinds);
    }
    let entry = |d: &Value| {
        let entries: Vec<_> = d["stageNodes"]
            .as_array()?
            .iter()
            .enumerate()
            .filter(|(_, s)| s["squareOne"] == true)
            .map(|(i, _)| i)
            .collect();
        (entries.len() == 1).then(|| entries[0])
    };
    let mut queue = VecDeque::from([(0, entry(a)?, entry(b)?)]);
    let mut forward = HashMap::new();
    let mut reverse = HashMap::new();
    while let Some((kind, left, right)) = queue.pop_front() {
        if let Some(previous) = forward.get(&(kind, left)) {
            if *previous != right {
                return None;
            }
            continue;
        }
        if reverse.insert((kind, right), left).is_some() {
            return None;
        }
        forward.insert((kind, left), right);
        let x = &a[arrays[kind]][left];
        let y = &b[arrays[kind]][right];
        if kind == 1 {
            let xo = x["options"].as_array()?;
            let yo = y["options"].as_array()?;
            if xo.len() != yo.len() {
                return None;
            }
            for (u, v) in xo.iter().zip(yo) {
                queue.push_back((
                    0,
                    *indexes[0][0].get(u.as_str()?)?,
                    *indexes[1][0].get(v.as_str()?)?,
                ));
            }
        } else {
            for field in ["controlSettings", "squareOne", "type"] {
                if x[field] != y[field] {
                    return None;
                }
            }
            for field in ["okTransition", "homeTransition"] {
                match (x[field].as_object(), y[field].as_object()) {
                    (None, None) => (),
                    (Some(_), Some(_)) => {
                        if x[field]["optionIndex"] != y[field]["optionIndex"] {
                            return None;
                        }
                        queue.push_back((
                            1,
                            *indexes[0][1].get(x[field]["actionNode"].as_str()?)?,
                            *indexes[1][1].get(y[field]["actionNode"].as_str()?)?,
                        ));
                    }
                    _ => return None,
                }
            }
        }
    }
    for (kind, array) in arrays.iter().enumerate() {
        let count = forward.keys().filter(|(k, _)| *k == kind).count();
        if [a, b]
            .iter()
            .any(|d| d[*array].as_array().map(Vec::len) != Some(count))
        {
            return None;
        }
    }
    Some(
        forward
            .into_iter()
            .filter_map(|((k, l), r)| (k == 0).then_some((l, r)))
            .collect(),
    )
}

pub(super) fn extract_media(value: &mut Value, assets: &HashMap<String, PathBuf>) {
    map_media(value, &|name| resolve_asset(Some(name), assets));
}

fn map_media(value: &mut Value, resolve: &impl Fn(&str) -> Option<String>) {
    fn visit(v: &mut Value, resolve: &impl Fn(&str) -> Option<String>) {
        match v {
            Value::Array(a) => a.iter_mut().for_each(|v| visit(v, resolve)),
            Value::Object(o) => {
                for (key, v) in o {
                    if matches!(
                        key.as_str(),
                        "audio"
                            | "image"
                            | "itemAudio"
                            | "itemImage"
                            | "rootAudio"
                            | "rootImage"
                            | "nightModeAudio"
                            | "afterPlaybackPromptAudio"
                    ) {
                        *v = json!(v.as_str().and_then(resolve));
                    } else {
                        visit(v, resolve);
                    }
                }
            }
            _ => (),
        }
    }
    visit(value, resolve);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> Value {
        let controls = json!({"wheel":false,"ok":true,"home":true,"pause":false,"autoplay":false});
        json!({"nightModeAvailable":false,"stageNodes":[
            {"uuid":"entry","squareOne":true,"type":"stage","controlSettings":controls,
             "okTransition":{"actionNode":"choices","optionIndex":-1}},
            {"uuid":"a","squareOne":false,"type":"stage","controlSettings":controls,
             "homeTransition":{"actionNode":"choices","optionIndex":1}},
            {"uuid":"b","squareOne":false,"type":"stage","controlSettings":controls,
             "okTransition":{"actionNode":"choices","optionIndex":0}}
        ],"actionNodes":[{"id":"choices","options":["a","b"]}]})
    }

    #[test]
    fn paired_traversal_is_complete_and_preserves_random_selection() {
        let reference = graph();
        let mut changed = reference.clone();
        changed["stageNodes"].as_array_mut().unwrap().reverse();
        assert_eq!(pair(&reference, &changed).unwrap().len(), 3);
        for mutation in [
            "random",
            "controls",
            "night",
            "option",
            "target",
            "unreachable",
            "alias",
            "duplicate",
        ] {
            let mut changed = reference.clone();
            match mutation {
                "random" => changed["stageNodes"][0]["okTransition"]["optionIndex"] = json!(0),
                "controls" => changed["stageNodes"][1]["controlSettings"]["pause"] = json!(true),
                "night" => changed["nightModeAvailable"] = json!(true),
                "option" => {
                    changed["actionNodes"][0]["options"]
                        .as_array_mut()
                        .unwrap()
                        .pop();
                }
                "target" => changed["stageNodes"][1]["homeTransition"]["optionIndex"] = json!(0),
                "unreachable" => changed["actionNodes"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":"orphan","options":[]})),
                "alias" => changed["actionNodes"][0]["options"][1] = json!("a"),
                "duplicate" => {
                    let duplicate = changed["stageNodes"][1].clone();
                    changed["stageNodes"]
                        .as_array_mut()
                        .unwrap()
                        .push(duplicate);
                }
                _ => unreachable!(),
            }
            assert!(pair(&reference, &changed).is_none(), "{mutation}");
        }
    }
}
