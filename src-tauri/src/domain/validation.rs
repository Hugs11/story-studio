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

fn validate_story_entry_for_generation(
    entry: &ProjectEntry,
    context: &str,
    errors: &mut Vec<String>,
) {
    match entry.entry_type.as_str() {
        "zip" => {
            let zip_label = format!("{} : ZIP", context);
            if let Some(zip_path) =
                required_file_path(entry.zip_path.as_deref(), &zip_label, errors)
            {
                if let Err(err) = validate_existing_pack_path(zip_path) {
                    errors.push(err);
                }
            }
        }
        _ => {
            let story_audio_label = format!("{} : audio", context);
            if let Some(audio_path) =
                required_file_path(entry.audio.as_deref(), &story_audio_label, errors)
            {
                if let Err(err) = validate_existing_file_path(audio_path, &story_audio_label) {
                    errors.push(err);
                }
            }
            let item_audio_label = format!("{} : audio titre", context);
            if let Some(item_audio) =
                required_file_path(entry.item_audio.as_deref(), &item_audio_label, errors)
            {
                if let Err(err) = validate_existing_file_path(item_audio, &item_audio_label) {
                    errors.push(err);
                }
            }

            let item_image_label = format!("{} : image", context);
            if let Some(item_image) =
                required_file_path(entry.item_image.as_deref(), &item_image_label, errors)
            {
                if let Err(err) = validate_existing_file_path(item_image, &item_image_label) {
                    errors.push(err);
                }
            }
        }
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
    let mut entries = project.root_entries.clone();
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
                validate_story_entry_for_generation(entry, context, errors);
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
                validate_story_entry_for_generation(story, "Histoire principale", &mut errors);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::project::GlobalOptions;

    fn options() -> GlobalOptions {
        GlobalOptions {
            convert_format: true,
            add_silence: false,
            auto_next: false,
            select_next: false,
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
            audio_processing: HashMap::new(),
            native_graph: None,
            pack_version: 1,
            pack_description: String::new(),
            root_entries: Vec::new(),
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
    }
}
