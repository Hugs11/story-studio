use crate::domain::project::{Project, ProjectEntry};
use crate::services::project_files::{validate_existing_file_path, validate_existing_pack_path};
use std::collections::{HashMap, HashSet};

fn required_file_path<'a>(
    value: Option<&'a str>,
    label: &str,
    errors: &mut Vec<String>,
) -> Option<&'a str> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(path) => Some(path),
        None => {
            errors.push(format!("{} manquant.", label));
            None
        }
    }
}

fn display_label(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Clone, Copy)]
enum FileValidation {
    CheckDisk,
    StructureOnly,
}

impl FileValidation {
    fn checks_disk(self) -> bool {
        matches!(self, FileValidation::CheckDisk)
    }
}

fn validate_story_entry_for_generation(
    entry: &ProjectEntry,
    context: &str,
    file_validation: FileValidation,
    errors: &mut Vec<String>,
) {
    let explicit_title_stage = entry.silent_title_stage;
    match entry.entry_type.as_str() {
        "zip" => {
            let zip_label = format!("{} : ZIP", context);
            if let Some(zip_path) =
                required_file_path(entry.zip_path.as_deref(), &zip_label, errors)
            {
                if file_validation.checks_disk() {
                    if let Err(err) = validate_existing_pack_path(zip_path) {
                        errors.push(err);
                    }
                }
            }
        }
        _ => {
            let story_audio_label = format!("{} : audio", context);
            if let Some(audio_path) =
                required_file_path(entry.audio.as_deref(), &story_audio_label, errors)
            {
                if file_validation.checks_disk() {
                    if let Err(err) = validate_existing_file_path(audio_path, &story_audio_label) {
                        errors.push(err);
                    }
                }
            }
            let item_audio_label = format!("{} : audio titre", context);
            if let Some(item_audio) = entry
                .item_audio
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if file_validation.checks_disk() {
                    if let Err(err) = validate_existing_file_path(item_audio, &item_audio_label) {
                        errors.push(err);
                    }
                }
            } else if !explicit_title_stage {
                errors.push(format!("{} manquant.", item_audio_label));
            }

            let item_image_label = format!("{} : image", context);
            if let Some(item_image) = entry
                .item_image
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if file_validation.checks_disk() {
                    if let Err(err) = validate_existing_file_path(item_image, &item_image_label) {
                        errors.push(err);
                    }
                }
            } else {
                errors.push(format!("{} manquant.", item_image_label));
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NavigationTarget<'a> {
    Root,
    CurrentMenu,
    NextStory,
    Menu(&'a str),
    Story(&'a str),
    StoryPlay(&'a str),
    StoryHomeStep(&'a str),
}

struct NavigationValidationContext<'a> {
    menu_ids: &'a HashSet<String>,
    menu_playable_counts: &'a HashMap<String, usize>,
    story_ids: &'a HashSet<String>,
    story_home_step_ids: &'a HashSet<String>,
}

fn decode_navigation_target(target: &str) -> Option<NavigationTarget<'_>> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "root" {
        return Some(NavigationTarget::Root);
    }
    if trimmed == "current_menu" {
        return Some(NavigationTarget::CurrentMenu);
    }
    if trimmed == "next_story" {
        return Some(NavigationTarget::NextStory);
    }
    if let Some(id) = trimmed.strip_prefix("menu:") {
        let id = id.trim();
        return (!id.is_empty()).then_some(NavigationTarget::Menu(id));
    }
    if let Some(id) = trimmed.strip_prefix("story_home_step:") {
        let id = id.trim();
        return (!id.is_empty()).then_some(NavigationTarget::StoryHomeStep(id));
    }
    if let Some(id) = trimmed.strip_prefix("story_play:") {
        let id = id.trim();
        return (!id.is_empty()).then_some(NavigationTarget::StoryPlay(id));
    }
    if let Some(id) = trimmed.strip_prefix("story:") {
        let id = id.trim();
        return (!id.is_empty()).then_some(NavigationTarget::Story(id));
    }
    Some(NavigationTarget::Menu(trimmed))
}

fn validate_navigation_target(
    target: Option<&str>,
    entry_name: &str,
    target_label: &str,
    graph: &NavigationValidationContext<'_>,
    errors: &mut Vec<String>,
) {
    let Some(decoded) = target.and_then(decode_navigation_target) else {
        return;
    };
    match decoded {
        NavigationTarget::Root | NavigationTarget::CurrentMenu | NavigationTarget::NextStory => {}
        NavigationTarget::Menu(target_id) => {
            if !graph.menu_ids.contains(target_id) {
                errors.push(format!("{entry_name} : {target_label} est introuvable."));
            } else if graph
                .menu_playable_counts
                .get(target_id)
                .copied()
                .unwrap_or(0)
                == 0
            {
                errors.push(format!(
                    "{entry_name} : {target_label} est vide ou non jouable."
                ));
            }
        }
        NavigationTarget::Story(target_id) | NavigationTarget::StoryPlay(target_id) => {
            if !graph.story_ids.contains(target_id) {
                errors.push(format!("{entry_name} : {target_label} est introuvable."));
            }
        }
        NavigationTarget::StoryHomeStep(target_id) => {
            if !graph.story_ids.contains(target_id) {
                errors.push(format!("{entry_name} : {target_label} est introuvable."));
            } else if !graph.story_home_step_ids.contains(target_id) {
                errors.push(format!("{entry_name} : retour de fin introuvable."));
            }
        }
    }
}

fn is_preserved_native_helper_shared_entry(entry: &ProjectEntry) -> bool {
    let Some(controls) = entry.control_settings.as_ref() else {
        return false;
    };
    entry.entry_type == "menu"
        && entry
            .native_stage_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        && entry
            .audio
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        && entry
            .image
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        && entry.auto_black_image
        && controls.wheel == Some(false)
        && controls.ok == Some(true)
        && controls.home == Some(true)
        && controls.pause == Some(false)
        && controls.autoplay == Some(true)
        && entry.children.len() == 1
        && entry.children[0].entry_type == "ref"
}

/// Id d'entrée ciblé par une `ref` (menu:/story:/story_play:/story_home_step:), ou None.
fn decode_ref_target_entry_id(target: &str) -> Option<&str> {
    match decode_navigation_target(target)? {
        NavigationTarget::Menu(id)
        | NavigationTarget::Story(id)
        | NavigationTarget::StoryPlay(id)
        | NavigationTarget::StoryHomeStep(id) => Some(id),
        NavigationTarget::Root | NavigationTarget::CurrentMenu | NavigationTarget::NextStory => {
            None
        }
    }
}

pub(crate) fn project_root_entries(project: &Project) -> Vec<ProjectEntry> {
    let mut entries = project.root_entries.clone();
    normalize_imported_continuation_clones(&mut entries);
    entries
}

pub(crate) fn project_shared_entries(project: &Project) -> Vec<ProjectEntry> {
    let mut entries = project.shared_entries.clone();
    normalize_imported_continuation_clones(&mut entries);
    entries
}

fn is_imported_continuation_menu(entry: &ProjectEntry) -> bool {
    entry.entry_type == "menu"
        && entry.id.contains("-sequence-choice-")
        && entry.name.trim_start().starts_with("Suite apres")
}

fn normalize_imported_continuation_clones(entries: &mut [ProjectEntry]) {
    for entry in entries {
        if entry.entry_type == "menu" {
            if is_imported_continuation_menu(entry) {
                prefix_continuation_children(entry);
            }
            normalize_imported_continuation_clones(&mut entry.children);
        }
    }
}

fn prefix_continuation_children(menu: &mut ProjectEntry) {
    let prefix = menu.id.clone();
    let mut id_map = HashMap::new();
    for child in &menu.children {
        collect_continuation_id_map(child, &prefix, &mut id_map);
    }
    if id_map.is_empty() {
        return;
    }
    for child in &mut menu.children {
        apply_continuation_id_map(child, &id_map);
    }
}

fn collect_continuation_id_map(
    entry: &ProjectEntry,
    prefix: &str,
    id_map: &mut HashMap<String, String>,
) {
    let id = entry.id.trim();
    if !id.is_empty() && !id.starts_with(&format!("{prefix}-")) {
        id_map.insert(id.to_string(), format!("{prefix}-{id}"));
    }
    for child in &entry.children {
        collect_continuation_id_map(child, prefix, id_map);
    }
}

fn rewrite_prefixed_navigation_target(
    value: &mut Option<String>,
    id_map: &HashMap<String, String>,
) {
    let Some(target) = value.as_deref() else {
        return;
    };
    let target = target.trim();
    for prefix in ["story_home_step:", "story_play:", "story:", "menu:"] {
        if let Some(id) = target.strip_prefix(prefix) {
            if let Some(new_id) = id_map.get(id) {
                *value = Some(format!("{prefix}{new_id}"));
            }
            return;
        }
    }
    if let Some(new_id) = id_map.get(target) {
        *value = Some(new_id.clone());
    }
}

fn rewrite_prefixed_navigation_target_value(value: &mut String, id_map: &HashMap<String, String>) {
    let mut rewritten = Some(std::mem::take(value));
    rewrite_prefixed_navigation_target(&mut rewritten, id_map);
    if let Some(next) = rewritten {
        *value = next;
    }
}

fn apply_continuation_id_map(entry: &mut ProjectEntry, id_map: &HashMap<String, String>) {
    if let Some(new_id) = id_map.get(entry.id.trim()) {
        entry.id = new_id.clone();
    }
    rewrite_prefixed_navigation_target(&mut entry.return_after_play, id_map);
    rewrite_prefixed_navigation_target(&mut entry.return_on_home, id_map);
    rewrite_prefixed_navigation_target(&mut entry.title_return_on_home, id_map);
    rewrite_prefixed_navigation_target(&mut entry.after_playback_prompt_ok_target, id_map);
    rewrite_prefixed_navigation_target(&mut entry.after_playback_prompt_home_target, id_map);
    for step in &mut entry.after_playback_sequence {
        rewrite_prefixed_navigation_target(&mut step.ok_target, id_map);
        for target in &mut step.ok_choice_targets {
            rewrite_prefixed_navigation_target_value(target, id_map);
        }
        rewrite_prefixed_navigation_target(&mut step.home_target, id_map);
    }
    if let Some(step) = &mut entry.after_playback_home_step {
        rewrite_prefixed_navigation_target(&mut step.ok_target, id_map);
        for target in &mut step.ok_choice_targets {
            rewrite_prefixed_navigation_target_value(target, id_map);
        }
        rewrite_prefixed_navigation_target(&mut step.home_target, id_map);
    }
    for child in &mut entry.children {
        apply_continuation_id_map(child, id_map);
    }
}

fn count_content_entries(entries: &[ProjectEntry]) -> usize {
    let mut total = 0usize;
    for entry in entries {
        match entry.entry_type.as_str() {
            "menu" => total += count_content_entries(&entry.children),
            _ => total += 1,
        }
    }
    total
}

fn count_playable_descendants(entry: &ProjectEntry) -> usize {
    match entry.entry_type.as_str() {
        // Une `ref` est un choix navigable (vers un nœud existant) → elle compte.
        "story" | "zip" | "ref" => 1,
        "menu" => entry.children.iter().map(count_playable_descendants).sum(),
        _ => 0,
    }
}

fn has_playable_descendants(entry: &ProjectEntry) -> bool {
    match entry.entry_type.as_str() {
        "story" | "zip" | "ref" => true,
        "menu" => entry.children.iter().any(has_playable_descendants),
        _ => false,
    }
}

fn collect_entry_graph_stats(
    entries: &[ProjectEntry],
    menu_ids: &mut HashSet<String>,
    story_ids: &mut HashSet<String>,
    story_home_step_ids: &mut HashSet<String>,
    id_counts: &mut HashMap<String, usize>,
    menu_playable_counts: &mut HashMap<String, usize>,
) {
    for entry in entries {
        let entry_id = entry.id.trim();
        if !entry_id.is_empty() {
            *id_counts.entry(entry_id.to_string()).or_insert(0) += 1;
        }

        if entry.entry_type == "menu" {
            if !entry_id.is_empty() {
                menu_ids.insert(entry_id.to_string());
                menu_playable_counts
                    .insert(entry_id.to_string(), count_playable_descendants(entry));
            }
            collect_entry_graph_stats(
                &entry.children,
                menu_ids,
                story_ids,
                story_home_step_ids,
                id_counts,
                menu_playable_counts,
            );
        } else if entry.entry_type == "story" && !entry_id.is_empty() {
            story_ids.insert(entry_id.to_string());
            if entry.after_playback_home_step.is_some() {
                story_home_step_ids.insert(entry_id.to_string());
            }
        }
    }
}

fn collect_entry_ids<'a>(entries: &'a [ProjectEntry], ids: &mut HashSet<&'a str>) {
    for entry in entries {
        let entry_id = entry.id.trim();
        if !entry_id.is_empty() {
            ids.insert(entry_id);
        }
        if entry.entry_type == "menu" {
            collect_entry_ids(&entry.children, ids);
        }
    }
}

fn push_navigation_target_id<'a>(target: Option<&'a String>, ids: &mut Vec<&'a str>) {
    if let Some(target_id) = target
        .map(String::as_str)
        .and_then(decode_ref_target_entry_id)
    {
        ids.push(target_id);
    }
}

