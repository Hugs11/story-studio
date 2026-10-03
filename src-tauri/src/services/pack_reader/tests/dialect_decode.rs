use crate::native_pack::{
    classify_stage_id, decode_story_document, DiagnosticSeverity, DocumentOrigin, ExtensionScope,
    InteroperabilityStatus, OpaqueExportDisposition, OpaqueMemberKind, PackIdentityOrigin,
    Presence, ValueOrigin,
};

fn document_with(stage_extra: &str, root_extra: &str, transition: &str) -> String {
    format!(
        r#"{{
          "format":"v1","version":6,"title":"Dialecte",
          "stageNodes":[{{
            "uuid":"11111111-2222-3333-4444-555566667777",
            "id":"11111111-2222-3333-4444-555566667777",
            "controlSettings":{{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":true,
              "vendorControl":{{"fraction":-990.4606467901111,"deep":{{"flag":true}}}}}},
            "okTransition":{transition},"homeTransition":null,
            "position":{{"x":12.5,"y":42,"vendorPosition":"kept"}},
            "duration":1234{stage_extra}
          }}],
          "actionNodes":[{{
            "id":"action-1","uuid":"action-1","options":["11111111-2222-3333-4444-555566667777"],
            "position":{{"x":0,"y":0}},"vendorAction":[1,2,3]
          }}],
          "storyStudioMetadata":{{"owner":"third-party"}},
          "image":"https://example.invalid/cover.png","official":true{root_extra}
        }}"#
    )
}

#[test]
fn opaque_extensions_are_captured_at_every_known_scope_without_automatic_emission() {
    let raw = document_with(
        "",
        "",
        r#"{"actionNode":"action-1","optionIndex":0,"vendorTransition":{"nested":[0.1]}}"#,
    );
    let decoded = decode_story_document(&raw).expect("decode complete dialect");

    assert_eq!(
        decoded.context.document_origin,
        DocumentOrigin::ImportedStudio
    );
    assert_eq!(
        decoded.context.default_value_origin,
        ValueOrigin::SourceStudio
    );
    assert_eq!(
        decoded
            .context
            .value_provenance
            .iter()
            .filter(|entry| entry.path.ends_with("/position"))
            .count(),
        2
    );
    assert!(decoded.context.editor_positions.is_empty());
    for (scope, key) in [
        (ExtensionScope::Root, "storyStudioMetadata"),
        (ExtensionScope::Stage, "duration"),
        (ExtensionScope::Action, "vendorAction"),
        (ExtensionScope::Transition, "vendorTransition"),
        (ExtensionScope::ControlSettings, "vendorControl"),
        (ExtensionScope::Position, "vendorPosition"),
    ] {
        assert!(
            decoded.context.opaque_members.iter().any(|member| {
                member.scope == scope
                    && member.key == key
                    && member.kind == OpaqueMemberKind::UnknownExtension
                    && member.export_disposition.is_none()
            }),
            "extension manquante {scope:?}/{key}"
        );
    }

    let fraction = decoded
        .context
        .opaque_members
        .iter()
        .find(|member| member.key == "vendorControl")
        .and_then(|member| member.value.get("fraction"))
        .and_then(serde_json::Value::as_f64)
        .expect("fraction in nested extension");
    assert_eq!(fraction.to_bits(), (-990.4606467901111_f64).to_bits());

    let standard = serde_json::to_value(&decoded.document).expect("serialize typed document");
    assert!(standard.get("storyStudioMetadata").is_none());
    assert!(standard.get("image").is_none());
    assert!(standard.get("official").is_none());
    assert!(standard["stageNodes"][0].get("duration").is_none());
    assert!(standard["stageNodes"][0]["okTransition"]
        .get("vendorTransition")
        .is_none());
    assert!(standard["stageNodes"][0]["controlSettings"]
        .get("vendorControl")
        .is_none());

    let saved_payload = serde_json::to_value(&decoded).expect("save authoring payload");
    assert!(saved_payload.get("sourceValue").is_none());
    assert!(saved_payload["context"]["opaqueMembers"]
        .as_array()
        .is_some_and(|members| members.len() >= 9));
    let restored: crate::native_pack::DecodedStoryDocument =
        serde_json::from_value(saved_payload).expect("reopen authoring payload");
    assert_eq!(
        restored.context.opaque_members,
        decoded.context.opaque_members
    );
}

