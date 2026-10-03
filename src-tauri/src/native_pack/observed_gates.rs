//! Les trois contrôles de l'export avancé, **exécutés sur la chaîne Libre en
//! observation**.
//!
//! L'éditeur avancé possède trois contrôles que la chaîne Libre n'a pas : une
//! porte de readiness, une porte d'identité, et la relecture de l'archive
//! produite. La chaîne Libre, elle, écrit et fait confiance.
//!
//! Ce module branche ces trois contrôles sur la chaîne Libre. **Observer et
//! décider y sont deux gestes séparés**, et cette séparation est la propriété
//! structurante du module :
//!
//! - les fonctions d'observation **constatent**. Aucune ne rend d'erreur, et la
//!   seule valeur qu'elles produisent est un constat. Un constat est un fait ;
//! - la **politique** dit ce qu'un constat vaut. Elle vit en un seul endroit,
//!   `GatePolicy`, et rien d'autre ne décide.
//!
//! Sans cette séparation, changer de politique demanderait de relire chaque
//! observation pour vérifier qu'elle n'a pas pris de décision au passage.
//!
//! ## La politique en vigueur
//!
//! **Les trois portes bloquent**, après une mesure sur 156 packs du corpus
//! éditable produits en entier, sans aucun refus. La raison est que la
//! validité d'un pack ne doit pas dépendre de l'éditeur qui l'a fabriqué —
//! c'est le même appareil qui le lit.
//!
//! Les deux premières portes deviennent de ce fait des **alarmes sur le
//! générateur** : côté Libre, c'est le moteur qui compose les écrans et leurs
//! identifiants, et non l'auteur. Elles n'attraperont donc pas une faute
//! d'auteur, mais une régression du générateur, avant qu'elle n'atteigne un
//! appareil.
//!
//! ## Sur quelle entrée les portes tournent
//!
//! Elles tournent sur ce que la chaîne Libre **produit réellement** : le
//! `story.json` qu'elle vient de sérialiser, et le ZIP qu'elle vient d'écrire
//! dans son cache local, avant publication. Rien n'est reconstruit pour elles,
//! et aucun contexte d'auteur n'est inventé.
//!
//! C'est un écart assumé avec l'export avancé : l'avancé interroge ses portes sur
//! le **document d'auteur** et son enveloppe — identité persistée, provenances,
//! membres opaques — avant d'écrire quoi que ce soit. Un projet Libre n'a pas d'enveloppe de ce genre ; son seul
//! porteur d'identité est le pack. Poser la question à l'artefact est donc la
//! seule façon de la poser sans fabriquer la réponse. Le document étant
//! déterministe, l'instant où la question est posée ne change pas ce que la
//! porte répondrait.
//!
//! ## Le moment où les portes se posent, et ce qu'il coûte
//!
//! Côté Libre, le document n'existe qu'**après** la préparation des médias :
//! c'est le générateur qui le compose à partir de l'arbre et des fichiers
//! préparés. Les portes ne peuvent donc pas refuser avant l'effort, comme
//! l'avancé le fait à ses étapes 2 et 3 ; elles refusent **avant la
//! publication**, l'archive locale écrite et jamais transférée.
//!
//! Le coût d'un refus est donc du temps de conversion perdu, jamais un pack
//! abîmé livré : `transfer_completed_zip` reste le point de publication unique,
//! et il est postérieur à ces portes.
//!
//! ## Ce que ce module ne fait pas
//!
//! Il ne touche ni au format d'archive, ni au document, ni à une règle de
//! readiness ou d'identité. Les règles sont celles de l'export avancé, appelées
//! telles quelles.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

use super::archive_review::{
    review_written_archive, ArchiveExpectation, ExpectedArchiveEntry, ASSETS_PREFIX,
};
use super::decode_story_document;
use super::preparation::pack_identity_for_export;
use super::readiness::assess_graph_document_export_readiness;

/// Les trois contrôles observés.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ObservedGate {
    Readiness,
    PackIdentity,
    ArchiveReview,
}

impl ObservedGate {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Readiness => "Readiness d'export",
            Self::PackIdentity => "Identité du pack",
            Self::ArchiveReview => "Relecture de l'archive",
        }
    }
}

/// Ce qu'une porte a répondu.
///
/// `WouldRefuse` se lit « aurait refusé » : la production continue. C'est le
/// point de cette porte, et le type le dit plutôt que de le laisser à un commentaire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GateOutcome {
    Passed,
    WouldRefuse,
    NotObserved,
}

