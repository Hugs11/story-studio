use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::super::{AssetRequest, AssetSourceKind, PreparedAsset};
use super::advanced::format::studio_image_extension;
use super::audio::hashed_asset_name;
use crate::services::project_files::validate_existing_file_path;
use crate::support::ffmpeg::file_ext;

pub(crate) fn ensure_image_320x240(bytes: &[u8], role: &str) -> Result<Option<Vec<u8>>, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Image illisible pour '{}' : {}", role, e))?;
    if img.width() == 320 && img.height() == 240 {
        return Ok(None);
    }
    let resized = img.resize_exact(320, 240, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("Encodage 320x240 pour '{}' : {}", role, e))?;
    Ok(Some(out))
}

/// Ce qu'il faut faire d'une image, décidé sur ses **octets**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ImagePlan {
    /// Les octets partent tels quels, sous l'extension de leur **vrai** format.
    Verbatim { extension: &'static str },
    /// Les octets sont réencodés en PNG 320×240.
    ReencodePng,
}

/// Décide du sort d'une image à partir de ce qu'elle contient, jamais de son nom.
///
/// Deux défauts se ressemblent et n'ont rien à voir :
///
/// - une image **mal étiquetée** — un JPEG nommé `.png` — partait dans
///   l'archive sous son extension mensongère. Les deux passerelles figées
///   dérivent le type d'un asset de son extension : elles lisent alors du JPEG
///   en croyant lire du PNG ;
/// - une image d'un format **hors de la liste fermée** — un `.webp`, un `.gif` —
///   déjà en 320×240 traversait sans être touchée, et disparaissait **en
///   silence** chez STUdio.
///
/// La chaîne avancée traitait déjà les deux ; la chaîne Libre nommait par
/// l'extension du fichier source. Cette fonction porte la décision commune, et
/// les deux l'empruntent.
pub(crate) fn plan_image_from_bytes(bytes: &[u8], role: &str) -> Result<ImagePlan, String> {
    let format = image::guess_format(bytes)
        .map_err(|error| format!("Format d'image indéterminé pour '{}' : {}", role, error))?;
    match studio_image_extension(format) {
        Some(extension) => Ok(ImagePlan::Verbatim { extension }),
        // Hors liste fermée : le réencodage est la seule sortie qui ne perde
        // pas le média.
        None => Ok(ImagePlan::ReencodePng),
    }
}

/// Réencode en PNG 320×240, quelles que soient les dimensions d'origine.
///
/// `ensure_image_320x240` rend `None` sur une image déjà à la bonne taille :
/// c'est ce qui laissait passer un format hors liste. Ici le réencodage est
/// inconditionnel, parce que c'est précisément ce qu'on veut de ce cas.
pub(crate) fn reencode_png_320x240(bytes: &[u8], role: &str) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Image illisible pour '{}' : {}", role, e))?;
    let sized = if img.width() == 320 && img.height() == 240 {
        img
    } else {
        img.resize_exact(320, 240, image::imageops::FilterType::Lanczos3)
    };
    let mut out = Vec::new();
    sized
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("Encodage 320x240 pour '{}' : {}", role, e))?;
    Ok(out)
}

pub(crate) fn stage_binary_asset(
    role: &str,
    source_path: &str,
    source_kind: &str,
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
    transformed: bool,
) -> Result<PreparedAsset, String> {
    let extension = file_ext(source_path).to_ascii_lowercase();
    stage_binary_asset_as(
        role,
        source_path,
        source_kind,
        &extension,
        assets_dir,
        seen_assets,
        transformed,
    )
}

/// Le même staging, sous une **extension imposée par l'appelant**.
///
/// L'extension d'un asset n'est pas cosmétique : les deux passerelles figées en
/// dérivent le type du média. La déduire du nom du fichier source revient à
/// faire confiance à son étiquette ; quand l'appelant a lu le vrai format dans
/// les octets, c'est ce format-là qui doit nommer l'entrée d'archive.
#[allow(clippy::too_many_arguments)]
pub(crate) fn stage_binary_asset_as(
    role: &str,
    source_path: &str,
    source_kind: &str,
    extension: &str,
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
    transformed: bool,
) -> Result<PreparedAsset, String> {
    let source = validate_existing_file_path(source_path, role)?;
    let bytes =
        fs::read(&source).map_err(|e| format!("Lecture impossible pour {} : {}", role, e))?;
    let asset_name = hashed_asset_name(&bytes, extension);
    let staged_path = assets_dir.join(&asset_name);
    let deduplicated = seen_assets.contains_key(&asset_name);
    if !deduplicated {
        fs::write(&staged_path, &bytes).map_err(|e| {
            format!(
                "Impossible d'ecrire l'asset prepare {} : {}",
                staged_path.display(),
                e
            )
        })?;
        seen_assets.insert(asset_name.clone(), staged_path.clone());
    }

    Ok(PreparedAsset {
        role: role.to_string(),
        source_path: source.to_string_lossy().to_string(),
        source_kind: source_kind.to_string(),
        staged_asset_name: asset_name,
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed,
        deduplicated,
    })
}