#[test]
fn known_aliases_and_never_emitted_root_members_keep_their_provenance() {
    let decoded = decode_story_document(&document_with(
        "",
        "",
        r#"{"actionNode":"action-1","optionIndex":0}"#,
    ))
    .expect("decode aliases");

    for (key, kind) in [
        ("id", OpaqueMemberKind::KnownAlias),
        ("uuid", OpaqueMemberKind::KnownAlias),
        ("image", OpaqueMemberKind::KnownNeverEmitted),
        ("official", OpaqueMemberKind::KnownNeverEmitted),
    ] {
        assert!(decoded.context.opaque_members.iter().any(|member| {
            member.key == key
                && member.kind == kind
                && member.export_disposition == Some(OpaqueExportDisposition::NeverEmitStandard)
        }));
    }
}

#[test]
fn a_divergent_known_alias_stays_untested_without_an_implicit_disposition() {
    let raw = document_with(
        r#", "id":"different-stage-id""#,
        "",
        r#"{"actionNode":"action-1","optionIndex":0}"#,
    );
    let decoded = decode_story_document(&raw).expect("decode divergent alias");
    let aliases = decoded
        .context
        .opaque_members
        .iter()
        .filter(|member| member.kind == OpaqueMemberKind::KnownAlias)
        .collect::<Vec<_>>();
    // Le second `id` gagne dans l'objet Stage avant classification. Il diffère
    // du `uuid` canonique et ne reçoit donc aucune décision silencieuse.
    assert!(aliases.iter().any(|member| {
        member.scope == ExtensionScope::Stage
            && member.key == "id"
            && member.value == serde_json::json!("different-stage-id")
            && member.export_disposition.is_none()
    }));
}

#[test]
fn opaque_members_are_anchored_to_source_identity_not_array_index() {
    let raw = document_with(
        r#", "stageSpecific":{"looksLikeId":"11111111-2222-3333-4444-555566667777"}"#,
        "",
        r#"{"actionNode":"action-1","optionIndex":0}"#,
    );
    let mut decoded = decode_story_document(&raw).expect("decode anchored extension");
    let path = decoded
        .context
        .opaque_members
        .iter()
        .find(|member| member.key == "stageSpecific")
        .expect("stage extension")
        .path
        .clone();
    let opaque_value = decoded
        .context
        .opaque_members
        .iter()
        .find(|member| member.key == "stageSpecific")
        .expect("stage extension")
        .value
        .clone();
    decoded.document.stage_nodes.reverse();
    decoded.document.stage_nodes[0].uuid = "remapped-only-on-export-copy".to_string();

    assert!(path.contains("@uuid=11111111-2222-3333-4444-555566667777#0"));
    assert!(!path.contains("/0/"));
    assert_eq!(
        opaque_value["looksLikeId"],
        "11111111-2222-3333-4444-555566667777"
    );
}

#[test]
fn duplicate_known_root_members_are_last_wins_with_exact_warning_values() {
    let raw = r#"{
      "title":"premier","version":0,"title":"dernier","version":256,
      "stageNodes":[],"actionNodes":[]
    }"#;
    let decoded = decode_story_document(raw).expect("last wins decode");

    assert_eq!(
        decoded.document.title.value().map(String::as_str),
        Some("dernier")
    );
    assert_eq!(decoded.document.version.value().copied(), Some(256));
    assert_eq!(decoded.context.diagnostics.len(), 2);
    for diagnostic in &decoded.context.diagnostics {
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
        assert_eq!(diagnostic.code, "duplicate-root-key-last-wins");
        assert_eq!(diagnostic.discarded.len(), 1);
        assert!(!diagnostic.retained.is_absent());
    }
    let title = decoded
        .context
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.path == "/title")
        .expect("title warning");
    assert_eq!(
        title.retained,
        crate::native_pack::Presence::from_json(serde_json::json!("dernier"))
    );
    assert_eq!(title.discarded, vec![serde_json::json!("premier")]);
}

