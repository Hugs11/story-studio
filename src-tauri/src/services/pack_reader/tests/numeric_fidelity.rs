//! Oracle numérique du dialecte STUdio v1.
//!
//! La lecture d'un nombre JSON fractionnaire doit produire la valeur `f64`
//! correctement arrondie de son littéral source. Les tests de ce module
//! comparent des **bits** ou des **valeurs**, jamais des chaînes : le dialecte
//! autorise explicitement une réécriture plus courte désignant le même `f64`.
//!
//! Ils sont autonomes : aucun corpus privé, aucune variable d'environnement.
//! Les campagnes locales restent dans `triage_corpus.rs`.

use std::collections::BTreeMap;
use std::fmt;

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::native_pack::StoryDocument;

/// Les trois littéraux mesurés, mantisses longues issues de positions
/// réelles du corpus privé. Deux d'entre eux étaient décalés de 1 ULP tant que
/// `serde_json` était compilé sans `float_roundtrip`.
pub(super) const D1_V13_LITERALS: [&str; 3] = [
    "-990.4606467901111",
    "-2742.7341400021633",
    "-46.086472948193276",
];

/// Un nombre dont la lecture `serde_json` s'écarte de `str::parse::<f64>()`.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(super) struct NumberDivergence {
    pub(super) pointer: String,
    pub(super) literal: String,
    pub(super) ulp_distance: u64,
}

/// Résultat d'un parcours : ce qui a été regardé, et ce qui diverge.
#[derive(Debug, Clone, Default)]
pub(super) struct NumberScan {
    /// Nombre de littéraux fractionnaires réellement confrontés.
    pub(super) fractional_visited: usize,
    /// Emplacements des nombres fractionnaires, indices de tableau effacés :
    /// ils disent quels champs du dialecte portent réellement une fraction.
    pub(super) fractional_shapes: BTreeMap<String, usize>,
    pub(super) divergences: Vec<NumberDivergence>,
}