/// Ce que chaque porte a le droit de faire, **en un seul endroit**.
///
/// Toute la politique de refus de la chaîne Libre tient ici. Changer d'avis sur
/// une porte est une ligne, et cette ligne est la seule à relire pour savoir ce
/// que la chaîne refuse — pas trois appels dispersés dans le writer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GatePolicy {
    readiness: bool,
    pack_identity: bool,
    archive_review: bool,
}

impl GatePolicy {
    /// La politique en vigueur dans la chaîne Libre.
    ///
    /// Les trois portes bloquent, comme dans l'éditeur avancé. La raison est
    /// que la validité d'un pack ne doit pas dépendre de l'éditeur qui l'a
    /// fabriqué.
    ///
    /// La mesure qui le justifie porte sur **156 packs importés**
    /// produits en entier, sans un refus. Elle ne couvre pas les projets
    /// construits de zéro dans l'éditeur Libre, que la liste « éléments à
    /// corriger » filtre en amont.
    pub(crate) const ENFORCED: Self = Self {
        readiness: true,
        pack_identity: true,
        archive_review: true,
    };

    /// La politique de la phase de mesure : observer sans jamais refuser.
    /// Conservée pour pouvoir rejouer la mesure à l'identique.
    #[cfg(test)]
    pub(crate) const OBSERVE_ONLY: Self = Self {
        readiness: false,
        pack_identity: false,
        archive_review: false,
    };

    fn blocks(self, gate: ObservedGate) -> bool {
        match gate {
            ObservedGate::Readiness => self.readiness,
            ObservedGate::PackIdentity => self.pack_identity,
            ObservedGate::ArchiveReview => self.archive_review,
        }
    }
}

/// Un motif de refus, lisible sans rouvrir le code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GateRefusalReason {
    pub(crate) code: String,
    pub(crate) path: String,
    pub(crate) message: String,
}

/// Le constat d'une porte sur une production.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GateObservation {
    pub(crate) gate: ObservedGate,
    pub(crate) label: &'static str,
    pub(crate) outcome: GateOutcome,
    /// Cette porte a-t-elle le droit d'arrêter la production ?
    ///
    /// Le champ est **stampé par la politique**, jamais par l'observation :
    /// l'interface n'a pas à le supposer, et un changement de politique se lit
    /// dans la donnée plutôt que dans un libellé.
    pub(crate) blocking: bool,
    /// Ce que la porte aurait refusé, motif par motif. Vide sinon.
    pub(crate) reasons: Vec<GateRefusalReason>,
    /// Ce que la porte a constaté au passage, refus ou non.
    pub(crate) note: String,
}

impl GateObservation {
    fn new(
        gate: ObservedGate,
        outcome: GateOutcome,
        reasons: Vec<GateRefusalReason>,
        note: impl Into<String>,
    ) -> Self {
        Self {
            gate,
            label: gate.label(),
            outcome,
            blocking: false,
            reasons,
            note: note.into(),
        }
    }

    fn passed(gate: ObservedGate, note: impl Into<String>) -> Self {
        Self::new(gate, GateOutcome::Passed, Vec::new(), note)
    }

    fn would_refuse(
        gate: ObservedGate,
        reasons: Vec<GateRefusalReason>,
        note: impl Into<String>,
    ) -> Self {
        Self::new(gate, GateOutcome::WouldRefuse, reasons, note)
    }

    /// Stampe la politique sur ce constat. Le constat lui-même ne change pas.
    fn under(mut self, policy: GatePolicy) -> Self {
        self.blocking = policy.blocks(self.gate);
        self
    }

    /// Cette porte arrête-t-elle **réellement** cette production ?
    ///
    /// Les deux conditions sont distinctes et doivent le rester : une porte peut
    /// bloquer sans rien refuser, et refuser sans bloquer.
    pub(crate) fn refuses(&self) -> bool {
        self.blocking && self.outcome == GateOutcome::WouldRefuse
    }

    fn not_observed(gate: ObservedGate, note: impl Into<String>) -> Self {
        Self::new(gate, GateOutcome::NotObserved, Vec::new(), note)
    }

    /// La ligne de journal de cette observation.
    ///
    /// Elle dit toujours que la production continue : une ligne qui annoncerait
    /// un refus sans le faire serait le pire des deux mondes.
    pub(crate) fn log_line(&self) -> String {
        match self.outcome {
            GateOutcome::Passed => format!("  ✔ {} : rien à signaler.", self.label),
            GateOutcome::NotObserved => format!("  · {} : {}", self.label, self.note),
            GateOutcome::WouldRefuse => {
                let mut line = if self.blocking {
                    format!(
                        "  ✖ {} : {} motif(s) de refus — la production est arrêtée, aucune archive n'est publiée.",
                        self.label,
                        self.reasons.len()
                    )
                } else {
                    format!(
                        "  ⚠ {} : {} motif(s) de refus observés — la production continue (contrôle en observation).",
                        self.label,
                        self.reasons.len()
                    )
                };
                for reason in self.reasons.iter().take(5) {
                    line.push_str(&format!(
                        "\n      {} {} — {}",
                        reason.code, reason.path, reason.message
                    ));
                }
                if self.reasons.len() > 5 {
                    line.push_str(&format!(
                        "\n      … et {} autre(s).",
                        self.reasons.len() - 5
                    ));
                }
                line
            }
        }
    }
}

