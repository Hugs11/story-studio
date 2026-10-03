//! Oracle de présence du dialecte STUdio v1.
//!
//! L'oracle d'auteur porte sur **présence + valeur**. Pour chaque champ suivi,
//! le document source est classé en `absent` / `null` / valeur,
//! puis confronté au même classement effectué sur le document ré-émis après un
//! aller-retour `StoryDocument`. Une divergence de classe est une information
//! détruite ou inventée, même quand la valeur métier reste plausible.
//!
//! Les nombres sont comparés par **valeur** (`serde_json::Value` compare les
//! `f64` entre eux), jamais comme chaînes : le dialecte autorise une réécriture
//! décimale plus courte désignant le même `f64`.
//!
//! Les tests ordinaires de ce module sont autonomes. Le banc sur le corpus
//! privé des 366 `story.json` reste `#[ignore]` et piloté par variables
//! d'environnement.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

/// Les trois formes qu'un champ peut prendre dans un objet JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Form {
    Absent,
    Null,
    Value,
}

impl Form {
    pub(super) fn label_for_test(self) -> &'static str {
        self.label()
    }

    fn label(self) -> &'static str {
        match self {
            Form::Absent => "absent",
            Form::Null => "null",
            Form::Value => "value",
        }
    }
}

/// Classe un champ d'un objet JSON.
pub(super) fn form_of(object: &Map<String, Value>, key: &str) -> Form {
    match object.get(key) {
        None => Form::Absent,
        Some(Value::Null) => Form::Null,
        Some(_) => Form::Value,
    }
}

/// Une information de présence détruite ou inventée par l'aller-retour.
#[derive(Debug, Clone)]
pub(super) struct PresenceDivergence {
    /// `stageNodes/#/groupId`, indices effacés : la forme du champ, pas l'occurrence.
    pub(super) shape: String,
    /// `absent→value`, `value→absent`, `value→value` (valeur changée), …
    pub(super) transition: String,
    pub(super) occurrences: usize,
}

/// Résultat d'un aller-retour confronté à sa source, sur les champs suivis.
#[derive(Debug, Clone, Default)]
pub(super) struct PresenceScan {
    /// Champs du périmètre réellement confrontés, toutes occurrences comprises.
    pub(super) fields_compared: usize,
    /// Occurrences dont la classe **et** la valeur sont conservées.
    pub(super) fields_preserved: usize,
    /// Divergences agrégées par forme de champ et par transition.
    pub(super) divergences: BTreeMap<(String, String), usize>,
    /// Répartition des formes rencontrées côté source, par forme de champ.
    pub(super) source_forms: BTreeMap<(String, String), usize>,
}

impl PresenceScan {
    fn compare(
        &mut self,
        shape: &str,
        source: &Map<String, Value>,
        roundtrip: &Map<String, Value>,
        key: &str,
    ) {
        let source_form = form_of(source, key);
        let roundtrip_form = form_of(roundtrip, key);
        self.fields_compared += 1;
        *self
            .source_forms
            .entry((shape.to_string(), source_form.label().to_string()))
            .or_default() += 1;

        let identical = source_form == roundtrip_form
            && (source_form != Form::Value || source.get(key) == roundtrip.get(key));
        if identical {
            self.fields_preserved += 1;
            return;
        }
        let transition = format!("{}→{}", source_form.label(), roundtrip_form.label());
        *self
            .divergences
            .entry((shape.to_string(), transition))
            .or_default() += 1;
    }

    pub(super) fn divergence_total(&self) -> usize {
        self.divergences.values().sum()
    }

    pub(super) fn flattened(&self) -> Vec<PresenceDivergence> {
        self.divergences
            .iter()
            .map(|((shape, transition), occurrences)| PresenceDivergence {
                shape: shape.clone(),
                transition: transition.clone(),
                occurrences: *occurrences,
            })
            .collect()
    }

    pub(super) fn absorb(&mut self, other: &PresenceScan) {
        self.fields_compared += other.fields_compared;
        self.fields_preserved += other.fields_preserved;
        for (key, count) in &other.divergences {
            *self.divergences.entry(key.clone()).or_default() += count;
        }
        for (key, count) in &other.source_forms {
            *self.source_forms.entry(key.clone()).or_default() += count;
        }
    }
}