fn collect_navigation_target_ids<'a>(entry: &'a ProjectEntry, ids: &mut Vec<&'a str>) {
    if entry.entry_type == "ref" {
        push_navigation_target_id(entry.target.as_ref(), ids);
    }
    push_navigation_target_id(entry.return_after_play.as_ref(), ids);
    push_navigation_target_id(entry.return_on_home.as_ref(), ids);
    if !entry.title_return_on_home_none {
        push_navigation_target_id(entry.title_return_on_home.as_ref(), ids);
    }
    push_navigation_target_id(entry.after_playback_prompt_ok_target.as_ref(), ids);
    if !entry.after_playback_prompt_home_none {
        push_navigation_target_id(entry.after_playback_prompt_home_target.as_ref(), ids);
    }
    for step in &entry.after_playback_sequence {
        push_navigation_target_id(step.ok_target.as_ref(), ids);
        for target in &step.ok_choice_targets {
            if let Some(target_id) = decode_ref_target_entry_id(target) {
                ids.push(target_id);
            }
        }
        if !step.home_follows_ok && !step.home_none {
            push_navigation_target_id(step.home_target.as_ref(), ids);
        }
    }
    if let Some(step) = &entry.after_playback_home_step {
        push_navigation_target_id(step.ok_target.as_ref(), ids);
        for target in &step.ok_choice_targets {
            if let Some(target_id) = decode_ref_target_entry_id(target) {
                ids.push(target_id);
            }
        }
        if !step.home_follows_ok && !step.home_none {
            push_navigation_target_id(step.home_target.as_ref(), ids);
        }
    }
}