/// Les deux portes qui se posent sur le document : readiness, puis identité.
///
/// Elles sont exécutées **réellement**, par les mêmes fonctions que l'export
/// avancé appelle à ses étapes 2 et 3. Aucune règle n'est réécrite ici ; une
/// porte en observation qui ne tournerait pas vraiment ne mesurerait rien.
///
/// `expected_identity` est l'identité du projet Libre. L'Écran d'entrée doit la
/// porter à l'identique : une identité bien formée mais différente livrerait un
/// autre pack que celui choisi, que l'appareil ne ferait pas remplacer.
pub(crate) fn observe_document_gates(
    story_json: &str,
    expected_identity: Option<&str>,
    policy: GatePolicy,
) -> Vec<GateObservation> {
    let decoded = decode_story_document(story_json);

    let readiness = assess_graph_document_export_readiness(decoded.as_ref());
    let reasons = readiness
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.blocks())
        .map(|diagnostic| GateRefusalReason {
            code: diagnostic.code().to_string(),
            path: diagnostic.path().to_string(),
            message: diagnostic.message().to_string(),
        })
        .collect::<Vec<_>>();
    let qualification = format!(
        "interopérabilité {:?}, {} dimension(s) évaluée(s), {} non évaluée(s)",
        readiness.interoperability,
        readiness.dimensions.len(),
        readiness.unevaluated.len()
    );
    let readiness_observation = if readiness.blocked {
        GateObservation::would_refuse(ObservedGate::Readiness, reasons, qualification)
    } else {
        GateObservation::passed(ObservedGate::Readiness, qualification)
    };

    // La porte d'identité de l'avancé lit l'identité **persistée** dans
    // l'enveloppe du projet. Le document Libre n'a pas cette enveloppe : le
    // décodage dérive l'identité du Stage d'entrée exactement comme pour un
    // pack STUdio relu, et c'est ce qu'un appareil lira. Elle est ensuite
    // comparée à l'identité du projet, que l'appelant fournit.
    let identity_observation = match decoded.as_ref() {
        Err(_) => GateObservation::not_observed(
            ObservedGate::PackIdentity,
            "document non décodable : l'identité n'est pas observable.",
        ),
        Ok(payload) => match pack_identity_for_export(&payload.context.pack_identity) {
            Ok(value) if expected_identity.is_some_and(|expected| expected != value) => {
                let expected = expected_identity.unwrap_or_default();
                GateObservation::would_refuse(
                    ObservedGate::PackIdentity,
                    vec![GateRefusalReason {
                        code: "PACK_IDENTITY_MISMATCH".to_string(),
                        path: payload
                            .context
                            .pack_identity
                            .source_path
                            .clone()
                            .unwrap_or_else(|| "/".to_string()),
                        message: format!(
                            "L'Écran d'entrée porte « {value} » au lieu de l'identité du projet « {expected} »."
                        ),
                    }],
                    format!("identité attendue « {expected} »"),
                )
            }
            Ok(value) => GateObservation::passed(
                ObservedGate::PackIdentity,
                format!("identité retenue « {value} »"),
            ),
            Err(error) => GateObservation::would_refuse(
                ObservedGate::PackIdentity,
                vec![GateRefusalReason {
                    code: "PACK_IDENTITY".to_string(),
                    path: payload
                        .context
                        .pack_identity
                        .source_path
                        .clone()
                        .unwrap_or_else(|| "/".to_string()),
                    message: error.to_string(),
                }],
                format!("origine {:?}", payload.context.pack_identity.origin),
            ),
        },
    };

    vec![
        readiness_observation.under(policy),
        identity_observation.under(policy),
    ]
}

