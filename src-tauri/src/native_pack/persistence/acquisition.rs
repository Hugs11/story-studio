//! Acquisition d'un projet avancé : les trois entrées (document créé, import,
//! payload déjà enregistré), et la génération **unique** de `packIdentity`
//! qu'elles partagent.
//!
//! La frontière est volontairement étroite : elle prend un document déjà décodé
//! par la couche qui connaît sa provenance — le décodeur de dialecte pour un ZIP
//! STUdio, la frontière de conversion pour un pack FS, ce module pour un
//! document créé — puis résout l'identité et rend la **chaîne** de payload du
//! codec. Elle ne réimporte rien, ne reclasse aucune provenance et ne touche pas
//! au document d'auteur.
//!
//! Deux séparations sont structurelles et ne doivent jamais fusionner :
//!
//! - **Acquisition contre réouverture.** `decode_authoring_payload` recharge
//!   l'identité persistée telle quelle ; elle ne la redérive pas du `squareOne`
//!   courant et n'en génère aucune. Seules les fonctions de ce module génèrent,
//!   et seulement quand l'origine vaut `requires-generation`.
//! - **Résolution contre besoin.** Une identité générée porte l'origine
//!   `generated`, jamais `requires-generation` : réappliquer l'initialiseur à un
//!   projet déjà initialisé ne tire donc aucun nouvel UUID.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{decode_authoring_payload, encode_authoring_payload, PersistenceError};
use crate::native_pack::{
    ControlSettings, DecodedStoryDocument, PackIdentity, PackIdentityOrigin, Position, Presence,
    StageNode, StoryDocument, StoryDocumentContext,
};

/// Source d'identité injectable.
///
/// Les **4 octets de poids faible** d'une `packIdentity` générée doivent être
/// uniformes : les deux passerelles réduisent l'identité de dossier FS à ces 32
/// bits. Dériver l'identité d'un nom ou d'un chemin est explicitement interdit.
/// La production tire donc du CSPRNG du système ; les tests fournissent une
/// suite fixée pour observer, sans aléa, que la génération n'a lieu qu'une
/// fois.
pub(crate) type PackIdentitySource<'a> = &'a mut dyn FnMut() -> Uuid;

/// Source d'aléa de production, unique et sans branche par plateforme.
///
/// `Uuid::new_v4` remplit ses 122 bits libres par `getrandom`, c'est-à-dire le
/// CSPRNG du noyau : `getrandom(2)` sous Linux, `BCryptGenRandom` sous Windows,
/// `getentropy` sous macOS. Les 32 bits de poids faible en font partie et ne
/// dépendent d'aucune donnée du projet — ni nom, ni chemin, ni horloge.
pub(crate) fn system_pack_identity() -> Uuid {
    Uuid::new_v4()
}

/// Résout l'identité **une seule fois**. Rend `true` si elle a été générée ici.
///
/// Une identité déjà lue dans sa source — hyphenless, canonique ou entrée FS —
/// est conservée bit-à-bit : on ne la remappe ni ne la normalise pour des
/// raisons de forme.
fn resolve_pack_identity(context: &mut StoryDocumentContext, next: PackIdentitySource<'_>) -> bool {
    if context.pack_identity.origin != PackIdentityOrigin::RequiresGeneration {
        return false;
    }
    context.pack_identity = PackIdentity::generated(next(), &context.pack_identity);
    true
}

/// Entrée d'acquisition commune aux trois sources : le document décodé devient
/// le payload persistant du projet, identité résolue une seule fois.
///
/// Aucune readiness n'est consultée : un projet décodable mais
/// non exportable — graphe invalide, contrôles incomplets, disposition en
/// attente — s'acquière et s'enregistre quand même. Générer une identité ne rend
/// donc valide aucun document qui ne l'était pas.
pub(crate) fn initialize_advanced_document(
    mut decoded: DecodedStoryDocument,
    next: PackIdentitySource<'_>,
) -> Result<String, PersistenceError> {
    resolve_pack_identity(&mut decoded.context, next);
    encode_authoring_payload(&decoded)
}

/// Réapplication de l'initialiseur à un payload déjà persisté.
///
/// Elle est **idempotente** : un projet déjà initialisé ressort avec la même
/// identité, sans tirage. C'est ce qui rend inoffensifs deux appels rapprochés
/// du cycle de vie — installation puis autosave, par exemple — qui produiraient
/// sinon deux identités concurrentes pour un seul projet.
pub(crate) fn initialize_advanced_payload(
    payload: &str,
    next: PackIdentitySource<'_>,
) -> Result<String, PersistenceError> {
    initialize_advanced_document(decode_authoring_payload(payload)?, next)
}

/// Le nom du Stage d'entrée d'un projet neuf. Il suit la numérotation de
/// l'éditeur graphe (`defaultNodeNames.js`) : le suivant sera « Écran 2 ».
const FIRST_STAGE_NAME: &str = "Écran 1";