fn find_entry_by_id<'a>(entries: &'a [ProjectEntry], entry_id: &str) -> Option<&'a ProjectEntry> {
    for entry in entries {
        if entry.id.trim() == entry_id {
            return Some(entry);
        }
        if entry.entry_type == "menu" {
            if let Some(found) = find_entry_by_id(&entry.children, entry_id) {
                return Some(found);
            }
        }
    }
    None
}

fn mark_entry_reachable(
    entry: &ProjectEntry,
    shared_ids: &HashSet<&str>,
    reachable_shared_ids: &mut HashSet<String>,
    queue: &mut Vec<ProjectEntry>,
) {
    let entry_id = entry.id.trim();
    if !entry_id.is_empty() && shared_ids.contains(entry_id) {
        reachable_shared_ids.insert(entry_id.to_string());
    }
    queue.push(entry.clone());
    if entry.entry_type == "menu" {
        for child in &entry.children {
            mark_entry_reachable(child, shared_ids, reachable_shared_ids, queue);
        }
    }
}

fn reachable_shared_entry_ids(
    root_entries: &[ProjectEntry],
    shared_entries: &[ProjectEntry],
) -> HashSet<String> {
    let mut shared_ids = HashSet::new();
    collect_entry_ids(shared_entries, &mut shared_ids);
    if shared_ids.is_empty() {
        return HashSet::new();
    }

    let mut reachable = HashSet::new();
    let mut processed = HashSet::new();
    let mut queue = Vec::new();
    for entry in root_entries {
        mark_entry_reachable(entry, &shared_ids, &mut reachable, &mut queue);
    }

    while let Some(entry) = queue.pop() {
        let entry_id = entry.id.trim().to_string();
        if !entry_id.is_empty() && !processed.insert(entry_id) {
            continue;
        }
        let mut target_ids = Vec::new();
        collect_navigation_target_ids(&entry, &mut target_ids);
        for target_id in target_ids {
            if !shared_ids.contains(target_id) {
                continue;
            }
            if let Some(target) = find_entry_by_id(shared_entries, target_id) {
                mark_entry_reachable(target, &shared_ids, &mut reachable, &mut queue);
            }
        }
    }

    reachable
}