#[test]
fn reversing_duplicate_order_reverses_the_retained_value() {
    let first = decode_story_document(
        r#"{"title":"a","title":"b","version":1,"stageNodes":[],"actionNodes":[]}"#,
    )
    .expect("a then b");
    let second = decode_story_document(
        r#"{"title":"b","title":"a","version":1,"stageNodes":[],"actionNodes":[]}"#,
    )
    .expect("b then a");
    assert_eq!(first.document.title.value().map(String::as_str), Some("b"));
    assert_eq!(second.document.title.value().map(String::as_str), Some("a"));
}

#[test]
fn incomplete_or_below_minus_one_transitions_are_refused_with_a_path() {
    for (transition, code) in [
        (r#"{"optionIndex":0}"#, "transition-missing-action-node"),
        (
            r#"{"actionNode":"action-1"}"#,
            "transition-missing-option-index",
        ),
        (
            r#"{"actionNode":"action-1","optionIndex":-2}"#,
            "transition-option-index-below-minus-one",
        ),
    ] {
        let error = decode_story_document(&document_with("", "", transition))
            .expect_err("transition must be rejected");
        assert!(
            error.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == code
                    && diagnostic.path.starts_with(
                        "/stageNodes/@uuid=11111111-2222-3333-4444-555566667777#0/okTransition",
                    )
            }),
            "diagnostic inattendu: {error}"
        );
    }
}

#[test]
fn direct_typed_transition_decode_is_strict_too() {
    for raw in [
        r#"{"actionNode":"a"}"#,
        r#"{"optionIndex":0}"#,
        r#"{"actionNode":"a","optionIndex":-2}"#,
    ] {
        assert!(serde_json::from_str::<crate::native_pack::Transition>(raw).is_err());
    }
}

#[test]
fn raw_transition_reader_never_defaults_a_missing_index_to_zero() {
    let action = serde_json::json!({"id":"action-1","options":["stage-0"]});
    let actions = std::collections::HashMap::from([("action-1", &action)]);
    let missing = serde_json::json!({"actionNode":"action-1"});
    let invalid = serde_json::json!({"actionNode":"action-1","optionIndex":-2});

    assert_eq!(
        super::super::transitions::transition_target_stage_id(Some(&missing), &actions),
        None
    );
    assert_eq!(
        super::super::transitions::transition_target_stage_id(Some(&invalid), &actions),
        None
    );
}