/// Champs racine suivis.
pub(super) const ROOT_FIELDS: [&str; 7] = [
    "format",
    "title",
    "version",
    "description",
    "nightModeAvailable",
    "uuid",
    "factoryDisabled",
];

/// Champs de Stage suivis.
pub(super) const STAGE_FIELDS: [&str; 9] = [
    "name",
    "type",
    "squareOne",
    "position",
    "groupId",
    "audio",
    "image",
    "okTransition",
    "homeTransition",
];

/// Champs d'Action suivis. `squareOne` n'est pas un champ d'Action.
pub(super) const ACTION_FIELDS: [&str; 4] = ["name", "type", "position", "groupId"];

/// Confronte un document source et son aller-retour sur les champs suivis.
///
/// Les nœuds sont appariés par position dans leur tableau : l'aller-retour
/// d'auteur ne réordonne pas les collections.
pub(super) fn compare_presence(source: &Value, roundtrip: &Value) -> Result<PresenceScan, String> {
    let mut scan = PresenceScan::default();
    let source_root = source
        .as_object()
        .ok_or_else(|| "document source non objet".to_string())?;
    let roundtrip_root = roundtrip
        .as_object()
        .ok_or_else(|| "document ré-émis non objet".to_string())?;

    for field in ROOT_FIELDS {
        scan.compare(field, source_root, roundtrip_root, field);
    }

    compare_node_array(
        &mut scan,
        source_root,
        roundtrip_root,
        "stageNodes",
        &STAGE_FIELDS,
    )?;
    compare_node_array(
        &mut scan,
        source_root,
        roundtrip_root,
        "actionNodes",
        &ACTION_FIELDS,
    )?;
    compare_action_options(&mut scan, source_root, roundtrip_root)?;
    Ok(scan)
}

fn compare_node_array(
    scan: &mut PresenceScan,
    source_root: &Map<String, Value>,
    roundtrip_root: &Map<String, Value>,
    collection: &str,
    fields: &[&str],
) -> Result<(), String> {
    let source_nodes = source_root
        .get(collection)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let roundtrip_nodes = roundtrip_root
        .get(collection)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if source_nodes.len() != roundtrip_nodes.len() {
        return Err(format!(
            "{collection}: {} nœuds source contre {} ré-émis",
            source_nodes.len(),
            roundtrip_nodes.len()
        ));
    }
    for (source_node, roundtrip_node) in source_nodes.iter().zip(roundtrip_nodes.iter()) {
        let (Some(source_node), Some(roundtrip_node)) =
            (source_node.as_object(), roundtrip_node.as_object())
        else {
            return Err(format!("{collection}: nœud non objet"));
        };
        for field in fields {
            scan.compare(
                &format!("{collection}/#/{field}"),
                source_node,
                roundtrip_node,
                field,
            );
        }
    }
    Ok(())
}

