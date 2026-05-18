use crate::domain::project::{Menu, Project, ProjectEntry, StoryItem};
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

fn validate_story_item_for_generation(
    item: &StoryItem,
    context: &str,
    require_selection_media: bool,
    errors: &mut Vec<String>,
) {
    match item.item_type.as_str() {
        "zip" => {
            let zip_label = format!("{} : ZIP", context);
            if let Some(zip_path) = required_file_path(item.zip_path.as_deref(), &zip_label, errors)
            {
                if let Err(err) = validate_existing_pack_path(zip_path) {
                    errors.push(err);
                }
            }
        }
        _ => {
            let story_audio_label = format!("{} : audio", context);
            if let Some(audio_path) =
                required_file_path(item.audio.as_deref(), &story_audio_label, errors)
            {
                if let Err(err) = validate_existing_file_path(audio_path, &story_audio_label) {
                    errors.push(err);
                }
            }
            if require_selection_media {
                let item_audio_label = format!("{} : audio titre", context);
                if let Some(item_audio) =
                    required_file_path(item.item_audio.as_deref(), &item_audio_label, errors)
                {
                    if let Err(err) = validate_existing_file_path(item_audio, &item_audio_label) {
                        errors.push(err);
                    }
                }
                let item_image_label = format!("{} : image", context);
                if let Some(item_image) =
                    required_file_path(item.item_image.as_deref(), &item_image_label, errors)
                {
                    if let Err(err) = validate_existing_file_path(item_image, &item_image_label) {
                        errors.push(err);
                    }
                }
            }
        }
    }
}

pub(crate) fn menu_to_project_entry(menu: &Menu) -> ProjectEntry {
    ProjectEntry {
        id: String::new(),
        entry_type: "menu".to_string(),
        name: menu.name.clone(),
        audio: menu.audio.clone(),
        image: menu.image.clone(),
        item_audio: None,
        item_image: None,
        zip_path: None,
        auto_black_image: menu.auto_black_image,
        control_settings: None,
        return_after_play: None,
        return_on_home: None,
        return_on_home_none: false,
        title_return_on_home: None,
        title_return_on_home_none: false,
        title_control_settings: None,
        after_playback_prompt_audio: None,
        after_playback_prompt_control_settings: None,
        after_playback_prompt_ok_target: None,
        after_playback_prompt_home_target: None,
        after_playback_prompt_home_none: false,
        after_playback_sequence: Vec::new(),
        after_playback_home_step: None,
        audio_processing: HashMap::new(),
        children: menu.items.iter().map(story_item_to_project_entry).collect(),
    }
}

pub(crate) fn story_item_to_project_entry(item: &StoryItem) -> ProjectEntry {
    ProjectEntry {
        id: String::new(),
        entry_type: item.item_type.clone(),
        name: item.name.clone(),
        audio: item.audio.clone(),
        image: None,
        item_audio: item.item_audio.clone(),
        item_image: item.item_image.clone(),
        zip_path: item.zip_path.clone(),
        auto_black_image: false,
        control_settings: None,
        return_after_play: None,
        return_on_home: None,
        return_on_home_none: false,
        title_return_on_home: None,
        title_return_on_home_none: false,
        title_control_settings: None,
        after_playback_prompt_audio: None,
        after_playback_prompt_control_settings: None,
        after_playback_prompt_ok_target: None,
        after_playback_prompt_home_target: None,
        after_playback_prompt_home_none: false,
        after_playback_sequence: Vec::new(),
        after_playback_home_step: None,
        audio_processing: HashMap::new(),
        children: Vec::new(),
    }
}

fn decode_navigation_menu_target(target: &str) -> Option<&str> {
    let trimmed = target.trim();
    if trimmed.is_empty()
        || trimmed == "current_menu"
        || trimmed == "root"
        || trimmed == "next_story"
        || trimmed.starts_with("story:")
        || trimmed.starts_with("story_play:")
        || trimmed.starts_with("story_home_step:")
    {
        return None;
    }
    Some(trimmed.strip_prefix("menu:").unwrap_or(trimmed))
}