/// Table confrontée à `uuid.UUID(v).hex[24:].upper()` et à
/// `v.replace('-','')[-8:].upper()` exécutés sur les parseurs figés. Les six
/// premières lignes sont les cas de référence ; les suivantes couvrent la
/// grammaire complète de `int(hex, 16)` que CPython applique après avoir retiré
/// `urn:`, `uuid:`, les accolades de bord et tous les tirets.
#[test]
fn stage_id_classification_uses_the_common_short_identity() {
    let cases = [
        (
            "123e4567-e89b-12d3-a456-426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        (
            "123E4567E89B12D3A456426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        (
            "{123e4567-e89b-12d3-a456-426614174000}",
            false,
            Some("14174000"),
            Some("4174000}"),
        ),
        ("stage-textuel", false, None, Some("ETEXTUEL")),
        ("court", false, None, None),
        // Tiret hors position : refusé par `Uuid::parse_str`, accepté par la
        // passerelle, et les deux identités courtes coïncident.
        (
            "123e4567e89b-12d3a456426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        // Accolade ouvrante seule : `str.strip('{}')` retire les deux bords.
        (
            "{123e4567-e89b-12d3-a456-426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        // Préfixes retirés par substitution, avec ou sans `urn:`.
        (
            "uuid:123e4567-e89b-12d3-a456-426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        (
            "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        // Formes acceptées par `int(hex, 16)` une fois ramenées à 32 caractères.
        (
            " 23e4567e89b12d3a456426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        (
            "+23e4567e89b12d3a456426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        (
            "0x3e4567e89b12d3a456426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        (
            "1_3e4567e89b12d3a456426614174000",
            true,
            Some("14174000"),
            Some("14174000"),
        ),
        // Et celles qu'il refuse : soulignés en tête ou en fin, chiffre invalide.
        (
            "_23e4567e89b12d3a456426614174000",
            false,
            None,
            Some("14174000"),
        ),
        (
            "23e4567e89b12d3a45642661417400__",
            false,
            None,
            Some("417400__"),
        ),
        (
            "123e4567-e89b-12d3-a456-42661417400g",
            false,
            None,
            Some("1417400G"),
        ),
        // Accolades appariées ou inversées : parsables, identités divergentes.
        (
            "}123e4567e89b12d3a456426614174000{",
            false,
            Some("14174000"),
            Some("4174000{"),
        ),
    ];

    for (value, compatible, luniiqt, dantsu) in cases {
        let classification = classify_stage_id(value);
        assert_eq!(classification.bridge_compatible, compatible, "{value}");
        assert_eq!(classification.short_luniiqt.as_deref(), luniiqt, "{value}");
        assert_eq!(classification.short_dantsu.as_deref(), dantsu, "{value}");
    }
}

#[test]
fn stage_id_python_integer_edges_preserve_the_bridge_predicate() {
    // Résultats de uuid.UUID avec CPython 3.14 / Unicode 16.0.
    for (id, accepted) in [
        ("١23e4567e89b12d3a456426614174000", true),
        ("𝟙23e4567e89b12d3a456426614174000", true),
        ("0x_e4567e89b12d3a456426614174000", true),
        ("٠x_e4567e89b12d3a456426614174000", true),
        ("\u{a0}23e4567e89b12d3a456426614174000", true),
        ("\u{85}23e4567e89b12d3a456426614174000", true),
        ("\u{1c}23e4567e89b12d3a456426614174000", false),
        ("\u{1d}23e4567e89b12d3a456426614174000", false),
        ("\u{1e}23e4567e89b12d3a456426614174000", false),
        ("\u{1f}23e4567e89b12d3a456426614174000", false),
        ("²23e4567e89b12d3a456426614174000", false),
        ("0x__4567e89b12d3a456426614174000", false),
    ] {
        let classification = classify_stage_id(id);
        assert_eq!(classification.bridge_compatible, accepted, "{id:?}");
        assert_eq!(
            classification.short_luniiqt.as_deref(),
            accepted.then_some("14174000"),
            "{id:?}"
        );
    }
}

#[test]
fn explicit_versions_have_no_allowlist() {
    for version in [0, 1, 2, 6, 8, 256, i32::MAX, i32::MIN] {
        let raw = format!(r#"{{"version":{version},"stageNodes":[],"actionNodes":[]}}"#);
        let decoded = decode_story_document(&raw).expect("version without allowlist");
        assert_eq!(decoded.document.version.value().copied(), Some(version));
    }
}

#[test]
#[ignore = "campagne locale : définir STORY_STUDIO_D1_A3_LIBRARY et STORY_STUDIO_D1_A3_OUTPUT"]
fn d1_a3_classifies_the_complete_local_story_json_corpus() {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

    let library = PathBuf::from(
        std::env::var("STORY_STUDIO_D1_A3_LIBRARY").expect("STORY_STUDIO_D1_A3_LIBRARY requis"),
    );
    let output = PathBuf::from(
        std::env::var("STORY_STUDIO_D1_A3_OUTPUT").expect("STORY_STUDIO_D1_A3_OUTPUT requis"),
    );
    let index = fs::read_to_string(&library).expect("read library index");
    let mut documents = 0_usize;
    let mut opaque_members = 0_usize;
    let mut warnings = 0_usize;
    let mut by_scope = BTreeMap::<String, usize>::new();
    let mut by_kind = BTreeMap::<String, usize>::new();
    let mut failures = Vec::new();

    for (line_index, line) in index.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record: serde_json::Value = serde_json::from_str(line).expect("valid JSONL record");
        let Some(path) = record
            .get("storyJsonPath")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        documents += 1;
        let raw = fs::read_to_string(path).expect("read materialized story.json");
        match decode_story_document(&raw) {
            Ok(decoded) => {
                opaque_members += decoded.context.opaque_members.len();
                warnings += decoded.context.diagnostics.len();
                for member in decoded.context.opaque_members {
                    *by_scope.entry(format!("{:?}", member.scope)).or_default() += 1;
                    *by_kind.entry(format!("{:?}", member.kind)).or_default() += 1;
                }
            }
            Err(error) => failures.push(serde_json::json!({
                "line": line_index + 1,
                "path": path,
                "diagnostics": error.diagnostics,
            })),
        }
    }

    assert_eq!(documents, 366, "inventaire local incomplet");
    assert!(failures.is_empty(), "documents refusés: {failures:#?}");
    let report = serde_json::json!({
        "schemaVersion": 1,
        "documents": documents,
        "decoded": documents - failures.len(),
        "refused": failures.len(),
        "opaqueMembers": opaque_members,
        "warnings": warnings,
        "byScope": by_scope,
        "byKind": by_kind,
        "failures": failures,
    });
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("create report directory");
    }
    fs::write(
        output,
        serde_json::to_vec_pretty(&report).expect("serialize report"),
    )
    .expect("write report");
}

/// Document minimal dont on choisit l'identité et l'entrée : `entry` est
/// l'identifiant du Stage `squareOne`, `extra_stage` un second Stage brut.
fn document_with_identity(entry: &str, root_uuid: &str, extra_stage: &str) -> String {
    format!(
        r#"{{
          "format":"v1","version":1,"title":"Identité","uuid":"{root_uuid}",
          "stageNodes":[{{
            "uuid":"{entry}","squareOne":true,
            "controlSettings":{{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":true}},
            "okTransition":{{"actionNode":"action-1","optionIndex":0}},"homeTransition":null
          }}{extra_stage}],
          "actionNodes":[{{"id":"action-1","options":["{entry}"]}}]
        }}"#
    )
}

/// Le payload porte l'emplacement de `packIdentity`. L'identité vient du Stage
/// `squareOne`, jamais de la racine `uuid`, qui n'est pas autoritaire.
#[test]
fn the_payload_carries_the_stable_pack_identity_of_its_entry_stage() {
    let hyphenless = "123E4567E89B12D3A456426614174000";
    let decoded = decode_story_document(&document_with_identity(
        hyphenless,
        "99999999-8888-7777-6666-555544443333",
        "",
    ))
    .expect("decode identity document");

    let identity = &decoded.context.pack_identity;
    assert_eq!(identity.origin, PackIdentityOrigin::SquareOneStage);
    assert_eq!(
        identity.value.as_deref(),
        Some(hyphenless),
        "une graphie source bridge-compatible n'est jamais normalisée"
    );
    assert_eq!(identity.short_identity.as_deref(), Some("14174000"));
    assert_eq!(
        identity.source_path.as_deref(),
        Some(format!("/stageNodes/@uuid={hyphenless}#0").as_str())
    );
    assert!(identity.unresolved_reason.is_none());
    assert_ne!(
        identity.value.as_deref(),
        decoded.document.uuid.as_deref(),
        "la racine uuid ne fournit pas l'identité"
    );

    // L'emplacement survit à la sauvegarde et à la réouverture du payload.
    let saved = serde_json::to_value(&decoded).expect("save payload");
    assert_eq!(
        saved["context"]["packIdentity"]["value"],
        serde_json::json!(hyphenless)
    );
    let restored: crate::native_pack::DecodedStoryDocument =
        serde_json::from_value(saved).expect("reopen payload");
    assert_eq!(restored.context.pack_identity, *identity);
}

/// Une identité source inexploitable ne fabrique aucune valeur ici : l'identité
/// doit être **stable**, donc générée et persistée une seule fois. Un UUID tiré
/// à chaque décodage serait exactement le contraire.
#[test]
fn an_unusable_entry_identity_is_reported_as_requiring_generation() {
    let cases = [
        ("stage-textuel", "", "identité d'entrée non parsable", true),
        (
            "{123e4567-e89b-12d3-a456-426614174000}",
            "",
            "graphie parsable mais identité courte divergente",
            true,
        ),
        (
            "123e4567-e89b-12d3-a456-426614174000",
            r#",{"uuid":"22222222-3333-4444-5555-666677778888","squareOne":true,
                "controlSettings":{"wheel":false,"ok":false,"home":false,"pause":false,"autoplay":true},
                "okTransition":null,"homeTransition":null}"#,
            "deux Stages squareOne",
            true,
        ),
    ];

    for (entry, extra_stage, label, source_path_expected) in cases {
        let decoded = decode_story_document(&document_with_identity(
            entry,
            "99999999-8888-7777-6666-555544443333",
            extra_stage,
        ))
        .unwrap_or_else(|error| panic!("{label} : {error}"));
        let identity = &decoded.context.pack_identity;
        assert_eq!(
            identity.origin,
            PackIdentityOrigin::RequiresGeneration,
            "{label}"
        );
        assert!(identity.value.is_none(), "{label}");
        assert!(identity.unresolved_reason.is_some(), "{label}");
        assert_eq!(
            identity.source_path.is_some(),
            source_path_expected,
            "{label}"
        );
    }

    // Aucun Stage d'entrée du tout : même conclusion, sans chemin source.
    let decoded =
        decode_story_document(r#"{"format":"v1","version":1,"stageNodes":[],"actionNodes":[]}"#)
            .expect("decode empty document");
    assert_eq!(
        decoded.context.pack_identity.origin,
        PackIdentityOrigin::RequiresGeneration
    );
    assert!(decoded.context.pack_identity.source_path.is_none());
}

/// Document dont l'objet de contrôles est fourni tel quel par l'appelant.
fn document_with_controls(controls: &str) -> String {
    format!(
        r#"{{
          "format":"v1","version":1,"title":"Contrôles",
          "stageNodes":[{{
            "uuid":"123e4567-e89b-12d3-a456-426614174000","squareOne":true,
            {controls}
            "okTransition":{{"actionNode":"action-1","optionIndex":0}},"homeTransition":null
          }}],
          "actionNodes":[{{"id":"action-1","options":["123e4567-e89b-12d3-a456-426614174000"]}}]
        }}"#
    )
}

