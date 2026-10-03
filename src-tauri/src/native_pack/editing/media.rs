//! Liaisons médias d'un geste d'auteur.
//!
//! Remplacer un média ne change **rien** à son `assetRef`. La référence
//! appartient au dialecte et reste verbatim dans le document, dans le payload
//! et dans le `.mbah` ; le nom de fichier de l'archive est adressé par le
//! contenu des octets finaux et calculé sur la **copie** d'export, à chaque
//! export. Remplacer le fichier disque derrière une référence ne demande donc
//! aucune réécriture de dialecte : seul `path` change, et il change **pour tous
//! les usages** de la référence, parce qu'une liaison est indexée par sa seule
//! `assetRef`.
//!
//! Aucun geste ne **retire** une liaison. Une référence qui disparaît du
//! document laisse sa liaison en place et ressort en `unreferenced` : il
//! n'existe pas de politique de suppression média, et un média ne disparaît pas
//! d'un projet parce qu'un relevé de disque a changé. Une liaison encore
//! référencée n'est donc jamais supprimée — pas par prudence, mais parce que la
//! suppression n'existe pas ici.

use serde::{Deserialize, Serialize};

use super::structure::unique_stage_index;
use super::GestureError;
use crate::native_pack::persistence::{
    referenced_asset_refs, AdvancedMediaBinding, MediaBindingStatus,
};
use crate::native_pack::{stable_node_paths, Presence, StoryDocument};

/// Le dernier relevé de disque d'un fichier, tel que l'appelant l'a observé.
///
/// La frontière IPC du codec n'accède pas au disque : c'est la couche qui a
/// choisi le fichier qui sait s'il est là. `status` en est dérivé par la même
/// règle que l'acquisition — `resolved` exige un chemin **et** une présence,
/// sans quoi la liaison reste `missing` et le fichier reste retrouvable.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetLocationInput {
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) present: bool,
}

impl AssetLocationInput {
    fn status(&self) -> MediaBindingStatus {
        if self.present
            && self
                .path
                .as_ref()
                .is_some_and(|path| !path.trim().is_empty())
        {
            MediaBindingStatus::Resolved
        } else {
            MediaBindingStatus::Missing
        }
    }

    fn path(&self) -> Option<String> {
        self.path
            .as_ref()
            .filter(|path| !path.trim().is_empty())
            .cloned()
    }
}

/// Ce que le geste a fait des liaisons, et ce qu'il observe après coup.
///
/// `unreferenced` et `unbound` sont des **constats**, jamais des corrections :
/// une liaison sans référence reste, une référence sans liaison n'en reçoit pas
/// une inventée. L'interface décide ; ce module rend visible.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaBindingReport {
    pub(crate) added: Vec<String>,
    pub(crate) repointed: Vec<String>,
    /// Les références qu'un Stage cesse d'utiliser. Leur liaison **reste** :
    /// aucun geste ne retire une liaison, et aucun fichier n'est effacé du
    /// disque. Elles ressortent en `unreferenced` si plus rien ne les cite.
    pub(crate) released: Vec<String>,
    pub(crate) unreferenced: Vec<String>,
    pub(crate) unbound: Vec<String>,
    pub(crate) missing: Vec<String>,
    /// Tous les usages des références que le geste a touchées.
    ///
    /// Remplacer le fichier d'une référence partagée affecte plusieurs écrans :
    /// le rapport les nomme au lieu de laisser l'appelant les redécouvrir.
    pub(crate) usages: Vec<MediaUsage>,
}

/// Un usage d'une référence média dans le document, après le geste.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaUsage {
    pub(crate) asset_ref: String,
    pub(crate) node_path: String,
    pub(crate) field: &'static str,
}

/// Le champ média d'un Stage. Les deux seuls que le dialecte porte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaField {
    Audio,
    Image,
}

impl MediaField {
    fn key(self) -> &'static str {
        match self {
            MediaField::Audio => "audio",
            MediaField::Image => "image",
        }
    }
}

/// La forme d'un média local après le geste, présence comprise.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum StageMediaUpdate {
    /// Associer ou remplacer le média **de ce Stage seulement**. La règle de
    /// `CreatedMedia` s'applique telle quelle : un emplacement fourni exige une
    /// référence encore libre, une référence déjà liée se partage sans chemin.
    Set(CreatedMedia),
    Null,
    Absent,
}