/// Efface les indices de tableau d'un pointeur JSON pour en faire une forme.
fn pointer_shape(pointer: &str) -> String {
    pointer
        .split('/')
        .map(|segment| {
            if !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit()) {
                "#"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Parcourt le texte JSON brut et confronte, pour chaque littéral numérique
/// fractionnaire et à toute profondeur — y compris dans une extension inconnue —
/// la valeur lue par `serde_json` à celle de la bibliothèque standard.
///
/// Le parcours passe par `RawValue`, seul moyen de récupérer le littéral source
/// exact sans le reconstruire depuis un `f64` déjà lu.
pub(super) fn scan_numbers(raw: &str) -> Result<NumberScan, String> {
    let root: &RawValue = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let mut scan = NumberScan::default();
    visit_raw(root, String::new(), &mut scan)?;
    Ok(scan)
}

/// Les paires d'un objet JSON, dans l'ordre du texte et sans fusion des doublons.
struct RawMembers(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for RawMembers {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MembersVisitor;

        impl<'de> Visitor<'de> for MembersVisitor {
            type Value = RawMembers;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("un objet JSON")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<RawMembers, A::Error> {
                let mut members = Vec::new();
                while let Some((key, value)) = access.next_entry::<String, Box<RawValue>>()? {
                    members.push((key, value));
                }
                Ok(RawMembers(members))
            }
        }

        deserializer.deserialize_map(MembersVisitor)
    }
}

fn visit_raw(node: &RawValue, pointer: String, scan: &mut NumberScan) -> Result<(), String> {
    let text = node.get().trim();
    match text.as_bytes().first() {
        Some(b'{') => {
            // Les paires sont collectées telles quelles, doublons compris : une clé
            // répétée ne doit pas soustraire son nombre au parcours.
            let members: RawMembers =
                serde_json::from_str(text).map_err(|error| error.to_string())?;
            for (key, value) in &members.0 {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                visit_raw(value, format!("{pointer}/{escaped}"), scan)?;
            }
        }
        Some(b'[') => {
            let items: Vec<Box<RawValue>> =
                serde_json::from_str(text).map_err(|error| error.to_string())?;
            for (index, item) in items.iter().enumerate() {
                visit_raw(item, format!("{pointer}/{index}"), scan)?;
            }
        }
        Some(byte) if byte.is_ascii_digit() || *byte == b'-' => {
            // Un littéral entier n'a pas de représentation `f64` intermédiaire :
            // seule la voie fractionnaire de `parse_decimal` est en cause.
            if !text.contains(['.', 'e', 'E']) {
                return Ok(());
            }
            let serde_value: f64 = serde_json::from_str(text).map_err(|error| error.to_string())?;
            let std_value: f64 = text
                .parse()
                .map_err(|_| format!("littéral {text} illisible"))?;
            scan.fractional_visited += 1;
            *scan
                .fractional_shapes
                .entry(pointer_shape(&pointer))
                .or_default() += 1;
            if serde_value.to_bits() != std_value.to_bits() {
                scan.divergences.push(NumberDivergence {
                    pointer,
                    literal: text.to_string(),
                    ulp_distance: serde_value.to_bits().abs_diff(std_value.to_bits()),
                });
            }
        }
        _ => {}
    }
    Ok(())
}

fn document_with_positions(literals: &[&str]) -> String {
    let stages = literals
        .iter()
        .enumerate()
        .map(|(index, literal)| {
            format!(
                r#"{{"uuid":"stage-{index}","name":"n{index}","type":"stage","squareOne":{square_one},"audio":null,"image":null,"controlSettings":{{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false}},"homeTransition":null,"okTransition":null,"position":{{"x":{literal},"y":{literal}}}}}"#,
                square_one = index == 0,
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"title":"t","version":1,"description":"d","format":"v1","nightModeAvailable":false,"actionNodes":[],"stageNodes":[{stages}]}}"#
    )
}

#[test]
fn d1_v13_literals_parse_to_the_standard_library_bits() {
    for literal in D1_V13_LITERALS {
        let number: serde_json::Number = serde_json::from_str(literal).expect("nombre JSON");
        let serde_value = number.as_f64().expect("nombre fractionnaire f64");
        let std_value = literal.parse::<f64>().expect("analyse standard f64");
        assert_eq!(
            serde_value.to_bits(),
            std_value.to_bits(),
            "littéral {literal} : lecture serde_json à {} ULP de str::parse::<f64>()",
            serde_value.to_bits().abs_diff(std_value.to_bits()),
        );
    }
}

#[test]
fn d1_v13_literals_survive_a_serde_json_roundtrip_by_value() {
    for literal in D1_V13_LITERALS {
        let number: serde_json::Number = serde_json::from_str(literal).expect("nombre JSON");
        let serialized = serde_json::to_string(&number).expect("sérialisation nombre");
        let reparsed: serde_json::Number =
            serde_json::from_str(&serialized).expect("relecture nombre");
        assert_eq!(
            number.as_f64().expect("f64 initial").to_bits(),
            reparsed.as_f64().expect("f64 relu").to_bits(),
            "littéral {literal} : aller-retour instable au niveau des bits",
        );
    }
}

#[test]
fn story_document_positions_keep_the_correctly_rounded_value() {
    let raw = document_with_positions(&D1_V13_LITERALS);
    let document: StoryDocument = serde_json::from_str(&raw).expect("StoryDocument");
    assert_eq!(document.stage_nodes.len(), D1_V13_LITERALS.len());

    for (stage, literal) in document.stage_nodes.iter().zip(D1_V13_LITERALS) {
        let expected = literal.parse::<f64>().expect("analyse standard f64");
        let position = stage.position.value().expect("position d'auteur conservée");
        for (axis, number) in [("x", &position.x), ("y", &position.y)] {
            let value = number.as_f64().expect("coordonnée f64");
            assert_eq!(
                value.to_bits(),
                expected.to_bits(),
                "{}.{axis} : {literal} lu comme {value:?}",
                stage.uuid,
            );
        }
    }

    // Le document réécrit doit redonner les mêmes valeurs : la graphie peut
    // légitimement raccourcir, la valeur non.
    let rewritten = serde_json::to_string(&document).expect("réécriture du document");
    let reread: StoryDocument = serde_json::from_str(&rewritten).expect("relecture StoryDocument");
    for (before, after) in document.stage_nodes.iter().zip(&reread.stage_nodes) {
        let before_position = before.position.value().expect("position avant");
        let after_position = after.position.value().expect("position après");
        for (axis, before_number, after_number) in [
            ("x", &before_position.x, &after_position.x),
            ("y", &before_position.y, &after_position.y),
        ] {
            assert_eq!(
                before_number.as_f64().expect("f64 avant").to_bits(),
                after_number.as_f64().expect("f64 après").to_bits(),
                "{}.{axis} : valeur altérée par l'aller-retour",
                before.uuid,
            );
        }
    }
}

#[test]
fn fractional_numbers_are_faithful_at_every_depth_including_unknown_extensions() {
    // FLD-002 étend l'exigence à tout nombre fractionnaire, extension opaque
    // comprise : le parcours brut couvre donc les clés inconnues, à toute
    // profondeur, y compris dans un tableau.
    let raw = format!(
        r#"{{"title":"t","version":1,"format":"v1","nightModeAvailable":false,"actionNodes":[],"stageNodes":[],"storyStudioMetadata":{{"duration":{first},"nested":[{{"deep":{second}}}]}},"unknownExtension":{third}}}"#,
        first = D1_V13_LITERALS[0],
        second = D1_V13_LITERALS[1],
        third = D1_V13_LITERALS[2],
    );
    let scan = scan_numbers(&raw).expect("parcours des nombres");
    assert_eq!(
        scan.fractional_visited,
        D1_V13_LITERALS.len(),
        "le parcours n'a pas atteint les trois nombres fractionnaires",
    );
    assert!(
        scan.divergences.is_empty(),
        "nombres altérés à la lecture : {:?}",
        scan.divergences,
    );
}

#[test]
fn a_whole_story_document_is_scanned_without_divergence() {
    let raw = document_with_positions(&D1_V13_LITERALS);
    let scan = scan_numbers(&raw).expect("parcours des nombres");
    assert_eq!(
        scan.fractional_visited,
        2 * D1_V13_LITERALS.len(),
        "les deux axes de chaque position doivent être confrontés",
    );
    assert!(
        scan.divergences.is_empty(),
        "positions altérées à la lecture : {:?}",
        scan.divergences,
    );
}

#[test]
fn long_mantissa_battery_matches_the_standard_library() {
    // Batterie synthétique déterministe et autonome : elle couvre bien plus de
    // mantisses longues que les trois littéraux mesurés, sans corpus privé.
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut checked = 0_usize;
    for _ in 0..4096 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let significand = state % 10_000_000_000_000_000_u64;
        let literal = format!("-{}.{:016}", significand % 1000, significand);
        let serde_value: f64 = serde_json::from_str(&literal).expect("nombre JSON");
        let std_value: f64 = literal.parse().expect("analyse standard f64");
        assert_eq!(
            serde_value.to_bits(),
            std_value.to_bits(),
            "littéral synthétique {literal} lu à {} ULP",
            serde_value.to_bits().abs_diff(std_value.to_bits()),
        );
        checked += 1;
    }
    assert_eq!(checked, 4096);
}