/// Clause d'entrée : un objet de contrôles incomplet est **conservé** tel
/// quel, sans valeur par défaut ni déduction depuis la transition déclarée, et
/// il est signalé plus qualifié `UNTESTED`.
#[test]
fn an_incomplete_control_settings_object_is_preserved_qualified_and_never_completed() {
    let raw = document_with_controls(
        r#""controlSettings":{"wheel":false,"ok":true,"home":false,"pause":null},"#,
    );
    let decoded = decode_story_document(&raw).expect("un objet partiel est accepté");
    let stage = &decoded.document.stage_nodes[0];
    let controls = stage
        .control_settings
        .value()
        .expect("l'objet présent est conservé");

    assert_eq!(controls.ok, Presence::Value(true));
    assert_eq!(controls.wheel, Presence::Value(false));
    assert_eq!(controls.pause, Presence::Null, "un membre null reste null");
    assert_eq!(
        controls.autoplay,
        Presence::Absent,
        "un membre absent reste absent : la transition OK déclarée n'en déduit rien"
    );
    assert!(!stage.control_settings.is_complete());

    // La sérialisation restitue exactement la forme source.
    let emitted = serde_json::to_value(&decoded.document).expect("sérialiser le document");
    let emitted_controls = &emitted["stageNodes"][0]["controlSettings"];
    assert!(emitted_controls["pause"].is_null());
    assert!(
        emitted_controls.get("autoplay").is_none(),
        "un contrôle absent ne ressort pas à null"
    );

    let path = "/stageNodes/@uuid=123e4567-e89b-12d3-a456-426614174000#0/controlSettings";
    let diagnostic = decoded
        .context
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "control-settings-incomplete")
        .expect("diagnostic de contrôles incomplets");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    assert_eq!(diagnostic.path, path);
    assert!(diagnostic.message.contains("pause"));
    assert!(diagnostic.message.contains("autoplay"));

    let qualification = decoded
        .context
        .export_qualifications
        .iter()
        .find(|qualification| qualification.dimension == "studio-export-control-settings")
        .expect("qualification d'export");
    assert_eq!(qualification.path, path);
    assert_eq!(qualification.status, InteroperabilityStatus::Untested);
}