fn validate_shared_entries_reachable(
    entries: &[ProjectEntry],
    reachable_ids: &HashSet<String>,
    context: &str,
    errors: &mut Vec<String>,
) {
    for entry in entries {
        let entry_name = display_label(
            &entry.name,
            if entry.entry_type == "menu" {
                "Collection"
            } else {
                "Element"
            },
        );
        let entry_context = format!("{} / {}", context, entry_name);
        if !entry.id.trim().is_empty() && !reachable_ids.contains(entry.id.trim()) {
            if is_preserved_native_helper_shared_entry(entry) {
                continue;
            }
            errors.push(format!("{} : élément partagé non utilisé.", entry_context));
        }
        if entry.entry_type == "menu" {
            validate_shared_entries_reachable(
                &entry.children,
                reachable_ids,
                &entry_context,
                errors,
            );
        }
    }
}

fn validate_navigation_targets(
    entries: &[ProjectEntry],
    graph: &NavigationValidationContext<'_>,
    context: &str,
    errors: &mut Vec<String>,
) {
    for entry in entries {
        let fallback_name = if entry.entry_type == "menu" {
            "Collection"
        } else {
            "Histoire"
        };
        let entry_name = display_label(&entry.name, fallback_name);
        let entry_context = format!("{} / {}", context, entry_name);

        if entry.entry_type == "ref" {
            validate_navigation_target(
                entry.target.as_deref(),
                &entry_context,
                "la cible de la référence",
                graph,
                errors,
            );
        }

        validate_navigation_target(
            entry.return_after_play.as_deref(),
            &entry_name,
            "la destination de navigation après lecture",
            graph,
            errors,
        );
        if !entry.return_on_home_none {
            validate_navigation_target(
                entry.return_on_home.as_deref(),
                &entry_name,
                "la destination du bouton Accueil",
                graph,
                errors,
            );
        }
        if !entry.title_return_on_home_none {
            validate_navigation_target(
                entry.title_return_on_home.as_deref(),
                &entry_name,
                "la destination du bouton Accueil du titre",
                graph,
                errors,
            );
        }
        validate_navigation_target(
            entry.after_playback_prompt_ok_target.as_deref(),
            &entry_name,
            "la destination OK du prompt final",
            graph,
            errors,
        );
        if !entry.after_playback_prompt_home_none {
            validate_navigation_target(
                entry.after_playback_prompt_home_target.as_deref(),
                &entry_name,
                "la destination Accueil du prompt final",
                graph,
                errors,
            );
        }
        for (index, step) in entry.after_playback_sequence.iter().enumerate() {
            let step_label = format!("la destination OK fin {}", index + 1);
            validate_navigation_target(
                step.ok_target.as_deref(),
                &entry_name,
                &step_label,
                graph,
                errors,
            );
            for target in &step.ok_choice_targets {
                validate_navigation_target(
                    Some(target.as_str()),
                    &entry_name,
                    &step_label,
                    graph,
                    errors,
                );
            }
            if !step.home_follows_ok && !step.home_none {
                let step_label = format!("la destination Accueil fin {}", index + 1);
                validate_navigation_target(
                    step.home_target.as_deref(),
                    &entry_name,
                    &step_label,
                    graph,
                    errors,
                );
            }
        }
        if let Some(step) = entry.after_playback_home_step.as_ref() {
            validate_navigation_target(
                step.ok_target.as_deref(),
                &entry_name,
                "la destination OK du retour Home de fin",
                graph,
                errors,
            );
            for target in &step.ok_choice_targets {
                validate_navigation_target(
                    Some(target.as_str()),
                    &entry_name,
                    "la destination OK du retour Home de fin",
                    graph,
                    errors,
                );
            }
            if !step.home_follows_ok && !step.home_none {
                validate_navigation_target(
                    step.home_target.as_deref(),
                    &entry_name,
                    "la destination Accueil du retour Home de fin",
                    graph,
                    errors,
                );
            }
        }

        if entry.entry_type == "menu" {
            validate_navigation_targets(&entry.children, graph, &entry_context, errors);
        }
    }
}