/// Média local d'un Stage : associer, remplacer ou retirer.
///
/// Retirer n'efface rien sur le disque et ne défait aucune liaison : il n'existe
/// pas de politique de suppression média, et la référence relâchée
/// reste retrouvable. C'est aussi ce qui distingue ce geste de `repoint-media`,
/// qui change le fichier **de tous** les écrans d'une référence.
pub(crate) fn set_stage_media(
    document: &mut StoryDocument,
    bindings: &mut Vec<AdvancedMediaBinding>,
    stage_uuid: &str,
    field: MediaField,
    update: &StageMediaUpdate,
    report: &mut MediaBindingReport,
) -> Result<(), GestureError> {
    let index = unique_stage_index(document, stage_uuid)?;
    let path = format!("/stageNodes/@uuid={stage_uuid}#0/{}", field.key());
    let presence = match update {
        StageMediaUpdate::Absent => Presence::Absent,
        StageMediaUpdate::Null => Presence::Null,
        StageMediaUpdate::Set(media) => {
            Presence::Value(bind_created_media(bindings, media, &path, report)?)
        }
    };
    let stage = &mut document.stage_nodes[index];
    let slot = match field {
        MediaField::Audio => &mut stage.audio,
        MediaField::Image => &mut stage.image,
    };
    let released = std::mem::replace(slot, presence);
    if let Some(previous) = released.value() {
        if slot.value() != Some(previous) {
            report.released.push(previous.clone());
        }
    }
    Ok(())
}

/// Les usages d'une référence dans le document, par chemin d'auteur.
fn usages_of(document: &StoryDocument, asset_ref: &str) -> Vec<MediaUsage> {
    let paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    });
    document
        .stage_nodes
        .iter()
        .zip(paths)
        .flat_map(|(stage, path)| {
            [
                (MediaField::Audio, stage.audio.as_deref()),
                (MediaField::Image, stage.image.as_deref()),
            ]
            .into_iter()
            .filter(|(_, value)| *value == Some(asset_ref))
            .map(move |(field, _)| MediaUsage {
                asset_ref: asset_ref.to_string(),
                node_path: path.clone(),
                field: field.key(),
            })
            .collect::<Vec<_>>()
        })
        .collect()
}

fn index_of(bindings: &[AdvancedMediaBinding], asset_ref: &str) -> Option<usize> {
    bindings
        .iter()
        .position(|binding| binding.asset_ref == asset_ref)
}

/// Remplacement de média : même référence, nouveau fichier, tous ses usages.
pub(crate) fn repoint_media(
    document: &StoryDocument,
    bindings: &mut Vec<AdvancedMediaBinding>,
    asset_ref: &str,
    location: &AssetLocationInput,
    report: &mut MediaBindingReport,
) -> Result<(), GestureError> {
    if !referenced_asset_refs(document)
        .iter()
        .any(|reference| reference == asset_ref)
    {
        return Err(GestureError::new(
            "UNKNOWN_ASSET_REF",
            "/authoring/mediaBindings",
            format!(
                "Aucun Stage ne référence « {asset_ref} » : un remplacement ne crée pas la référence qu'il remplace."
            ),
        ));
    }
    match index_of(bindings, asset_ref) {
        Some(index) => {
            bindings[index].path = location.path();
            bindings[index].status = location.status();
            report.repointed.push(asset_ref.to_string());
        }
        // La référence existe dans le document sans liaison déclarée : le geste
        // la lie plutôt que d'exiger un détour, mais le dit en `added`.
        None => {
            bindings.push(AdvancedMediaBinding {
                asset_ref: asset_ref.to_string(),
                path: location.path(),
                status: location.status(),
            });
            report.added.push(asset_ref.to_string());
        }
    }
    Ok(())
}

/// Média porté par un nœud créé : soit un fichier nouveau et sa liaison, soit
/// le partage explicite d'une référence déjà liée.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreatedMedia {
    pub(crate) asset_ref: String,
    /// Absente, la référence doit **déjà** être liée : le geste réutilise la
    /// liaison existante et ne la re-pointe pas en silence. Présente, la
    /// référence ne doit **pas** l'être : re-pointer un média partagé par
    /// d'autres écrans est le geste `repoint-media`, pas une création.
    #[serde(default)]
    pub(crate) location: Option<AssetLocationInput>,
}