/// `Action.options` est un tableau : un élément n'y est jamais « absent », mais
/// il peut être `null`. Chaque élément est confronté par indice, et une
/// longueur différente est comptée comme autant de cibles détruites.
fn compare_action_options(
    scan: &mut PresenceScan,
    source_root: &Map<String, Value>,
    roundtrip_root: &Map<String, Value>,
) -> Result<(), String> {
    let source_nodes = source_root
        .get("actionNodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let roundtrip_nodes = roundtrip_root
        .get("actionNodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let shape = "actionNodes/#/options/#".to_string();
    for (source_node, roundtrip_node) in source_nodes.iter().zip(roundtrip_nodes.iter()) {
        let source_options = source_node
            .get("options")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let roundtrip_options = roundtrip_node
            .get("options")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for index in 0..source_options.len().max(roundtrip_options.len()) {
            scan.fields_compared += 1;
            let source_element = source_options.get(index);
            let roundtrip_element = roundtrip_options.get(index);
            let source_label = element_label(source_element);
            *scan
                .source_forms
                .entry((shape.clone(), source_label.to_string()))
                .or_default() += 1;
            if source_element == roundtrip_element {
                scan.fields_preserved += 1;
                continue;
            }
            let transition = format!("{source_label}→{}", element_label(roundtrip_element));
            *scan
                .divergences
                .entry((shape.clone(), transition))
                .or_default() += 1;
        }
    }
    Ok(())
}

fn element_label(element: Option<&Value>) -> &'static str {
    match element {
        None => "absent",
        Some(Value::Null) => "null",
        Some(_) => "value",
    }
}

// ---------------------------------------------------------------------------
// Banc local : les 366 `story.json` matérialisés de la bibliothèque privée.
// Corpus privé, ignoré par Git ; le banc reste `#[ignore]`.
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceLibraryRecord {
    library_index: u32,
    relative_path: String,
    source_format: String,
    story_json_path: Option<String>,
}

#[test]
#[ignore = "campagne locale : fidélité de présence des story.json privés"]
fn d1_a2_measure_raw_corpus_presence_fidelity() {
    use std::fs;
    use std::path::Path;

    let index_path =
        std::env::var("STORY_STUDIO_D1_A2_LIBRARY").expect("STORY_STUDIO_D1_A2_LIBRARY requis");
    let output_path =
        std::env::var("STORY_STUDIO_D1_A2_OUTPUT").expect("STORY_STUDIO_D1_A2_OUTPUT requis");
    let content = fs::read_to_string(Path::new(&index_path)).expect("index de bibliothèque");
    let library: Vec<PresenceLibraryRecord> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("JSONL de bibliothèque"))
        .collect();

    let mut per_format: BTreeMap<String, (usize, usize, usize, usize)> = BTreeMap::new();
    let mut totals = PresenceScan::default();
    let mut undecodable = Vec::new();
    let mut divergent_documents = Vec::new();
    let mut scanned = 0_usize;

    for record in &library {
        let Some(story_json_path) = record.story_json_path.as_ref() else {
            continue;
        };
        let raw = fs::read_to_string(story_json_path).expect("story.json matérialisé");
        let source: Value = serde_json::from_str(&raw).expect("story.json valide");
        scanned += 1;
        let entry = per_format
            .entry(record.source_format.clone())
            .or_insert((0, 0, 0, 0));
        entry.0 += 1;

        let document =
            match serde_json::from_value::<crate::native_pack::StoryDocument>(source.clone()) {
                Ok(document) => document,
                Err(error) => {
                    entry.3 += 1;
                    undecodable.push(serde_json::json!({
                        "libraryIndex": record.library_index,
                        "relativePath": record.relative_path,
                        "sourceFormat": record.source_format,
                        "error": error.to_string(),
                    }));
                    continue;
                }
            };
        let roundtrip = serde_json::to_value(&document).expect("ré-émission du document");
        let scan = compare_presence(&source, &roundtrip).expect("comparaison de présence");
        entry.1 += scan.fields_compared;
        entry.2 += scan.divergence_total();
        if scan.divergence_total() > 0 {
            divergent_documents.push(serde_json::json!({
                "libraryIndex": record.library_index,
                "relativePath": record.relative_path,
                "sourceFormat": record.source_format,
                "divergences": scan
                    .flattened()
                    .iter()
                    .map(|divergence| serde_json::json!({
                        "shape": divergence.shape,
                        "transition": divergence.transition,
                        "occurrences": divergence.occurrences,
                    }))
                    .collect::<Vec<_>>(),
            }));
        }
        totals.absorb(&scan);
    }

    let by_format = per_format
        .iter()
        .map(|(format, (documents, compared, divergent, undecodable))| {
            serde_json::json!({
                "sourceFormat": format,
                "documents": documents,
                "fieldsCompared": compared,
                "divergentFields": divergent,
                "undecodableDocuments": undecodable,
            })
        })
        .collect::<Vec<_>>();
    let divergences_by_shape = totals
        .divergences
        .iter()
        .map(|((shape, transition), count)| {
            serde_json::json!({
                "shape": shape,
                "transition": transition,
                "occurrences": count,
            })
        })
        .collect::<Vec<_>>();
    let source_forms = totals
        .source_forms
        .iter()
        .map(|((shape, form), count)| {
            serde_json::json!({ "shape": shape, "form": form, "occurrences": count })
        })
        .collect::<Vec<_>>();

    let report = serde_json::json!({
        "schemaVersion": 1,
        "libraryIndex": index_path,
        "documentsScanned": scanned,
        "fieldsCompared": totals.fields_compared,
        "fieldsPreserved": totals.fields_preserved,
        "divergentFields": totals.divergence_total(),
        "bySourceFormat": by_format,
        "divergencesByShape": divergences_by_shape,
        "sourceForms": source_forms,
        "undecodableDocuments": undecodable,
        "divergentDocuments": divergent_documents,
    });
    fs::write(
        &output_path,
        serde_json::to_vec_pretty(&report).expect("JSON de campagne"),
    )
    .expect("écriture de la campagne");
    eprintln!(
        "campagne écrite: {output_path} ({scanned} documents, {} champs divergents)",
        totals.divergence_total()
    );
}