/// La relecture de l'archive écrite, sur le ZIP **local**, avant publication.
///
/// Elle emprunte le relecteur partagé, celui-là même sur lequel l'export avancé
/// refuse. Ses attentes sont construites depuis ce que la chaîne Libre vient
/// d'écrire ; l'empreinte de chaque média est calculée sur le fichier étagé, et
/// non recopiée d'un registre que la chaîne Libre ne tient pas.
pub(crate) fn observe_archive_review(
    zip_path: &Path,
    story_json: &str,
    staged_assets: &[(String, String)],
    expects_thumbnail: bool,
    policy: GatePolicy,
) -> GateObservation {
    let mut distinct_names = BTreeSet::new();
    let mut entries: Vec<ExpectedArchiveEntry> = Vec::new();
    let mut unreadable: Vec<GateRefusalReason> = Vec::new();

    for (archive_name, staged_path) in staged_assets {
        if !distinct_names.insert(archive_name.clone()) {
            continue;
        }
        match std::fs::read(staged_path) {
            Ok(bytes) => entries.push(ExpectedArchiveEntry {
                archive_name: archive_name.clone(),
                output_sha256: super::archive_review::sha256_hex(&bytes),
            }),
            Err(error) => unreadable.push(GateRefusalReason {
                code: "STAGED_ASSET_UNREADABLE".to_string(),
                path: format!("{ASSETS_PREFIX}{archive_name}"),
                message: format!("fichier étagé illisible au moment du contrôle : {error}"),
            }),
        }
    }

    if !unreadable.is_empty() {
        // Sans empreinte de référence, le contrôle d'octets ne veut rien dire.
        // Le dire est plus utile qu'un verdict calculé sur une attente partielle.
        return GateObservation::not_observed(
            ObservedGate::ArchiveReview,
            format!(
                "{} fichier(s) étagé(s) illisible(s) : contrôle d'octets non concluant.",
                unreadable.len()
            ),
        )
        .under(policy);
    }

    let expectation = ArchiveExpectation {
        story_json,
        distinct_names,
        entries,
        expects_thumbnail,
    };
    let review = review_written_archive(zip_path, &expectation);
    if review.is_conformant() {
        GateObservation::passed(
            ObservedGate::ArchiveReview,
            format!(
                "{} entrée(s) relue(s) et rattachée(s)",
                review.entry_names.len()
            ),
        )
        .under(policy)
    } else {
        let reasons = review
            .disagreements
            .iter()
            .map(|disagreement| GateRefusalReason {
                code: "ARCHIVE_DISAGREEMENT".to_string(),
                path: disagreement.asset_ref.clone(),
                message: format!(
                    "attendu {} ; observé {}",
                    disagreement.expected, disagreement.observed
                ),
            })
            .collect();
        GateObservation::would_refuse(
            ObservedGate::ArchiveReview,
            reasons,
            format!("{} entrée(s) relue(s)", review.entry_names.len()),
        )
        .under(policy)
    }
}

/// Le préfixe de journal commun aux trois portes, selon ce qu'elles peuvent.
pub(crate) fn gates_header(policy: GatePolicy) -> &'static str {
    if policy == GatePolicy::ENFORCED {
        "🛂 Contrôles d'archive :"
    } else {
        "🔭 Contrôles d'archive, en observation (ils ne refusent rien) :"
    }
}

/// Vrai dès qu'une porte aurait refusé, qu'elle en ait le droit ou non.
///
/// C'est la question que pose une **mesure**, distincte de celle que pose la
/// production : rejouer la mesure exige de compter ce qu'une porte
/// refuserait sous une autre politique que celle en vigueur.
#[cfg(test)]
pub(crate) fn any_would_refuse(observations: &[GateObservation]) -> bool {
    observations
        .iter()
        .any(|observation| observation.outcome == GateOutcome::WouldRefuse)
}

/// Le refus que ces constats imposent, s'il y en a un.
///
/// C'est **le seul endroit** où un constat devient un arrêt de production. Le
/// message nomme la porte, compte ses motifs, en cite les premiers et dit ce
/// qu'il advient de l'archive — un auteur doit pouvoir agir sans ouvrir un
/// journal.
pub(crate) fn refusal_from_gates(observations: &[GateObservation]) -> Option<String> {
    let refusing = observations
        .iter()
        .filter(|observation| observation.refuses())
        .collect::<Vec<_>>();
    if refusing.is_empty() {
        return None;
    }

    let mut message = String::from("Production refusée avant publication. Aucune archive n'a été écrite dans le dossier de sortie.");
    for observation in refusing {
        message.push_str(&format!(
            "\n• {} — {} motif(s) :",
            observation.label,
            observation.reasons.len()
        ));
        for reason in observation.reasons.iter().take(3) {
            message.push_str(&format!(
                "\n    {} {} — {}",
                reason.code, reason.path, reason.message
            ));
        }
        if observation.reasons.len() > 3 {
            message.push_str(&format!(
                "\n    … et {} autre(s).",
                observation.reasons.len() - 3
            ));
        }
    }
    Some(message)
}