fn validate_project_entry_for_generation(
    entry: &ProjectEntry,
    context: &str,
    file_validation: FileValidation,
    errors: &mut Vec<String>,
) {
    let trimmed_id = entry.id.trim();
    if trimmed_id.is_empty() {
        errors.push(format!("{} : identifiant interne manquant.", context));
    } else if trimmed_id == "root" {
        errors.push(format!(
            "{} : l'identifiant reserve `root` ne peut pas etre utilise.",
            context
        ));
    }

    match entry.entry_type.as_str() {
        "menu" => {
            if !has_playable_descendants(entry) {
                errors.push(format!("{} : collection vide.", context));
            }

            if (is_imported_continuation_menu(entry)
                || is_preserved_native_helper_shared_entry(entry))
                && entry.audio.as_deref().unwrap_or("").trim().is_empty()
            {
                // Stage natif silencieux préservé depuis l'import.
            } else {
                if let Some(menu_audio) = required_file_path(
                    entry.audio.as_deref(),
                    &format!("{} : audio menu", context),
                    errors,
                ) {
                    if file_validation.checks_disk() {
                        if let Err(err) = validate_existing_file_path(menu_audio, context) {
                            errors.push(err);
                        }
                    }
                }
            }

            let menu_image_label = format!("{} : image menu", context);
            if let Some(menu_image) = entry
                .image
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if file_validation.checks_disk() {
                    if let Err(err) = validate_existing_file_path(menu_image, &menu_image_label) {
                        errors.push(err);
                    }
                }
            } else if entry.auto_black_image {
                // autoBlackImage : le générateur produit un écran noir, aucune image requise.
            } else {
                errors.push(format!("{} manquante.", menu_image_label));
            }

            for child in &entry.children {
                let child_name = display_label(&child.name, "Element");
                validate_project_entry_for_generation(
                    child,
                    &format!("{} / {}", context, child_name),
                    file_validation,
                    errors,
                );
            }
        }
        "zip" => {
            let zip_label = format!("{} : ZIP", context);
            if let Some(zip_path) =
                required_file_path(entry.zip_path.as_deref(), &zip_label, errors)
            {
                if file_validation.checks_disk() {
                    if let Err(err) = validate_existing_pack_path(zip_path) {
                        errors.push(format!("{} : {}", zip_label, err));
                    }
                }
            }
        }
        "ref" => {
            // La résolution de la cible est validée globalement avec les autres navigations ;
            // ici on exige seulement une cible non vide.
            if entry
                .target
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                errors.push(format!("{} : référence sans cible.", context));
            }
        }
        _ => {
            if entry.entry_type != "story" {
                errors.push(format!(
                    "{} : type d'element non pris en charge ({}).",
                    context, entry.entry_type
                ));
            } else {
                validate_story_entry_for_generation(entry, context, file_validation, errors);
                if let Some(prompt_audio) = entry
                    .after_playback_prompt_audio
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if file_validation.checks_disk() {
                        let label = format!("{} : audio fin histoire", context);
                        if let Err(err) = validate_existing_file_path(prompt_audio, &label) {
                            errors.push(err);
                        }
                    }
                }
            }
        }
    }
}