/// L'objet lui-même peut être absent ou `null` : les deux formes sont admises,
/// distinguées, et signalées.
#[test]
fn an_absent_or_null_control_settings_object_is_accepted_and_distinguished() {
    for (controls, expected_absent, marker) in [
        ("", true, "absent"),
        (r#""controlSettings":null,"#, false, "null"),
    ] {
        let decoded = decode_story_document(&document_with_controls(controls))
            .unwrap_or_else(|error| panic!("{marker} : {error}"));
        let stage = &decoded.document.stage_nodes[0];
        assert_eq!(
            stage.control_settings.is_absent(),
            expected_absent,
            "{marker}"
        );
        assert!(stage.control_settings.value().is_none(), "{marker}");
        assert!(!stage.control_settings.ok(), "{marker}");
        assert!(
            decoded
                .context
                .diagnostics
                .iter()
                .any(
                    |diagnostic| diagnostic.code == "control-settings-incomplete"
                        && diagnostic.message.contains(marker)
                ),
            "{marker}"
        );

        let emitted = serde_json::to_value(&decoded.document).expect("sérialiser le document");
        let emitted_controls = emitted["stageNodes"][0].get("controlSettings");
        if expected_absent {
            assert!(emitted_controls.is_none(), "{marker}");
        } else {
            assert!(
                emitted_controls.is_some_and(serde_json::Value::is_null),
                "{marker}"
            );
        }
    }
}

/// Une valeur de contrôle qui n'est pas un booléen est une erreur de **forme**,
/// refusée avec un code distinct de l'absence : aucun cast implicite.
#[test]
fn a_control_member_that_is_not_a_boolean_is_refused_with_its_own_code() {
    let stage_path = "/stageNodes/@uuid=123e4567-e89b-12d3-a456-426614174000#0/controlSettings";
    for (controls, code, path) in [
        (
            r#""controlSettings":{"wheel":false,"ok":"oui","home":false,"pause":false,"autoplay":false},"#,
            "control-settings-member-not-boolean",
            format!("{stage_path}/ok"),
        ),
        (
            r#""controlSettings":{"wheel":1,"ok":true,"home":false,"pause":false,"autoplay":false},"#,
            "control-settings-member-not-boolean",
            format!("{stage_path}/wheel"),
        ),
        (
            r#""controlSettings":{"wheel":false,"ok":true,"home":{"nested":true},"pause":false,"autoplay":false},"#,
            "control-settings-member-not-boolean",
            format!("{stage_path}/home"),
        ),
        (
            r#""controlSettings":5,"#,
            "control-settings-not-object",
            stage_path.to_string(),
        ),
    ] {
        let error = decode_story_document(&document_with_controls(controls))
            .expect_err("une forme invalide doit être refusée");
        assert!(
            error
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code && diagnostic.path == path),
            "attendu {code} sur {path}, obtenu {error}"
        );
    }
}