pub(crate) fn bind_created_media(
    bindings: &mut Vec<AdvancedMediaBinding>,
    media: &CreatedMedia,
    path: &str,
    report: &mut MediaBindingReport,
) -> Result<String, GestureError> {
    let asset_ref = media.asset_ref.trim();
    if asset_ref.is_empty() {
        return Err(GestureError::new(
            "INVALID_ASSET_REF",
            path,
            "Une référence de média ne peut pas être vide.".to_string(),
        ));
    }
    let existing = index_of(bindings, asset_ref);
    match (&media.location, existing) {
        (Some(_), Some(_)) => Err(GestureError::new(
            "ASSET_REF_ALREADY_BOUND",
            path,
            format!(
                "« {asset_ref} » est déjà liée : partager le média se demande sans chemin, la re-pointer est le geste de remplacement."
            ),
        )),
        (None, None) => Err(GestureError::new(
            "UNBOUND_ASSET_REF",
            path,
            format!("« {asset_ref} » n'est liée à aucun fichier : donner son emplacement."),
        )),
        (Some(location), None) => {
            bindings.push(AdvancedMediaBinding {
                asset_ref: asset_ref.to_string(),
                path: location.path(),
                status: location.status(),
            });
            report.added.push(asset_ref.to_string());
            Ok(asset_ref.to_string())
        }
        (None, Some(_)) => Ok(asset_ref.to_string()),
    }
}

/// Constats de fin de geste : références sans liaison, liaisons sans référence,
/// et liaisons référencées dont le fichier manque.
pub(crate) fn observe_media(
    document: &StoryDocument,
    bindings: &[AdvancedMediaBinding],
    report: &mut MediaBindingReport,
) {
    // Les usages sont relevés pour les seules références que le geste a
    // touchées : rendre l'inventaire complet du document à chaque geste
    // transformerait un rapport d'effet en second DTO de lecture.
    let mut touched: Vec<String> = report
        .added
        .iter()
        .chain(&report.repointed)
        .chain(&report.released)
        .cloned()
        .collect();
    touched.dedup();
    for asset_ref in &touched {
        if report
            .usages
            .iter()
            .any(|usage| usage.asset_ref == *asset_ref)
        {
            continue;
        }
        report.usages.extend(usages_of(document, asset_ref));
    }
    let referenced = referenced_asset_refs(document);
    for reference in &referenced {
        match bindings
            .iter()
            .find(|binding| binding.asset_ref == *reference)
        {
            None => report.unbound.push(reference.clone()),
            Some(binding) if binding.status == MediaBindingStatus::Missing => {
                report.missing.push(reference.clone());
            }
            Some(_) => {}
        }
    }
    report.unreferenced = bindings
        .iter()
        .filter(|binding| !referenced.contains(&binding.asset_ref))
        .map(|binding| binding.asset_ref.clone())
        .collect();
}

/// Forme fermée d'une liste de liaisons, vérifiée avant de rendre la liste.
///
/// Le geste ne rend jamais une liste que la porte d'enveloppe JavaScript
/// refuserait : elle est appliquée ici, à la source, sur l'entrée comme sur la
/// sortie.
pub(crate) fn validate_media_bindings(
    bindings: &[AdvancedMediaBinding],
) -> Result<(), GestureError> {
    for (index, binding) in bindings.iter().enumerate() {
        let path = format!("/authoring/mediaBindings/{index}");
        if binding.asset_ref.trim().is_empty() {
            return Err(GestureError::new(
                "INVALID_MEDIA_BINDING",
                &format!("{path}/assetRef"),
                "Une liaison porte une référence de dialecte vide.".to_string(),
            ));
        }
        if bindings[..index]
            .iter()
            .any(|earlier| earlier.asset_ref == binding.asset_ref)
        {
            return Err(GestureError::new(
                "DUPLICATE_MEDIA_BINDING",
                &format!("{path}/assetRef"),
                format!("« {} » est liée deux fois.", binding.asset_ref),
            ));
        }
        if binding
            .path
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(GestureError::new(
                "INVALID_MEDIA_BINDING",
                &format!("{path}/path"),
                "Un chemin de liaison est vide : utiliser null.".to_string(),
            ));
        }
        if binding.status == MediaBindingStatus::Resolved && binding.path.is_none() {
            return Err(GestureError::new(
                "INVALID_MEDIA_BINDING",
                &format!("{path}/status"),
                format!(
                    "« {} » est résolue sans chemin ; elle reste manquante tant que son fichier est inconnu.",
                    binding.asset_ref
                ),
            ));
        }
    }
    Ok(())
}
