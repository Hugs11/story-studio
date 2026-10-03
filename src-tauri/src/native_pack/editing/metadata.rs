//! Geste des métadonnées de tête et de l'identité du pack.
//!
//! Il existe parce que la fiche du pack est commune aux deux éditeurs, et que
//! côté graphe titre, version et description vivent dans le document d'auteur,
//! tandis que l'identité livrée vit dans son contexte. Sans commande, l'auteur
//! aurait modifié une copie que la production n'aurait jamais lue : une seconde
//! vérité à ne pas introduire.
//!
//! Trois règles, et leur raison :
//!
//! - **Seuls les champs nommés bougent.** La forme `members` est la seule
//!   offerte : un geste qui réécrirait toutes les valeurs à chaque application
//!   effacerait l'absence d'un champ que l'auteur n'a pas visé, alors que la
//!   fiche n'en présente qu'une partie selon l'origine du document.
//! - **L'absence reste une forme.** Absent, `null` et valeur sont trois états
//!   distincts ; le geste porte donc les trois, et ne « vide » pas un champ en
//!   y écrivant une chaîne vide.
//! - **L'identité ne change que sur demande.** Un UUID explicitement choisi
//!   remplace `context.pack_identity` et la racine `uuid` dans un seul geste.
//!   Modifier les autres métadonnées conserve l'identité existante.
//!
//! Ce que ces valeurs deviennent à l'export n'est pas décidé ici :
//! `apply_required_standard_shape` impose la version et la racine `uuid` d'un
//! document **créé**, et laisse celles d'un document **importé**. Une demande
//! explicite d'identité met aussi à jour le contexte, qui gouverne l'export.

use serde::Deserialize;

use super::GestureError;
use crate::native_pack::{
    pack_identity_refusal, DecodedStoryDocument, PackIdentity, Presence, ValueOrigin,
    ValueProvenance,
};

/// Le chemin d'auteur de la tête du document. Les métadonnées ne sont pas des
/// nœuds : leur chemin est la racine, et le champ visé le suffixe.
const DOCUMENT_ROOT: &str = "/";

/// La forme d'un champ après le geste, présence comprise.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum TextUpdate {
    Set { value: String },
    Null,
    Absent,
}

impl TextUpdate {
    pub(crate) fn presence(self) -> Presence<String> {
        match self {
            TextUpdate::Set { value } => Presence::Value(value),
            TextUpdate::Null => Presence::Null,
            TextUpdate::Absent => Presence::Absent,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum VersionUpdate {
    Set { value: i32 },
    Null,
    Absent,
}

impl VersionUpdate {
    fn presence(self) -> Presence<i32> {
        match self {
            VersionUpdate::Set { value } => Presence::Value(value),
            VersionUpdate::Null => Presence::Null,
            VersionUpdate::Absent => Presence::Absent,
        }
    }
}

/// Les champs visés par le geste. Un champ absent de la demande n'est pas
/// touché ; c'est ce qui tient la conservation des informations non visées.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentMetadataUpdate {
    #[serde(default)]
    title: Option<TextUpdate>,
    #[serde(default)]
    version: Option<VersionUpdate>,
    #[serde(default)]
    description: Option<TextUpdate>,
    /// Racine `uuid` du dialecte, distincte de la `packIdentity`.
    #[serde(default)]
    uuid: Option<TextUpdate>,
    /// Identité du pack livré, distincte de la racine `uuid` du document.
    #[serde(default)]
    pack_identity: Option<String>,
}

impl DocumentMetadataUpdate {
    fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.version.is_none()
            && self.description.is_none()
            && self.uuid.is_none()
            && self.pack_identity.is_none()
    }
}

/// Une version de pack est un entier positif : `0` et les négatifs ne sont pas
/// des versions plus anciennes, ce sont des valeurs qu'aucun lecteur n'attend.
/// Le refus est explicite plutôt que corrigé en silence — corriger ferait
/// diverger la valeur affichée de la valeur écrite.
fn check_version(update: &VersionUpdate) -> Result<(), GestureError> {
    if let VersionUpdate::Set { value } = update {
        if *value <= 0 {
            return Err(GestureError::new(
                "INVALID_DOCUMENT_VERSION",
                "/version",
                format!("La version d'un pack est un entier strictement positif ; {value} ne l'est pas."),
            ));
        }
    }
    Ok(())
}

/// Un identifiant vide n'est pas un identifiant. Le retirer est une forme
/// (`Null` ou `Absent`), pas une chaîne vide déguisée en valeur d'auteur.
fn check_uuid(update: &TextUpdate) -> Result<(), GestureError> {
    if let TextUpdate::Set { value } = update {
        if value.trim().is_empty() {
            return Err(GestureError::new(
                "EMPTY_DOCUMENT_UUID",
                "/uuid",
                "Un identifiant vide n'est pas une valeur : retire le champ plutôt que d'y écrire une chaîne vide."
                    .to_string(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn set_document_metadata(
    decoded: &mut DecodedStoryDocument,
    update: &DocumentMetadataUpdate,
) -> Result<(), GestureError> {
    if update.is_empty() {
        return Err(GestureError::new(
            "EMPTY_METADATA_UPDATE",
            DOCUMENT_ROOT,
            "Aucune métadonnée n'est nommée : le geste ne devine pas laquelle modifier."
                .to_string(),
        ));
    }

    // Tous les contrôles **avant** la première écriture : un geste à moitié
    // appliqué laisserait le document dans un état que l'auteur n'a pas demandé
    // et qu'aucune annulation ne nomme.
    if let Some(version) = update.version.as_ref() {
        check_version(version)?;
    }
    if let Some(uuid) = update.uuid.as_ref() {
        check_uuid(uuid)?;
    }
    let new_identity = update
        .pack_identity
        .as_deref()
        .map(str::trim)
        .map(|identity| match pack_identity_refusal(identity) {
            Some(refusal) => Err(GestureError::new(
                "INVALID_PACK_IDENTITY",
                "/context/packIdentity/value",
                refusal,
            )),
            None => Ok(identity),
        })
        .transpose()?;

    if let Some(title) = update.title.clone() {
        decoded.document.title = title.presence();
        mark_authored(decoded, "/title");
    }
    if let Some(version) = update.version {
        decoded.document.version = version.presence();
        mark_authored(decoded, "/version");
    }
    if let Some(description) = update.description.clone() {
        decoded.document.description = description.presence();
        mark_authored(decoded, "/description");
    }
    if let Some(uuid) = update.uuid.clone() {
        decoded.document.uuid = uuid.presence();
    }
    if let Some(identity) = new_identity {
        decoded.document.uuid = Presence::Value(identity.to_string());
        decoded.context.pack_identity =
            PackIdentity::chosen(identity, &decoded.context.pack_identity);
    }
    Ok(())
}

/// Une valeur que l'auteur vient de saisir est la sienne.
///
/// Un pack FS n'a ni titre ni description : le lecteur en fabrique pour
/// l'affichage, marqués `projection-derived`, et l'export retire ces valeurs de
/// confort. Sans ce marquage, un titre saisi dans la fiche gardait la marque de
/// la valeur fabriquée qu'il remplaçait, et disparaissait du pack sans un mot.
fn mark_authored(decoded: &mut DecodedStoryDocument, path: &str) {
    let provenance = &mut decoded.context.value_provenance;
    provenance.retain(|entry| entry.path != path);
    provenance.push(ValueProvenance {
        path: path.to_string(),
        origin: ValueOrigin::Authored,
    });
}
