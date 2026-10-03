//! Acquisition et cycle de vie de `packIdentity`.
//!
//! Le générateur est injecté partout : une identité tirée du CSPRNG rendrait
//! les assertions d'unicité indécidables. La source de production est éprouvée
//! séparément, sur sa distribution, par `system_pack_identity_low_bytes_*`.

use crate::native_pack::persistence::{
    create_advanced_document, decode_authoring_payload, encode_authoring_payload,
    initialize_advanced_document, initialize_advanced_payload, system_pack_identity,
    validate_authoring_payload, IdentityStatus,
};
use crate::native_pack::preparation::{prepare_graph_document_for_export, ExportPreparationError};
use crate::native_pack::readiness::{
    assess_graph_document_export_readiness, DimensionId, DimensionQualification,
};
use crate::native_pack::{
    decode_story_document, DecodedStoryDocument, DocumentOrigin, PackIdentityOrigin, Presence,
    StoryDocumentContext,
};
use serde_json::json;
use uuid::Uuid;

const CANONICAL: &str = "0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34";
const HYPHENLESS: &str = "0F9C2A411D3E4A8B9C772F5B6E10AB34";
const BRACED: &str = "{0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34}";
const TEXTUAL: &str = "stage-d-entree";
const SECOND: &str = "123e4567-e89b-12d3-a456-426614174000";

/// Générateur déterministe : la même suite d'UUID à chaque exécution, et le
/// compte exact des tirages réellement effectués.
struct Draws {
    made: Vec<Uuid>,
}

impl Draws {
    fn new() -> Self {
        Self { made: Vec::new() }
    }

    /// Une suite fixe et canonique, distincte de toute identité de fixture.
    fn next(&mut self) -> Uuid {
        let index = self.made.len() as u128 + 1;
        let value = Uuid::from_u128(0x9e37_79b9_7f4a_7c15_0000_0000_0000_0000 | index);
        self.made.push(value);
        value
    }
}