/// Document créé ex nihilo : un Stage d'entrée et rien d'autre.
///
/// Trois choix délibérés :
///
/// - l'identité du projet est **générée**, pas dérivée du Stage d'entrée :
///   elle est indépendante du nom du projet et de son chemin,
///   et survit à toute réassignation ultérieure de `squareOne` ;
/// - le Stage reçoit son **propre** UUID canonique dès sa création ; la
///   préparation portera l'identité du pack sur la copie d'export, jamais sur
///   le document d'auteur ;
/// - ses cinq contrôles sont explicitement renseignés : créer un
///   `controlSettings` incomplet fabriquerait une perte connue.
///
/// Le Stage d'entrée est nommé « Écran 1 », comme l'éditeur nomme les Écrans
/// qu'on y crée ensuite : sans nom, le graphe l'affichait par son UUID. Il
/// naît aussi avec sa position d'auteur, à l'origine du graphe : un nœud n'a
/// qu'une position, et celui-ci n'en avait aucune.
pub(crate) fn create_advanced_document(
    title: &str,
    next: PackIdentitySource<'_>,
) -> Result<String, PersistenceError> {
    let entry = StageNode {
        uuid: next().to_string(),
        name: Presence::Value(FIRST_STAGE_NAME.to_string()),
        position: Presence::Value(Position {
            x: serde_json::Number::from(0),
            y: serde_json::Number::from(0),
        }),
        square_one: Presence::Value(true),
        audio: Presence::Null,
        image: Presence::Null,
        control_settings: Presence::Value(ControlSettings::authored(
            false, true, false, false, false,
        )),
        ..StageNode::default()
    };
    let document = StoryDocument {
        title: Presence::Value(title.to_string()),
        format: Presence::Value("v1".to_string()),
        version: Presence::Value(1),
        stage_nodes: vec![entry],
        ..StoryDocument::default()
    };
    initialize_advanced_document(
        DecodedStoryDocument {
            document,
            source_value: serde_json::Value::Null,
            context: StoryDocumentContext::created(),
        },
        next,
    )
}

/// Statut d'une liaison média : le dernier relevé de disque, jamais une valeur
/// d'auteur. Il ne retire aucune liaison et n'entre pas dans la signature de
/// travail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaBindingStatus {
    Resolved,
    Missing,
}

/// Forme fermée, telle que le frontend la reçoit : trois champs,
/// pas un de plus. `assetRef` appartient au dialecte et n'est jamais relativisé
/// ni réécrit ; seul `path` désigne un fichier sur le disque de l'utilisateur.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdvancedMediaBinding {
    pub(crate) asset_ref: String,
    pub(crate) path: Option<String>,
    pub(crate) status: MediaBindingStatus,
}

/// Où l'acquisition a déposé l'asset d'une référence, et s'il y est réellement.
///
/// Un asset référencé mais absent de l'archive garde une place : c'est la seule
/// façon pour l'utilisateur de le retrouver ou de le remplacer plus tard. Une
/// liaison sans chemin reste lisible, mais aucun relink fondé sur le chemin ne
/// peut la réparer.
pub(crate) struct AssetLocation {
    pub(crate) path: Option<String>,
    pub(crate) present: bool,
}

impl AssetLocation {
    pub(crate) fn present(path: String) -> Self {
        Self {
            path: Some(path),
            present: true,
        }
    }

    pub(crate) fn absent(path: Option<String>) -> Self {
        Self {
            path,
            present: false,
        }
    }
}

/// Résultat complet d'une acquisition : la chaîne de payload **et** les liaisons
/// produites depuis les références réelles du document acquis.
///
/// Les deux moitiés sortent ensemble parce qu'elles sont dérivées du même
/// document : rendre le payload seul obligerait l'appelant à rouvrir la chaîne
/// pour retrouver ses assets, ce qui est interdit en JavaScript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvancedAcquisition {
    pub(crate) payload: String,
    pub(crate) media_bindings: Vec<AdvancedMediaBinding>,
    /// La vignette catalogue du pack, quand l'archive en portait une.
    ///
    /// Elle n'est **pas** un média du document : aucune référence ne la
    /// désigne, et elle ne participe ni aux liaisons ni à l'inventaire. C'est
    /// un média d'enveloppe de projet, comme du côté hiérarchique, où elle
    /// vit déjà sous `thumbnailImage`. La rendre ici est ce qui permet à un
    /// pack modifié de repartir avec la couverture qu'il avait.
    pub(crate) thumbnail_image: Option<String>,
}

/// Les références d'assets réellement portées par le document, dans l'ordre où
/// il les déclare, dédupliquées.
///
/// L'ordre du document plutôt qu'un tri : deux Stages qui partagent une image
/// n'en font qu'une liaison, et l'ordre reste celui que l'auteur voit. La
/// référence est prise **telle quelle** ; c'est la couche qui connaît le disque
/// qui sait, elle, comment en déduire un nom de fichier.
pub(crate) fn referenced_asset_refs(document: &StoryDocument) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    for stage in &document.stage_nodes {
        for candidate in [stage.audio.value(), stage.image.value()] {
            let Some(asset_ref) = candidate else { continue };
            if asset_ref.trim().is_empty() || refs.iter().any(|seen| seen == asset_ref) {
                continue;
            }
            refs.push(asset_ref.clone());
        }
    }
    refs
}

/// Produit **toutes** les liaisons d'un document acquis.
///
/// Aucune référence n'est écartée : un asset absent de l'archive sort en
/// `missing` avec le chemin qu'il aurait, et un `resolved` sans chemin est
/// impossible par construction — c'est la même règle que la porte d'enveloppe
/// applique en JavaScript, appliquée ici à la source.
pub(crate) fn media_bindings_for_document(
    document: &StoryDocument,
    locate: impl Fn(&str) -> AssetLocation,
) -> Vec<AdvancedMediaBinding> {
    referenced_asset_refs(document)
        .into_iter()
        .map(|asset_ref| {
            let located = locate(&asset_ref);
            let status = if located.present && located.path.is_some() {
                MediaBindingStatus::Resolved
            } else {
                MediaBindingStatus::Missing
            };
            AdvancedMediaBinding {
                asset_ref,
                path: located.path,
                status,
            }
        })
        .collect()
}