// ---------------------------------------------------------------------------
// Tests ordinaires : les trois états, champ par champ. Autonomes, aucun corpus.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod three_states {
    use super::{compare_presence, form_of, Form, ACTION_FIELDS, ROOT_FIELDS, STAGE_FIELDS};
    use crate::native_pack::StoryDocument;
    use serde_json::{json, Value};

    /// Le plus petit document décodable : uniquement les clés de la structure
    /// obligatoire. Aucun champ présence-sensible n'y figure.
    fn minimal_document() -> Value {
        json!({
            "stageNodes": [{
                "uuid": "stage-1",
                "controlSettings": {
                    "wheel": true, "ok": true, "home": false,
                    "pause": false, "autoplay": false
                }
            }],
            "actionNodes": [{ "id": "action-1", "options": ["stage-1"] }]
        })
    }

    /// Où poser le champ à éprouver.
    #[derive(Clone, Copy)]
    enum Scope {
        Root,
        Stage,
        Action,
    }

    fn with_field(scope: Scope, key: &str, value: Option<Value>) -> Value {
        let mut document = minimal_document();
        let target = match scope {
            Scope::Root => document.as_object_mut().expect("racine"),
            Scope::Stage => document["stageNodes"][0].as_object_mut().expect("stage"),
            Scope::Action => document["actionNodes"][0].as_object_mut().expect("action"),
        };
        match value {
            Some(value) => {
                target.insert(key.to_string(), value);
            }
            None => {
                target.remove(key);
            }
        }
        document
    }

    fn scope_of(document: &Value, scope: Scope) -> &serde_json::Map<String, Value> {
        match scope {
            Scope::Root => document.as_object().expect("racine"),
            Scope::Stage => document["stageNodes"][0].as_object().expect("stage"),
            Scope::Action => document["actionNodes"][0].as_object().expect("action"),
        }
    }

    /// Aller-retour d'auteur : source → `StoryDocument` → source.
    fn roundtrip(document: &Value) -> Value {
        let decoded: StoryDocument =
            serde_json::from_value(document.clone()).expect("document décodable");
        serde_json::to_value(&decoded).expect("document ré-émis")
    }

    /// Une valeur d'épreuve par champ, du bon type JSON.
    fn sample(key: &str) -> Value {
        match key {
            "version" => json!(7),
            "nightModeAvailable" | "squareOne" | "factoryDisabled" => json!(true),
            "position" => json!({ "x": 1.5, "y": -2 }),
            "okTransition" | "homeTransition" => json!({
                "actionNode": "action-1", "optionIndex": 0
            }),
            _ => json!(format!("valeur-{key}")),
        }
    }

    fn fields() -> Vec<(Scope, &'static str)> {
        ROOT_FIELDS
            .iter()
            .map(|field| (Scope::Root, *field))
            .chain(STAGE_FIELDS.iter().map(|field| (Scope::Stage, *field)))
            .chain(ACTION_FIELDS.iter().map(|field| (Scope::Action, *field)))
            .collect()
    }

    /// Après désérialisation **et** après re-sérialisation, absent, `null` et
    /// valeur restent trois formes distinctes, pour chacun des vingt champs
    /// suivis.
    ///
    /// Le dialecte ne qualifie pas `null` pour tous ces champs. Le test ne le
    /// prétend pas : il vérifie que la forme rencontrée est **conservée**, ce
    /// qui laisse à un classificateur (intégrité du graphe) le soin de la juger.
    #[test]
    fn every_presence_sensitive_field_keeps_its_three_states() {
        for (scope, key) in fields() {
            let absent = with_field(scope, key, None);
            let null = with_field(scope, key, Some(Value::Null));
            let value = with_field(scope, key, Some(sample(key)));

            for (label, source, expected) in [
                ("absent", &absent, Form::Absent),
                ("null", &null, Form::Null),
                ("valeur", &value, Form::Value),
            ] {
                let emitted = roundtrip(source);
                let observed = form_of(scope_of(&emitted, scope), key);
                assert_eq!(
                    observed,
                    expected,
                    "{key} en forme «{label}» ressort en «{}»",
                    observed.label_for_test()
                );
                assert_eq!(
                    scope_of(&emitted, scope).get(key),
                    scope_of(source, scope).get(key),
                    "{key} en forme «{label}» : valeur altérée"
                );
            }

            // Les trois formes doivent aussi rester distinctes **entre elles**,
            // pas seulement stables prises une à une.
            let forms = [&absent, &null, &value].map(|source| {
                let emitted = roundtrip(source);
                form_of(scope_of(&emitted, scope), key)
            });
            assert_eq!(forms.len(), 3);
            assert!(
                forms[0] != forms[1] && forms[1] != forms[2] && forms[0] != forms[2],
                "{key} : deux des trois formes sont devenues indiscernables"
            );
        }
    }

    /// Un `#[serde(default)]` historique ne crée jamais à lui seul une présence
    /// authored. Le document minimal ne ressort donc qu'avec les clés qu'il
    /// portait — c'est la garde qui tomberait si un champ perdait son
    /// `skip_serializing_if`.
    #[test]
    fn a_minimal_document_emits_only_the_keys_it_carried() {
        let emitted = roundtrip(&minimal_document());
        let keys = |object: &serde_json::Map<String, Value>| {
            let mut keys: Vec<String> = object.keys().cloned().collect();
            keys.sort();
            keys
        };
        assert_eq!(
            keys(scope_of(&emitted, Scope::Root)),
            vec!["actionNodes".to_string(), "stageNodes".to_string()]
        );
        assert_eq!(
            keys(scope_of(&emitted, Scope::Stage)),
            vec!["controlSettings".to_string(), "uuid".to_string()]
        );
        assert_eq!(
            keys(scope_of(&emitted, Scope::Action)),
            vec!["id".to_string(), "options".to_string()]
        );
        assert_eq!(
            compare_presence(&minimal_document(), &emitted)
                .unwrap()
                .divergence_total(),
            0
        );
    }

    /// La justification du mécanisme, rendue exécutable : avec `Option<T>`, la
    /// clé absente et la clé `null` produisent toutes deux `None`. C'est
    /// exactement la perte à supprimer, et la raison pour laquelle
    /// `Presence<T>` ne pouvait pas être un `Option`.
    #[test]
    fn a_plain_option_cannot_tell_absent_from_null() {
        #[derive(serde::Deserialize)]
        struct WithOption {
            #[serde(default)]
            audio: Option<String>,
        }

        let absent: WithOption = serde_json::from_value(json!({})).expect("absent");
        let null: WithOption = serde_json::from_value(json!({ "audio": null })).expect("null");
        assert!(absent.audio.is_none() && null.audio.is_none());

        // La même distinction, lue **directement sur le modèle** : elle survit
        // à la désérialisation, elle n'est pas seulement restituée à l'écriture.
        let decoded_absent: StoryDocument =
            serde_json::from_value(with_field(Scope::Stage, "audio", None)).expect("absent");
        let decoded_null: StoryDocument =
            serde_json::from_value(with_field(Scope::Stage, "audio", Some(Value::Null)))
                .expect("null");
        let decoded_value: StoryDocument =
            serde_json::from_value(with_field(Scope::Stage, "audio", Some(json!("a.mp3"))))
                .expect("valeur");
        assert!(decoded_absent.stage_nodes[0].audio.is_absent());
        assert!(matches!(
            decoded_null.stage_nodes[0].audio,
            crate::native_pack::Presence::Null
        ));
        assert_eq!(decoded_value.stage_nodes[0].audio.as_deref(), Some("a.mp3"));

        // Le même couple, traversé par le modèle : les deux formes se séparent.
        let stage_absent = roundtrip(&with_field(Scope::Stage, "audio", None));
        let stage_null = roundtrip(&with_field(Scope::Stage, "audio", Some(Value::Null)));
        assert_eq!(
            form_of(scope_of(&stage_absent, Scope::Stage), "audio"),
            Form::Absent
        );
        assert_eq!(
            form_of(scope_of(&stage_null, Scope::Stage), "audio"),
            Form::Null
        );
    }

    /// Les quatre champs enrichis connus sont représentables et conservés. Une
    /// valeur inconnue est conservée telle quelle, jamais remappée vers une
    /// étiquette connue.
    #[test]
    fn known_enriched_fields_survive_without_being_reinterpreted() {
        let source = json!({
            "stageNodes": [{
                "uuid": "stage-1",
                "type": "type-inconnu-de-story-studio",
                "groupId": "groupe-42",
                "controlSettings": {
                    "wheel": true, "ok": true, "home": false,
                    "pause": false, "autoplay": false
                }
            }],
            "actionNodes": [{
                "id": "action-1",
                "type": "action-type-inconnu",
                "groupId": "groupe-42",
                "options": ["stage-1"]
            }]
        });
        let emitted = roundtrip(&source);
        assert_eq!(
            emitted, source,
            "un enrichi connu a été perdu ou réinterprété"
        );
    }

    /// Un `Vec<String>` rejetterait une cible `null` : tout le document
    /// échouerait au décodage et basculerait sur le chemin JSON brut, avant
    /// qu'aucun classificateur ne l'ait vue. Elle atteint le classificateur,
    /// sans être convertie en chaîne vide et sans décaler les indices.
    #[test]
    fn a_null_option_target_reaches_the_classifier_at_its_index() {
        let source = json!({
            "stageNodes": [{
                "uuid": "stage-1",
                "controlSettings": {
                    "wheel": true, "ok": true, "home": false,
                    "pause": false, "autoplay": false
                }
            }],
            "actionNodes": [{
                "id": "action-1",
                "options": ["stage-1", null, "stage-1"]
            }]
        });
        let decoded: StoryDocument =
            serde_json::from_value(source.clone()).expect("cible nulle décodable");
        let options = &decoded.action_nodes[0].options;
        assert_eq!(options.len(), 3);
        assert_eq!(options[1], None, "la cible nulle doit rester nulle");
        assert_eq!(
            options[2].as_deref(),
            Some("stage-1"),
            "l'indice des options suivantes ne doit pas glisser"
        );
        assert_eq!(roundtrip(&source), source);
    }

    /// `factoryDisabled` est un champ connu **opaque**. Le modèle ne le type
    /// pas en booléen, donc une graphie inattendue ne fait pas échouer tout le
    /// document avant d'atteindre un classificateur.
    #[test]
    fn an_unexpected_factory_disabled_shape_is_kept_opaque() {
        for shape in [json!(true), json!("oui"), json!(0), json!({ "raw": 1 })] {
            let source = with_field(Scope::Root, "factoryDisabled", Some(shape.clone()));
            let emitted = roundtrip(&source);
            assert_eq!(emitted["factoryDisabled"], shape);
        }
    }

    /// La racine `uuid` ne doit pas être injectée après coup par le writer ni par
    /// le convertisseur FS, sans quoi elle serait perdue à la relecture : elle
    /// appartient au document.
    #[test]
    fn the_root_uuid_survives_a_reread() {
        let source = with_field(
            Scope::Root,
            "uuid",
            Some(json!("28e6c4a0-1c1a-4a3a-9d3a-9f27f1d0b111")),
        );
        let emitted = roundtrip(&source);
        assert_eq!(emitted["uuid"], source["uuid"]);
        let reread = roundtrip(&emitted);
        assert_eq!(reread, source);
    }

    /// Une position source est conservée avec sa **valeur** `f64`, y compris
    /// fractionnaire, et une position absente n'est pas remplacée par un
    /// `{0,0}` synthétique.
    #[test]
    fn a_source_position_keeps_its_value_and_an_absent_one_stays_absent() {
        let source = with_field(
            Scope::Stage,
            "position",
            Some(json!({ "x": -990.4606467901111, "y": 120.25 })),
        );
        let emitted = roundtrip(&source);
        assert_eq!(
            emitted["stageNodes"][0]["position"]["x"]
                .as_f64()
                .map(f64::to_bits),
            Some((-990.4606467901111_f64).to_bits())
        );
        assert_eq!(emitted["stageNodes"][0]["position"]["y"], json!(120.25));

        let without = roundtrip(&minimal_document());
        assert!(without["stageNodes"][0].get("position").is_none());
        assert!(without["actionNodes"][0].get("position").is_none());
    }
}