pub(crate) fn project_root_entries(project: &Project) -> Vec<ProjectEntry> {
    let mut entries = if !project.root_entries.is_empty() {
        project.root_entries.clone()
    } else if project.project_type.as_deref() == Some("simple") {
        project
            .menus
            .first()
            .and_then(|menu| menu.items.first())
            .map(story_item_to_project_entry)
            .into_iter()
            .collect()
    } else {
        let mut entries: Vec<ProjectEntry> = project
            .root_items
            .iter()
            .map(story_item_to_project_entry)
            .collect();
        entries.extend(project.menus.iter().map(menu_to_project_entry));
        entries
    };
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
        "story" | "zip" => 1,
        "menu" => entry.children.iter().map(count_playable_descendants).sum(),
        _ => 0,
    }
}

fn has_playable_descendants(entry: &ProjectEntry) -> bool {
    match entry.entry_type.as_str() {
        "story" | "zip" => true,
        "menu" => entry.children.iter().any(has_playable_descendants),
        _ => false,
    }
}

fn collect_entry_graph_stats(
    entries: &[ProjectEntry],
    menu_ids: &mut HashSet<String>,
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
            collect_entry_graph_stats(&entry.children, menu_ids, id_counts, menu_playable_counts);
        }
    }
}

fn validate_return_after_play_targets(
    entries: &[ProjectEntry],
    menu_ids: &HashSet<String>,
    menu_playable_counts: &HashMap<String, usize>,
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

        if let Some(target_id) = entry
            .return_after_play
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(decode_navigation_menu_target)
        {
            if !menu_ids.contains(target_id) {
                errors.push(format!(
                    "{} : la destination de navigation après lecture est introuvable.",
                    entry_name
                ));
            } else if menu_playable_counts.get(target_id).copied().unwrap_or(0) == 0 {
                errors.push(format!(
                    "{} : la destination de navigation après lecture est vide ou non jouable.",
                    entry_name
                ));
            }
        }

        if let Some(target_id) = entry
            .return_on_home
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(decode_navigation_menu_target)
        {
            if !menu_ids.contains(target_id) {
                errors.push(format!(
                    "{} : la destination du bouton Accueil est introuvable.",
                    entry_name
                ));
            } else if menu_playable_counts.get(target_id).copied().unwrap_or(0) == 0 {
                errors.push(format!(
                    "{} : la destination du bouton Accueil est vide ou non jouable.",
                    entry_name
                ));
            }
        }

        if !entry.title_return_on_home_none {
            if let Some(target_id) = entry
                .title_return_on_home
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(decode_navigation_menu_target)
            {
                if !menu_ids.contains(target_id) {
                    errors.push(format!(
                        "{} : la destination du bouton Accueil du titre est introuvable.",
                        entry_name
                    ));
                } else if menu_playable_counts.get(target_id).copied().unwrap_or(0) == 0 {
                    errors.push(format!(
                        "{} : la destination du bouton Accueil du titre est vide ou non jouable.",
                        entry_name
                    ));
                }
            }
        }

        if entry.entry_type == "menu" {
            validate_return_after_play_targets(
                &entry.children,
                menu_ids,
                menu_playable_counts,
                &entry_context,
                errors,
            );
        }
    }
}