fn validate_project_for_generation_with_mode(
    project: &Project,
    file_validation: FileValidation,
) -> Result<(), String> {
    let mut errors = Vec::new();
    let is_simple = project.project_type.as_deref() == Some("simple");
    let root_entries = project_root_entries(project);
    let shared_entries = project_shared_entries(project);

    if !project.shared_entries.is_empty() {
        errors.push(
            "Les éléments partagés ne sont plus pris en charge en authoring Story Studio."
                .to_string(),
        );
    }

    if project.project_type.is_none() {
        errors.push("Aucun type de projet selectionne.".to_string());
    }

    if let Some(root_audio) =
        required_file_path(project.root_audio.as_deref(), "Audio racine", &mut errors)
    {
        if file_validation.checks_disk() {
            if let Err(err) = validate_existing_file_path(root_audio, "Audio racine") {
                errors.push(err);
            }
        }
    }

    if let Some(root_image) = required_file_path(
        project.root_image.as_deref(),
        "Image de couverture",
        &mut errors,
    ) {
        if file_validation.checks_disk() {
            if let Err(err) = validate_existing_file_path(root_image, "Image de couverture") {
                errors.push(err);
            }
        }
    }

    if !is_simple {
        if let Some(thumbnail) = required_file_path(
            project.thumbnail_image.as_deref(),
            "Image bibliotheque (STUdio/LuniiQt)",
            &mut errors,
        ) {
            if file_validation.checks_disk() {
                if let Err(err) = validate_existing_file_path(thumbnail, "Image bibliotheque") {
                    errors.push(err);
                }
            }
        }
    } else if let Some(thumbnail) = project
        .thumbnail_image
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if file_validation.checks_disk() {
            if let Err(err) = validate_existing_file_path(thumbnail, "Thumbnail") {
                errors.push(err);
            }
        }
    }

    if project.global_options.night_mode {
        if let Some(night_audio) = required_file_path(
            project.night_mode_audio.as_deref(),
            "Audio mode nuit",
            &mut errors,
        ) {
            if file_validation.checks_disk() {
                if let Err(err) = validate_existing_file_path(night_audio, "Audio mode nuit") {
                    errors.push(err);
                }
            }
        }
    }

    if is_simple {
        match root_entries
            .iter()
            .find(|entry| entry.entry_type != "menu" && entry.entry_type != "zip")
        {
            Some(story) => {
                validate_story_entry_for_generation(
                    story,
                    "Histoire principale",
                    file_validation,
                    &mut errors,
                );
            }
            None => errors.push("Histoire principale manquante.".to_string()),
        }
    } else {
        let total_items = count_content_entries(&root_entries);
        if total_items == 0 {
            errors.push("Le pack ne contient aucune histoire.".to_string());
        }

        let mut menu_ids = HashSet::new();
        let mut story_ids = HashSet::new();
        let mut story_home_step_ids = HashSet::new();
        let mut id_counts = HashMap::new();
        let mut menu_playable_counts = HashMap::new();
        collect_entry_graph_stats(
            &root_entries,
            &mut menu_ids,
            &mut story_ids,
            &mut story_home_step_ids,
            &mut id_counts,
            &mut menu_playable_counts,
        );
        collect_entry_graph_stats(
            &shared_entries,
            &mut menu_ids,
            &mut story_ids,
            &mut story_home_step_ids,
            &mut id_counts,
            &mut menu_playable_counts,
        );
        for (entry_id, count) in id_counts.iter() {
            if *count > 1 {
                errors.push(format!(
                    "Identifiant duplique : {} elements partagent l'id {}.",
                    count, entry_id
                ));
            }
        }
        if id_counts.contains_key("root") {
            errors.push(
                "Identifiant reserve utilise : aucun element ne doit porter l'id root.".to_string(),
            );
        }
        let navigation_graph = NavigationValidationContext {
            menu_ids: &menu_ids,
            menu_playable_counts: &menu_playable_counts,
            story_ids: &story_ids,
            story_home_step_ids: &story_home_step_ids,
        };
        validate_navigation_targets(&root_entries, &navigation_graph, "Racine", &mut errors);
        validate_navigation_targets(
            &shared_entries,
            &navigation_graph,
            "Éléments partagés",
            &mut errors,
        );
        let reachable_shared_ids = reachable_shared_entry_ids(&root_entries, &shared_entries);
        validate_shared_entries_reachable(
            &shared_entries,
            &reachable_shared_ids,
            "Éléments partagés",
            &mut errors,
        );

        for entry in &root_entries {
            let entry_name = display_label(&entry.name, "Element racine");
            validate_project_entry_for_generation(entry, &entry_name, file_validation, &mut errors);
        }
        for entry in &shared_entries {
            let entry_name = display_label(&entry.name, "Element partage");
            validate_project_entry_for_generation(entry, &entry_name, file_validation, &mut errors);
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

pub(crate) fn validate_project_structure_for_generation(project: &Project) -> Result<(), String> {
    validate_project_for_generation_with_mode(project, FileValidation::StructureOnly)
}

pub(crate) fn validate_project_for_generation(project: &Project) -> Result<(), String> {
    validate_project_for_generation_with_mode(project, FileValidation::CheckDisk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::project::{AfterPlaybackSequenceStep, EntryControlSettings, GlobalOptions};

    fn options() -> GlobalOptions {
        GlobalOptions {
            harmonize_loudness: true,
            add_silence: false,
            silence_mode: None,
            add_silence_duration_sec: 1.0,
            auto_next: false,
            night_mode: false,
        }
    }

    fn base_project(project_type: &str) -> Project {
        Project {
            name: "Validation test".to_string(),
            project_type: Some(project_type.to_string()),
            root_audio: None,
            root_image: None,
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            pack_version: 1,
            pack_description: String::new(),
            pack_uuid: String::new(),
            root_entries: Vec::new(),
            shared_entries: Vec::new(),
            global_options: options(),
        }
    }

    fn root_entry_story(name: &str) -> ProjectEntry {
        ProjectEntry {
            id: name.to_ascii_lowercase(),
            entry_type: "story".to_string(),
            name: name.to_string(),
            audio: Some("missing-story.mp3".to_string()),
            item_audio: Some("missing-title.mp3".to_string()),
            item_image: Some("missing-title.png".to_string()),
            ..ProjectEntry::default()
        }
    }

    #[test]
    fn validation_reports_simple_story_errors_from_root_entries() {
        let mut root_entries_project = base_project("simple");
        root_entries_project.root_entries = vec![root_entry_story("Simple")];

        let root_entries_errors = validate_project_for_generation(&root_entries_project)
            .expect_err("rootEntries simple should report missing files");

        assert!(root_entries_errors.contains("Audio racine manquant."));
        assert!(root_entries_errors.contains("Histoire principale : audio"));
    }

    fn ref_entry(id: &str, target: &str) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            entry_type: "ref".to_string(),
            name: "Lien".to_string(),
            target: Some(target.to_string()),
            ..ProjectEntry::default()
        }
    }

    fn menu_with(id: &str, name: &str, children: Vec<ProjectEntry>) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            entry_type: "menu".to_string(),
            name: name.to_string(),
            audio: Some("valid/menu.mp3".to_string()),
            image: Some("valid/menu.png".to_string()),
            children,
            ..ProjectEntry::default()
        }
    }

    #[test]
    fn ref_entry_with_valid_target_is_not_rejected() {
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.root_entries = vec![menu_with(
            "menu-1",
            "Choix",
            vec![
                story_entry_with_paths("story-a", "Histoire A"),
                ref_entry("ref-1", "story:story-a"),
            ],
        )];
        let errors = validate_project_for_generation(&project)
            .err()
            .unwrap_or_default();
        assert!(
            !errors.contains("non pris en charge"),
            "une ref ne doit plus etre rejetee : {errors}"
        );
        assert!(
            !errors.contains("cible de la r\u{e9}f\u{e9}rence est introuvable"),
            "la cible existe : {errors}"
        );
    }

    #[test]
    fn ref_entry_with_dangling_target_is_flagged() {
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.root_entries = vec![
            story_entry_with_paths("story-a", "Histoire A"),
            ref_entry("ref-1", "story:does-not-exist"),
        ];
        let errors =
            validate_project_for_generation(&project).expect_err("une ref pendante doit bloquer");
        assert!(
            errors.contains("cible de la r\u{e9}f\u{e9}rence est introuvable"),
            "{errors}"
        );
    }

    #[test]
    fn menu_containing_only_refs_is_not_considered_empty() {
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.root_entries = vec![
            story_entry_with_paths("story-a", "Histoire A"),
            menu_with(
                "menu-links",
                "Liens",
                vec![ref_entry("ref-1", "story:story-a")],
            ),
        ];
        let errors = validate_project_for_generation(&project)
            .err()
            .unwrap_or_default();
        assert!(
            !errors.contains("collection vide"),
            "un dossier de liens valides n'est pas vide : {errors}"
        );
    }

    #[test]
    fn shared_story_targeted_by_root_ref_blocks_generation() {
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.thumbnail_image = Some("valid/thumb.png".to_string());
        project.root_entries = vec![ref_entry("ref-1", "story:shared-story")];
        project.shared_entries = vec![story_entry_with_paths("shared-story", "Scene commune")];

        let errors = validate_project_for_generation(&project)
            .expect_err("les elements partages ne sont plus authoring");
        assert!(
            errors.contains("éléments partagés ne sont plus pris en charge"),
            "{errors}"
        );
    }

    #[test]
    fn unused_shared_story_blocks_generation() {
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.thumbnail_image = Some("valid/thumb.png".to_string());
        project.root_entries = vec![story_entry_with_paths("story-a", "Histoire A")];
        project.shared_entries = vec![story_entry_with_paths("shared-story", "Scene commune")];

        let errors = validate_project_for_generation(&project)
            .expect_err("les elements partages ne sont plus authoring");
        assert!(
            errors.contains("éléments partagés ne sont plus pris en charge"),
            "{errors}"
        );
    }

    // ---- Parite avec le test JS scripts/validationParity.test.mjs ----
    // Les cas ci-dessous miroitent les fixtures de scripts/fixtures/validation-projects.json.
    // Si on ajoute une regle de validation : ajouter un cas ici ET dans le JSON, et
    // valider que les deux moteurs produisent le meme verdict (Ok / Err).

    fn story_entry_with_paths(id: &str, name: &str) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            entry_type: "story".to_string(),
            name: name.to_string(),
            audio: Some("valid/story1.mp3".to_string()),
            item_audio: Some("valid/story1-title.mp3".to_string()),
            item_image: Some("valid/story1-title.png".to_string()),
            ..ProjectEntry::default()
        }
    }

    fn pack_project(entries: Vec<ProjectEntry>) -> Project {
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.thumbnail_image = Some("valid/thumb.png".to_string());
        project.root_entries = entries;
        project
    }

    #[test]
    fn explicit_silent_title_stage_does_not_require_item_audio() {
        let mut story = story_entry_with_paths("story-silent-title", "Titre silencieux");
        story.item_audio = None;
        story.silent_title_stage = true;
        story.title_control_settings = Some(EntryControlSettings {
            wheel: Some(true),
            ok: Some(true),
            home: Some(true),
            pause: Some(false),
            autoplay: Some(false),
        });
        let project = pack_project(vec![story]);

        validate_project_structure_for_generation(&project)
            .expect("un titre explicite silencieux est generable");
    }

    #[test]
    fn native_stage_id_does_not_exempt_story_selection_media() {
        let mut story = story_entry_with_paths("story-native", "Histoire native");
        story.native_stage_id = Some("native-stage".to_string());
        story.item_audio = None;
        story.item_image = None;
        let project = pack_project(vec![story]);

        let errors = validate_project_structure_for_generation(&project)
            .expect_err("nativeStageId ne doit pas masquer les medias manquants");

        assert!(errors.contains("audio titre"), "{errors}");
        assert!(errors.contains("image"), "{errors}");
    }

    #[test]
    fn story_play_missing_navigation_target_blocks_structure() {
        let mut source = story_entry_with_paths("source", "Source");
        source.return_after_play = Some("story_play:missing".to_string());
        let project = pack_project(vec![source]);

        let errors = validate_project_structure_for_generation(&project)
            .expect_err("story_play:missing doit bloquer");

        assert!(
            errors.contains("destination de navigation après lecture est introuvable"),
            "{errors}"
        );
    }

    #[test]
    fn story_missing_navigation_target_blocks_structure() {
        let mut source = story_entry_with_paths("source", "Source");
        source.return_on_home = Some("story:missing".to_string());
        let project = pack_project(vec![source]);

        let errors = validate_project_structure_for_generation(&project)
            .expect_err("story:missing doit bloquer");

        assert!(
            errors.contains("destination du bouton Accueil est introuvable"),
            "{errors}"
        );
    }

    #[test]
    fn story_home_step_target_without_home_step_blocks_structure() {
        let mut source = story_entry_with_paths("source", "Source");
        source.title_return_on_home = Some("story_home_step:target".to_string());
        let target = story_entry_with_paths("target", "Target");
        let project = pack_project(vec![source, target]);

        let errors = validate_project_structure_for_generation(&project)
            .expect_err("story_home_step vers une histoire sans home step doit bloquer");

        assert!(errors.contains("retour de fin introuvable"), "{errors}");
    }

    #[test]
    fn preserved_native_helper_shared_entry_is_rejected_with_shared_entries() {
        let mut project = pack_project(vec![story_entry_with_paths("story-a", "Histoire A")]);
        project.shared_entries = vec![ProjectEntry {
            id: "helper".to_string(),
            entry_type: "menu".to_string(),
            name: "Helper".to_string(),
            native_stage_id: Some("helper".to_string()),
            auto_black_image: true,
            control_settings: Some(EntryControlSettings {
                autoplay: Some(true),
                wheel: Some(false),
                pause: Some(false),
                ok: Some(true),
                home: Some(true),
            }),
            children: vec![ref_entry("helper-ref", "story:story-a")],
            ..ProjectEntry::default()
        }];

        let errors = validate_project_structure_for_generation(&project)
            .expect_err("les helpers partages natifs ne sont plus authoring");

        assert!(
            errors.contains("éléments partagés ne sont plus pris en charge"),
            "{errors}"
        );
    }

    #[test]
    fn parity_pack_valid_minimal_passes_validation() {
        // Equivalent JSON : pack_valid_minimal. JS = ok, Rust = Ok.
        // Note : les paths n'existent pas sur disque, donc validate_existing_file_path va echouer.
        // Cote JS, fileAudit force ces paths a true ; cote Rust, on ne peut pas mocker le FS sans
        // toucher au code de prod. On verifie donc que les erreurs Rust portent UNIQUEMENT sur
        // l'inaccessibilite disque, jamais sur la structure du projet.
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.thumbnail_image = Some("valid/thumb.png".to_string());
        project.root_entries = vec![story_entry_with_paths("story-1", "Histoire 1")];

        let result = validate_project_for_generation(&project);
        match result {
            Ok(()) => {}
            Err(errors) => {
                assert!(
                    !errors.contains("manquant"),
                    "structure invalide alors qu'elle devrait passer : {}",
                    errors,
                );
            }
        }
    }

    #[test]
    fn parity_pack_missing_story_audio_fails() {
        // Equivalent JSON : pack_missing_story_audio. JS = fail, Rust = Err contenant "audio".
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.thumbnail_image = Some("valid/thumb.png".to_string());
        project.root_entries = vec![ProjectEntry {
            id: "story-1".to_string(),
            entry_type: "story".to_string(),
            name: "Histoire 1".to_string(),
            audio: None,
            item_audio: Some("valid/story1-title.mp3".to_string()),
            item_image: Some("valid/story1-title.png".to_string()),
            ..ProjectEntry::default()
        }];

        let errors = validate_project_for_generation(&project)
            .expect_err("projet sans audio histoire doit bloquer");
        assert!(
            errors.contains("audio"),
            "Rust doit signaler l'audio manquant ; recu : {}",
            errors,
        );
    }

    #[test]
    fn parity_pack_empty_pack_fails() {
        // Equivalent JSON : pack_empty_pack. JS = fail (warning "emptyPack"),
        // Rust = Err contenant "aucune histoire" (cf. validate_pack_root).
        let mut project = base_project("pack");
        project.root_audio = Some("valid/root.mp3".to_string());
        project.root_image = Some("valid/root.png".to_string());
        project.thumbnail_image = Some("valid/thumb.png".to_string());
        project.root_entries = Vec::new();

        let errors = validate_project_for_generation(&project).expect_err("pack vide doit bloquer");
        assert!(
            errors.to_lowercase().contains("aucune histoire")
                || errors.to_lowercase().contains("aucun")
                || errors.to_lowercase().contains("vide"),
            "Rust doit signaler le pack vide ; recu : {}",
            errors,
        );
    }

    #[test]
    fn parity_simple_missing_root_audio_fails() {
        // Equivalent JSON : simple_missing_root_audio. JS = fail (warning audio intro),
        // Rust = Err contenant "Audio racine".
        let mut project = base_project("simple");
        project.root_audio = None;
        project.root_entries = vec![ProjectEntry {
            id: "story-main".to_string(),
            entry_type: "story".to_string(),
            name: "Histoire principale".to_string(),
            audio: Some("valid/main.mp3".to_string()),
            ..ProjectEntry::default()
        }];

        let errors = validate_project_for_generation(&project)
            .expect_err("simple sans audio racine doit bloquer");
        assert!(
            errors.contains("Audio racine") || errors.contains("audio"),
            "Rust doit signaler l'audio racine manquant ; recu : {}",
            errors,
        );
    }

    #[test]
    fn project_root_entries_normalizes_imported_continuation_children() {
        let mut project = base_project("pack");
        project.root_entries = vec![ProjectEntry {
            id: "import-sequence-choice-1".to_string(),
            entry_type: "menu".to_string(),
            name: "Suite apres histoire".to_string(),
            children: vec![ProjectEntry {
                id: "child".to_string(),
                entry_type: "story".to_string(),
                name: "Child".to_string(),
                return_after_play: Some("story:child".to_string()),
                after_playback_sequence: vec![AfterPlaybackSequenceStep {
                    ok_choice_targets: vec!["story:child".to_string()],
                    home_target: Some("story:child".to_string()),
                    ..AfterPlaybackSequenceStep::default()
                }],
                after_playback_home_step: Some(AfterPlaybackSequenceStep {
                    ok_target: Some("story:child".to_string()),
                    ok_choice_targets: vec!["story:child".to_string()],
                    home_target: Some("story:child".to_string()),
                    ..AfterPlaybackSequenceStep::default()
                }),
                ..ProjectEntry::default()
            }],
            ..ProjectEntry::default()
        }];

        let entries = project_root_entries(&project);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].children[0].id, "import-sequence-choice-1-child");
        assert_eq!(
            entries[0].children[0].return_after_play.as_deref(),
            Some("story:import-sequence-choice-1-child")
        );
        assert_eq!(
            entries[0].children[0].after_playback_sequence[0].ok_choice_targets,
            vec!["story:import-sequence-choice-1-child".to_string()]
        );
        assert_eq!(
            entries[0].children[0].after_playback_sequence[0]
                .home_target
                .as_deref(),
            Some("story:import-sequence-choice-1-child")
        );
        let home_step = entries[0].children[0]
            .after_playback_home_step
            .as_ref()
            .expect("home step");
        assert_eq!(
            home_step.ok_target.as_deref(),
            Some("story:import-sequence-choice-1-child")
        );
        assert_eq!(
            home_step.ok_choice_targets,
            vec!["story:import-sequence-choice-1-child".to_string()]
        );
        assert_eq!(
            home_step.home_target.as_deref(),
            Some("story:import-sequence-choice-1-child")
        );
    }
}