/// Aller-retour **ciblé** sur A051 et A135 au niveau du
/// document d'auteur : source `story.json` → représentation → écriture →
/// relecture, avec comparaison des champs modélisés **et de leur présence**.
///
/// Les deux packs sont privés ; le test reste `#[ignore]` et prend leurs
/// chemins par variables d'environnement. Il assène les compteurs attendus
/// (211 `Stage.groupId`, 128 `Action.groupId`, 128 `Action.type`,
/// 213 `Stage.type != "stage"`) plutôt que de se contenter de les mesurer.
#[test]
#[ignore = "campagne locale : oracle d'auteur enrichi sur A051 et A135"]
fn d1_a2_enriched_fields_of_a051_and_a135_survive_the_author_roundtrip() {
    use std::fs;

    let mut totals = (0_usize, 0_usize, 0_usize, 0_usize);
    for variable in ["STORY_STUDIO_D1_A2_A051", "STORY_STUDIO_D1_A2_A135"] {
        let path = std::env::var(variable).unwrap_or_else(|_| panic!("{variable} requis"));
        let raw = fs::read_to_string(&path).expect("story.json du pack");
        let source: Value = serde_json::from_str(&raw).expect("story.json valide");

        let document = serde_json::from_value::<crate::native_pack::StoryDocument>(source.clone())
            .expect("document d'auteur décodable");
        let saved = serde_json::to_value(&document).expect("sauvegarde du document");
        // Réouverture : le second cycle doit être un point fixe.
        let reopened = serde_json::from_value::<crate::native_pack::StoryDocument>(saved.clone())
            .expect("document rouvert");
        let rewritten = serde_json::to_value(&reopened).expect("réécriture du document");
        assert_eq!(
            saved, rewritten,
            "{variable} : la réouverture n'est pas stable"
        );

        let scan = compare_presence(&source, &saved).expect("comparaison de présence");
        assert_eq!(
            scan.divergence_total(),
            0,
            "{variable} : {:?}",
            scan.flattened()
        );

        for stage in &document.stage_nodes {
            if stage.group_id.is_value() {
                totals.0 += 1;
            }
            if stage
                .stage_type
                .as_deref()
                .is_some_and(|value| value != crate::native_pack::STAGE_TYPE_FALLBACK)
            {
                totals.3 += 1;
            }
        }
        for action in &document.action_nodes {
            if action.group_id.is_value() {
                totals.1 += 1;
            }
            if action.action_type.is_value() {
                totals.2 += 1;
            }
        }
    }

    assert_eq!(
        totals,
        (211, 128, 128, 213),
        "compteurs enrichis A051+A135 (Stage.groupId, Action.groupId, Action.type, Stage.type != stage)"
    );
}