fn validate_project_entry_for_generation(
    entry: &ProjectEntry,
    context: &str,
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

            if is_imported_continuation_menu(entry)
                && entry.audio.as_deref().unwrap_or("").trim().is_empty()
            {
                // Continuation native issue d'une sequence de fin : stage de choix silencieux.
            } else {
                if let Some(menu_audio) = required_file_path(
                    entry.audio.as_deref(),
                    &format!("{} : audio menu", context),
                    errors,
                ) {
                    if let Err(err) = validate_existing_file_path(menu_audio, context) {
                        errors.push(err);
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
                if let Err(err) = validate_existing_file_path(menu_image, &menu_image_label) {
                    errors.push(err);
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
                    errors,
                );
            }
        }
        "zip" => {
            let zip_label = format!("{} : ZIP", context);
            if let Some(zip_path) =
                required_file_path(entry.zip_path.as_deref(), &zip_label, errors)
            {
                if let Err(err) = validate_existing_pack_path(zip_path) {
                    errors.push(format!("{} : {}", zip_label, err));
                }
            }
        }
        _ => {
            if entry.entry_type != "story" {
                errors.push(format!(
                    "{} : type d'element non pris en charge ({}).",
                    context, entry.entry_type
                ));
            } else {
                let is_autoplay = entry
                    .control_settings
                    .as_ref()
                    .and_then(|cs| cs.autoplay)
                    .unwrap_or(false);
                let item = StoryItem {
                    item_type: "story".to_string(),
                    name: entry.name.clone(),
                    audio: entry.audio.clone(),
                    item_audio: entry.item_audio.clone(),
                    item_image: entry.item_image.clone(),
                    zip_path: None,
                };
                validate_story_item_for_generation(&item, context, !is_autoplay, errors);
                if let Some(prompt_audio) = entry
                    .after_playback_prompt_audio
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let label = format!("{} : audio fin histoire", context);
                    if let Err(err) = validate_existing_file_path(prompt_audio, &label) {
                        errors.push(err);
                    }
                }
            }
        }
    }
}

pub(crate) fn validate_project_for_generation(project: &Project) -> Result<(), String> {
    let mut errors = Vec::new();
    let is_simple = project.project_type.as_deref() == Some("simple");
    let root_entries = project_root_entries(project);

    if project.project_type.is_none() {
        errors.push("Aucun type de projet selectionne.".to_string());
    }

    if let Some(root_audio) =
        required_file_path(project.root_audio.as_deref(), "Audio racine", &mut errors)
    {
        if let Err(err) = validate_existing_file_path(root_audio, "Audio racine") {
            errors.push(err);
        }
    }

    if let Some(root_image) = required_file_path(
        project.root_image.as_deref(),
        "Image de couverture",
        &mut errors,
    ) {
        if let Err(err) = validate_existing_file_path(root_image, "Image de couverture") {
            errors.push(err);
        }
    }

    if !is_simple {
        if let Some(thumbnail) = required_file_path(
            project.thumbnail_image.as_deref(),
            "Image bibliotheque (STUdio/LuniiQt)",
            &mut errors,
        ) {
            if let Err(err) = validate_existing_file_path(thumbnail, "Image bibliotheque") {
                errors.push(err);
            }
        }
    } else if let Some(thumbnail) = project
        .thumbnail_image
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if let Err(err) = validate_existing_file_path(thumbnail, "Thumbnail") {
            errors.push(err);
        }
    }

    if project.global_options.night_mode {
        if let Some(night_audio) = required_file_path(
            project.night_mode_audio.as_deref(),
            "Audio mode nuit",
            &mut errors,
        ) {
            if let Err(err) = validate_existing_file_path(night_audio, "Audio mode nuit") {
                errors.push(err);
            }
        }
    }

    if is_simple {
        match root_entries
            .iter()
            .find(|entry| entry.entry_type != "menu" && entry.entry_type != "zip")
        {
            Some(story) => {
                let item = StoryItem {
                    item_type: "story".to_string(),
                    name: story.name.clone(),
                    audio: story.audio.clone(),
                    item_audio: story.item_audio.clone(),
                    item_image: story.item_image.clone(),
                    zip_path: None,
                };
                validate_story_item_for_generation(
                    &item,
                    "Histoire principale",
                    false,
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
        let mut id_counts = HashMap::new();
        let mut menu_playable_counts = HashMap::new();
        collect_entry_graph_stats(
            &root_entries,
            &mut menu_ids,
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
        validate_return_after_play_targets(
            &root_entries,
            &menu_ids,
            &menu_playable_counts,
            "Racine",
            &mut errors,
        );

        for entry in &root_entries {
            let entry_name = display_label(&entry.name, "Element racine");
            validate_project_entry_for_generation(entry, &entry_name, &mut errors);
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}