pub(crate) fn stage_binary_asset_bytes(
    role: &str,
    original_name: &str,
    bytes: &[u8],
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
) -> Result<PreparedAsset, String> {
    let extension = file_ext(original_name).to_ascii_lowercase();
    if extension.is_empty() {
        return Err(format!(
            "Extension introuvable pour l'asset importe {}",
            original_name
        ));
    }
    let asset_name = hashed_asset_name(bytes, &extension);
    let staged_path = assets_dir.join(&asset_name);
    let deduplicated = seen_assets.contains_key(&asset_name);
    if !deduplicated {
        fs::write(&staged_path, bytes).map_err(|e| {
            format!(
                "Impossible d'ecrire l'asset importe {} : {}",
                staged_path.display(),
                e
            )
        })?;
        seen_assets.insert(asset_name.clone(), staged_path.clone());
    }

    let source_kind = if matches!(
        extension.as_str(),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "webm" | "flac"
    ) {
        "audio"
    } else {
        "image"
    };

    Ok(PreparedAsset {
        role: role.to_string(),
        source_path: format!("zip://{}", original_name),
        source_kind: source_kind.to_string(),
        staged_asset_name: asset_name,
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed: false,
        deduplicated,
    })
}

pub(crate) fn image_request(role: &str, source_path: &str) -> AssetRequest {
    AssetRequest {
        role: role.to_string(),
        source_path: source_path.to_string(),
        source_kind: AssetSourceKind::Image,
        leading_silence_sec: 0.0,
        trailing_silence_sec: 0.0,
        entry_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(format: image::ImageFormat) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            320,
            240,
            image::Rgb([7, 9, 11]),
        ));
        let mut bytes = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut bytes), format)
            .expect("encoder l'image de banc");
        bytes
    }

    /// Le vrai format nomme l'entrée d'archive, pas l'étiquette du fichier.
    ///
    /// Un JPEG appelé `.png` partait sous `.png`. Les deux passerelles figées
    /// dérivent le type d'un asset de son extension : elles lisaient alors du
    /// JPEG en croyant lire du PNG.
    #[test]
    fn a_mislabelled_image_is_named_by_what_it_really_contains() {
        let jpeg = encoded(image::ImageFormat::Jpeg);
        assert_eq!(
            plan_image_from_bytes(&jpeg, "root/image").expect("plan"),
            ImagePlan::Verbatim { extension: "jpg" }
        );

        let png = encoded(image::ImageFormat::Png);
        assert_eq!(
            plan_image_from_bytes(&png, "root/image").expect("plan"),
            ImagePlan::Verbatim { extension: "png" }
        );
    }

    /// Un format hors liste fermée est réencodé, même déjà à la bonne taille.
    ///
    /// Un `.webp` de 320×240 traversait sans être touché et disparaissait **en
    /// silence** chez STUdio. `ensure_image_320x240` ne pouvait pas l'attraper
    /// — elle rend `None` sur une image déjà dimensionnée.
    #[test]
    fn an_image_outside_the_closed_list_is_reencoded_even_at_the_right_size() {
        let webp = encoded(image::ImageFormat::WebP);
        assert_eq!(
            plan_image_from_bytes(&webp, "root/image").expect("plan"),
            ImagePlan::ReencodePng
        );
        // La garde historique ne le voyait pas passer.
        assert_eq!(
            ensure_image_320x240(&webp, "root/image").expect("taille"),
            None
        );
        // Le réencodage inconditionnel, lui, le rattrape.
        let png = reencode_png_320x240(&webp, "root/image").expect("réencodage");
        assert_eq!(
            image::guess_format(&png).expect("format relu"),
            image::ImageFormat::Png
        );
        let decoded = image::load_from_memory(&png).expect("image relue");
        assert_eq!((decoded.width(), decoded.height()), (320, 240));
    }

    /// Le réencodage ne redimensionne pas ce qui est déjà à la bonne taille.
    #[test]
    fn reencoding_preserves_dimensions_that_are_already_right() {
        let gif = encoded(image::ImageFormat::Gif);
        let png = reencode_png_320x240(&gif, "root/image").expect("réencodage");
        let decoded = image::load_from_memory(&png).expect("image relue");
        assert_eq!((decoded.width(), decoded.height()), (320, 240));
    }
}