/// L'entrée mène au second Écran quand il existe ; elle n'est jamais un choix
/// (`port_rules`). Seule, elle est un Écran terminal, comme un projet neuf.
fn document(entry: &str, second: Option<&str>) -> serde_json::Value {
    let controls = json!({"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false});
    let Some(second) = second else {
        return json!({
            "format": "v1", "version": 1,
            "stageNodes": [{
                "uuid": entry, "squareOne": true, "audio": null, "image": null,
                "controlSettings": {"wheel":false,"ok":false,"home":false,"pause":false,"autoplay":false}, "homeTransition": null, "okTransition": null
            }],
            "actionNodes": []
        });
    };
    json!({
        "format": "v1", "version": 1,
        "stageNodes": [
            {
                "uuid": entry, "squareOne": true, "audio": null, "image": null,
                "controlSettings": controls, "homeTransition": null,
                "okTransition": {"actionNode": "menu", "optionIndex": 0}
            },
            {
                "uuid": second, "squareOne": false, "audio": null, "image": null,
                "controlSettings": {"wheel":false,"ok":false,"home":true,"pause":false,"autoplay":false}, "homeTransition": null, "okTransition": null
            }
        ],
        "actionNodes": [{"id": "menu", "options": [second]}]
    })
}

fn decode(value: serde_json::Value) -> DecodedStoryDocument {
    decode_story_document(&value.to_string()).expect("document décodable")
}

fn acquire(source: serde_json::Value, draws: &mut Draws) -> (String, DecodedStoryDocument) {
    let payload =
        initialize_advanced_document(decode(source), &mut || draws.next()).expect("acquisition");
    let reopened = decode_authoring_payload(&payload).expect("réouverture");
    (payload, reopened)
}

/// Une identité source bridge-compatible est conservée **sans
/// normalisation lexicale**, et l'acquisition ne tire alors aucun UUID.
#[test]
fn a_bridge_compatible_source_identity_is_kept_byte_for_byte() {
    for entry in [CANONICAL, HYPHENLESS] {
        let mut draws = Draws::new();
        let (_, reopened) = acquire(document(entry, Some(SECOND)), &mut draws);

        assert!(
            draws.made.is_empty(),
            "{entry} : aucune génération attendue"
        );
        assert_eq!(
            reopened.context.pack_identity.origin,
            PackIdentityOrigin::SquareOneStage
        );
        assert_eq!(
            reopened.context.pack_identity.value.as_deref(),
            Some(entry),
            "graphie auteur et identité identiques à l'entrée"
        );
        assert_eq!(reopened.document.stage_nodes[0].uuid, entry);
        assert_eq!(
            reopened.context.pack_identity.short_identity.as_deref(),
            Some("6E10AB34"),
            "{entry} : même identité courte chez les deux passerelles"
        );
        assert_eq!(reopened.context.pack_identity.generation_reason, None);
    }
}

/// Graphie entre accolades et identifiant textuel : les deux branches PREPARED.
/// Le document d'auteur n'est pas réécrit, l'identité est canonique, et la
/// copie préparée la porte avec une table injective.
#[test]
fn an_unusable_source_identity_is_generated_once_without_touching_the_author() {
    for entry in [BRACED, TEXTUAL] {
        let mut draws = Draws::new();
        let source = document(entry, Some(SECOND));

        // Avant acquisition, la préparation refuse — sur l'identité, pas sur le graphe.
        let before = prepare_graph_document_for_export(&decode(source.clone()))
            .expect_err("identité non résolue");
        assert!(
            matches!(&before, ExportPreparationError::PackIdentity { message }
                if message.contains("génération") || message.contains("ambiguë")),
            "{entry} : {before:?}"
        );

        let (payload, reopened) = acquire(source.clone(), &mut draws);

        assert_eq!(draws.made.len(), 1, "{entry} : une seule génération");
        let generated = draws.made[0].to_string();
        let identity = &reopened.context.pack_identity;
        assert_eq!(identity.origin, PackIdentityOrigin::Generated);
        assert_eq!(identity.value.as_deref(), Some(generated.as_str()));
        assert_eq!(identity.unresolved_reason, None, "{entry} : motif éteint");
        assert!(
            identity
                .generation_reason
                .as_deref()
                .is_some_and(|reason| !reason.is_empty()),
            "{entry} : la trace du motif survit à la résolution"
        );
        assert_eq!(identity.source_path.as_deref(), reopened_source_path(entry));

        // Document d'auteur strictement inchangé.
        assert_eq!(reopened.document, decode(source).document);
        assert_eq!(reopened.document.stage_nodes[0].uuid, entry);

        // La copie préparée porte l'identité générée ; la table reste injective.
        let prepared = prepare_graph_document_for_export(&reopened).expect("copie préparée");
        assert_eq!(prepared.document.stage_nodes[0].uuid, generated);
        assert_eq!(
            prepared.standard_value()["stageNodes"][0]["uuid"],
            generated
        );
        let targets: std::collections::HashSet<_> = prepared.stage_id_map.values().collect();
        assert_eq!(targets.len(), prepared.stage_id_map.len());
        assert_eq!(prepared.stage_id_map.len(), 2);

        // Le résumé d'ouverture voit une identité résolue, sans lire le payload.
        assert_eq!(
            validate_authoring_payload(&payload)
                .expect("résumé")
                .identity_status,
            IdentityStatus::Resolved
        );
    }
}

/// Le chemin d'auteur du Stage dont l'identité a été lue puis écartée.
fn reopened_source_path(entry: &str) -> Option<&str> {
    match entry {
        BRACED => Some("/stageNodes/@uuid={0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34}#0"),
        TEXTUAL => Some("/stageNodes/@uuid=stage-d-entree#0"),
        _ => None,
    }
}

/// L'identité d'un projet créé vient du générateur, jamais de son nom : deux
/// projets de même titre ont deux identités, et le titre n'apparaît nulle part
/// dans l'identité tirée (aucune dérivation d'un nom ou d'un chemin n'est
/// permise).
#[test]
fn a_created_project_gets_one_identity_independent_of_its_name() {
    let mut draws = Draws::new();
    let mut identities = Vec::new();
    for title in ["Même titre", "Même titre", "Autre titre"] {
        let payload = create_advanced_document(title, &mut || draws.next()).expect("création");
        let mut reopened = decode_authoring_payload(&payload).expect("réouverture");

        assert_eq!(reopened.context.document_origin, DocumentOrigin::Created);
        assert_eq!(
            reopened.document.title.value().map(String::as_str),
            Some(title)
        );
        let identity = reopened.context.pack_identity.clone();
        assert_eq!(identity.origin, PackIdentityOrigin::Generated);
        let value = identity.value.clone().expect("identité résolue");
        assert!(
            !value.contains("titre"),
            "identité dérivée du nom : {value}"
        );

        // Le Stage créé porte son propre UUID canonique, distinct
        // de l'identité du pack, que seule la copie d'export lui substituera.
        let stage = reopened.document.stage_nodes[0].uuid.clone();
        assert_ne!(stage, value);
        assert!(Uuid::parse_str(&stage).is_ok(), "Stage créé non canonique");
        assert!(reopened.document.stage_nodes[0]
            .control_settings
            .is_complete());
        // Le Stage d'entrée est nommé : sans nom, le graphe montrait son UUID.
        assert_eq!(reopened.document.stage_nodes[0].label(), "Écran 1");
        // Et il a sa position d'auteur, comme tout nœud créé ensuite.
        let position = reopened.document.stage_nodes[0]
            .position
            .value()
            .expect("position d'auteur");
        assert_eq!(
            (position.x.as_f64(), position.y.as_f64()),
            (Some(0.0), Some(0.0))
        );

        assert!(prepare_graph_document_for_export(&reopened).is_err());
        reopened.document.stage_nodes[0]
            .control_settings
            .value_mut()
            .expect("controls")
            .ok = Presence::Value(false);
        let prepared =
            prepare_graph_document_for_export(&reopened).expect("entry with OK disabled");
        assert_eq!(prepared.standard_value()["uuid"], value);
        assert_eq!(prepared.standard_value()["stageNodes"][0]["uuid"], value);
        identities.push(value);
    }
    assert_eq!(draws.made.len(), 6, "un Stage et une identité par création");
    let distinct: std::collections::HashSet<_> = identities.iter().collect();
    assert_eq!(distinct.len(), 3, "une identité par projet");
}

/// Réappliquer l'initialiseur ne tire jamais un second UUID : c'est ce qui
/// interdit à deux appels rapprochés du cycle de vie de fabriquer deux
/// identités concurrentes pour un même projet.
#[test]
fn reapplying_the_initializer_never_draws_a_second_identity() {
    let mut draws = Draws::new();
    let (first, _) = acquire(document(TEXTUAL, Some(SECOND)), &mut draws);
    assert_eq!(draws.made.len(), 1);

    let mut current = first.clone();
    for _ in 0..3 {
        current = initialize_advanced_payload(&current, &mut || draws.next())
            .expect("réapplication idempotente");
        assert_eq!(current, first, "payload identique à l'octet près");
        assert_eq!(draws.made.len(), 1, "aucun tirage supplémentaire");
    }
}

/// L'identité survit à tout ce qui suit : réouvertures répétées, réordre des
/// Stages, réassignation de `squareOne`, deux préparations — et au changement
/// de nom de fichier que fera `Save As`, qui n'entre dans aucune de ces
/// structures.
#[test]
fn the_persisted_identity_survives_reorder_square_one_and_two_preparations() {
    let mut draws = Draws::new();
    let (payload, _) = acquire(document(BRACED, Some(SECOND)), &mut draws);
    let expected = draws.made[0].to_string();

    let mut current = payload;
    for cycle in 0..2 {
        let mut reopened = decode_authoring_payload(&current).expect("réouverture");
        assert_eq!(
            reopened.context.pack_identity.value.as_deref(),
            Some(expected.as_str()),
            "cycle {cycle}"
        );

        reopened.document.stage_nodes.swap(0, 1);
        reopened.document.stage_nodes[0].square_one = Presence::Value(true);
        reopened.document.stage_nodes[1].square_one = Presence::Value(false);
        // La nouvelle entrée ouvre le menu, qui mène à l'autre Écran : l'entrée
        // n'est jamais un choix (`port_rules`).
        let opening = reopened.document.stage_nodes[1].ok_transition.clone();
        reopened.document.stage_nodes[0].ok_transition = opening;
        reopened.document.stage_nodes[1].ok_transition = Presence::Null;
        reopened.document.stage_nodes[0].control_settings = Presence::Value(
            crate::native_pack::ControlSettings::authored(false, true, false, false, false),
        );
        reopened.document.stage_nodes[1].control_settings = Presence::Value(
            crate::native_pack::ControlSettings::authored(false, false, true, false, false),
        );
        let other = reopened.document.stage_nodes[1].uuid.clone();
        reopened.document.action_nodes[0].options = vec![Some(other)];

        let first = prepare_graph_document_for_export(&reopened).expect("préparation 1");
        let second = prepare_graph_document_for_export(&reopened).expect("préparation 2");
        assert_eq!(first.stage_id_map, second.stage_id_map, "table stable");
        assert_eq!(first.standard_value()["stageNodes"][0]["uuid"], expected);

        current = encode_authoring_payload(&reopened).expect("réécriture");
    }
    let final_identity = decode_authoring_payload(&current)
        .expect("dernière réouverture")
        .context
        .pack_identity;
    assert_eq!(final_identity.value.as_deref(), Some(expected.as_str()));
    assert_eq!(final_identity.origin, PackIdentityOrigin::Generated);
    assert_eq!(draws.made.len(), 1);
}

/// Le contexte d'une projection FS traverse l'acquisition intact : provenance,
/// quadrillage séparé et qualification d'export sont ceux d'avant. Seule
/// l'identité change, et seulement si elle devait être générée.
#[test]
fn an_fs_conversion_context_crosses_acquisition_unchanged() {
    let mut decoded = decode(document(CANONICAL, Some(SECOND)));
    decoded.document.version = Presence::Value(256);
    decoded.context = StoryDocumentContext::imported_fs(&decoded.document, CANONICAL);
    let before = decoded.context.clone();

    let mut draws = Draws::new();
    let payload = initialize_advanced_document(decoded, &mut || draws.next()).expect("acquisition");
    let reopened = decode_authoring_payload(&payload).expect("réouverture");

    assert!(
        draws.made.is_empty(),
        "entrée FS exploitable : aucun tirage"
    );
    assert_eq!(reopened.context, before, "contexte de conversion intact");
    assert_eq!(reopened.context.document_origin, DocumentOrigin::ImportedFs);
    assert_eq!(
        reopened.context.pack_identity.origin,
        PackIdentityOrigin::FsEntryStage
    );
    assert!(!reopened.context.editor_positions.is_empty());
    assert!(reopened
        .document
        .stage_nodes
        .iter()
        .all(|stage| stage.position.is_absent()));
    assert!(reopened
        .context
        .export_qualifications
        .iter()
        .any(|qualification| qualification.dimension == "studio-export-version"));
}

/// Générer une identité ne rend valide aucun graphe qui ne l'était pas. Sur un
/// `squareOne` ambigu — qui est aussi la raison de la génération — GVI refuse
/// toujours, avec les mêmes erreurs, et la préparation refuse sur le graphe.
#[test]
fn generating_an_identity_does_not_rescue_an_invalid_graph() {
    let mut source = document(TEXTUAL, Some(SECOND));
    source["stageNodes"][1]["squareOne"] = json!(true);
    let decoded = decode(source);

    let before = assess_graph_document_export_readiness(Ok(&decoded));
    assert!(before.blocked);

    let mut draws = Draws::new();
    let payload =
        initialize_advanced_document(decoded, &mut || draws.next()).expect("acquisition possible");
    let reopened = decode_authoring_payload(&payload).expect("réouverture");
    let after = assess_graph_document_export_readiness(Ok(&reopened));

    assert_eq!(draws.made.len(), 1, "l'identité est bien générée");
    assert!(after.blocked, "le graphe reste invalide");
    assert_eq!(
        before.integrity_errors().collect::<Vec<_>>(),
        after.integrity_errors().collect::<Vec<_>>(),
        "les erreurs GVI sont inchangées"
    );
    assert_eq!(after.interoperability, DimensionQualification::Untested);
    assert_eq!(after.unevaluated.len(), DimensionId::ALL.len());
    assert!(prepare_graph_document_for_export(&reopened).is_err());
}

/// Sur un graphe valide, la génération qualifie **sa** dimension et rien
/// d'autre : `pack-identity` sort d'`unevaluated` en `PREPARED`, tandis qu'aucune autre
/// dimension ne change et qu'aucun diagnostic n'est effacé.
#[test]
fn generating_an_identity_qualifies_only_its_own_dimension() {
    let mut source = document(BRACED, Some(SECOND));
    // Une extension inconnue sans disposition : elle doit rester UNTESTED et
    // bloquante avant comme après la résolution de l'identité.
    source["stageNodes"][1]["stageExtension"] = json!({"inconnu": true});
    let decoded = decode(source);

    let before = assess_graph_document_export_readiness(Ok(&decoded));
    assert!(before
        .unevaluated
        .iter()
        .any(|dimension| dimension.id == DimensionId::PackIdentity));

    let mut draws = Draws::new();
    let payload = initialize_advanced_document(decoded, &mut || draws.next()).expect("acquisition");
    let reopened = decode_authoring_payload(&payload).expect("réouverture");
    let after = assess_graph_document_export_readiness(Ok(&reopened));

    assert_eq!(draws.made.len(), 1);
    assert!(
        !after
            .unevaluated
            .iter()
            .any(|dimension| dimension.id == DimensionId::PackIdentity),
        "l'identité résolue devient observable"
    );
    let identity = after
        .dimensions
        .iter()
        .find(|dimension| dimension.id == DimensionId::PackIdentity)
        .expect("dimension pack-identity qualifiée");
    assert_eq!(identity.qualification, DimensionQualification::Prepared);

    // Aucune autre dimension n'est créée, supprimée ni requalifiée.
    for dimension in &before.dimensions {
        let matched = after
            .dimensions
            .iter()
            .find(|other| other.id == dimension.id)
            .unwrap_or_else(|| panic!("{:?} disparue après génération", dimension.id));
        assert_eq!(
            matched.qualification, dimension.qualification,
            "{:?} requalifiée par la génération d'identité",
            dimension.id
        );
    }
    assert_eq!(after.dimensions.len(), before.dimensions.len() + 1);
    assert!(after
        .dimensions
        .iter()
        .any(|dimension| dimension.id == DimensionId::UnknownExtension
            && dimension.qualification == DimensionQualification::Untested));
    assert_eq!(
        after.diagnostics.len(),
        before.diagnostics.len(),
        "aucun diagnostic effacé ni ajouté"
    );
    assert!(
        after.blocked,
        "l'extension sans disposition bloque toujours"
    );
    assert_eq!(after.interoperability, DimensionQualification::Untested);
}

/// Les 4 octets de poids faible de l'identité générée décident du nom de
/// dossier lu par les deux passerelles. Cette preuve porte donc sur la **source
/// de production**, pas sur le générateur des tests, et sur la distribution des
/// 32 bits, pas sur l'absence de collision — dix UUID distincts ne prouveraient
/// rien.
#[test]
fn system_pack_identity_low_bytes_are_uniform_and_canonical() {
    const DRAWS: usize = 4096;
    let mut ones = [0_usize; 32];
    for _ in 0..DRAWS {
        let uuid = system_pack_identity();
        assert_eq!(uuid.get_version_num(), 4, "UUID aléatoire attendu");
        let text = uuid.to_string();
        assert!(
            crate::native_pack::classify_stage_id(&text).bridge_compatible,
            "identité générée non bridge-compatible : {text}"
        );
        let low = uuid.as_u128() as u32;
        for (bit, count) in ones.iter_mut().enumerate() {
            *count += usize::from(low >> bit & 1 == 1);
        }
    }
    // Bande très large : pour n = 4096 et p = 0,5, l'écart type vaut 32, donc
    // ces bornes sont à près de treize écarts types. Un biais structurel — bit
    // figé, octet dérivé d'un compteur ou d'une horloge — les franchit ; l'aléa
    // ne les franchit pas.
    for (bit, count) in ones.iter().enumerate() {
        assert!(
            (DRAWS * 2 / 5..=DRAWS * 3 / 5).contains(count),
            "bit {bit} des 4 octets faibles biaisé : {count}/{DRAWS}"
        );
    }
}

/// Mesure sur la bibliothèque locale, ignorée par défaut : la transmission 08c
/// annonce **deux** documents réels dont l'identité source est inexploitable.
/// Le test le vérifie sur les octets, et vérifie surtout l'invariant inverse —
/// aucune identité déjà exploitable n'est touchée par l'acquisition.
#[test]
#[ignore = "requires STORY_STUDIO_B2_CORPUS_DIR with the local library"]
fn private_corpus_identity_resolution_is_measured() {
    let root = std::path::PathBuf::from(std::env::var("STORY_STUDIO_B2_CORPUS_DIR").unwrap());
    let mut entries: Vec<_> = std::fs::read_dir(&root)
        .expect("corpus lisible")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    entries.sort();

    let mut draws = Draws::new();
    let (mut generated, mut kept, mut undecodable) = (0_usize, 0_usize, 0_usize);
    for path in &entries {
        let raw = std::fs::read_to_string(path).expect("document lisible");
        let Ok(decoded) = decode_story_document(&raw) else {
            undecodable += 1;
            continue;
        };
        let source = decoded.context.pack_identity.clone();
        let document = decoded.document.clone();
        let payload =
            initialize_advanced_document(decoded, &mut || draws.next()).expect("acquisition");
        let reopened = decode_authoring_payload(&payload).expect("réouverture");
        let identity = &reopened.context.pack_identity;

        assert_ne!(
            identity.origin,
            PackIdentityOrigin::RequiresGeneration,
            "{path:?} : identité non résolue après acquisition"
        );
        assert_eq!(reopened.document, document, "{path:?} : auteur réécrit");
        if source.origin == PackIdentityOrigin::RequiresGeneration {
            generated += 1;
            assert_eq!(identity.origin, PackIdentityOrigin::Generated, "{path:?}");
        } else {
            kept += 1;
            assert_eq!(*identity, source, "{path:?} : identité source modifiée");
        }
    }

    // La mesure est la sortie utile de ce test ; `--nocapture` la rend lisible.
    eprintln!(
        "corpus {} fichier(s) : {} décodable(s), {kept} identité(s) conservée(s), {generated} générée(s), {undecodable} refusé(s) au décodage",
        entries.len(),
        entries.len() - undecodable
    );
    assert_eq!(
        generated,
        draws.made.len(),
        "un tirage par identité générée"
    );
    assert_eq!(generated, 2, "deux entrées textuelles annoncées par 08c");
}
