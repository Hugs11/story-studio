use std::io::Cursor;
use std::path::Path;

use image::{guess_format, ImageFormat};

use super::models::{
    issue, ImageValidationItem, PackValidationIssue, PackValidationSeverity, IMAGE_TARGET_HEIGHT,
    IMAGE_TARGET_WIDTH,
};

/// Formats d'image acceptés par la Lunii / le format STUdio pour les visuels.
/// Le format natif de l'appareil est le BMP ; STUdio accepte aussi PNG et JPEG.
/// Tout autre format lisible (GIF, WebP, TIFF…) est converti en PNG par la
/// correction, pour ne jamais laisser dans le pack une image non supportée.
fn is_lunii_supported(format: ImageFormat) -> bool {
    matches!(
        format,
        ImageFormat::Png | ImageFormat::Bmp | ImageFormat::Jpeg
    )
}

fn format_label(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "PNG",
        ImageFormat::Jpeg => "JPEG",
        ImageFormat::Bmp => "BMP",
        ImageFormat::Gif => "GIF",
        ImageFormat::WebP => "WebP",
        ImageFormat::Tiff => "TIFF",
        _ => "format inconnu",
    }
}

pub(crate) fn analyze_image_bytes(
    bytes: &[u8],
    asset_name: &str,
    label: &str,
) -> (ImageValidationItem, Vec<PackValidationIssue>) {
    let file_path = format!("assets/{}", asset_name);
    // Détection par le contenu réel (et non l'extension) : un .png qui est en
    // réalité un JPEG/WebP est correctement diagnostiqué.
    let detected = guess_format(bytes).ok();
    let format = detected
        .map(|fmt| format_label(fmt).to_string())
        .or_else(|| {
            Path::new(asset_name)
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_uppercase())
        });

    let Ok(img) = image::load_from_memory(bytes) else {
        let mut image_issue = issue(
            PackValidationSeverity::Error,
            "image",
            label,
            "Cette image est illisible.",
        );
        image_issue.file_path = Some(file_path.clone());
        return (
            ImageValidationItem {
                file_path,
                label: label.to_string(),
                status: "error".to_string(),
                auto_fix_available: false,
                fix_summary: None,
                width: None,
                height: None,
                format,
            },
            vec![image_issue],
        );
    };

    let width = img.width();
    let height = img.height();
    let dimensions_ok = width == IMAGE_TARGET_WIDTH && height == IMAGE_TARGET_HEIGHT;
    let format_supported = detected.map(is_lunii_supported).unwrap_or(false);

    if dimensions_ok && format_supported {
        return (
            ImageValidationItem {
                file_path,
                label: label.to_string(),
                status: "ok".to_string(),
                auto_fix_available: false,
                fix_summary: None,
                width: Some(width),
                height: Some(height),
                format,
            },
            Vec::new(),
        );
    }

    let (message, fix_summary, fix_description) = match (format_supported, dimensions_ok) {
        (false, false) => (
            "Cette image n'est pas compatible Lunii (format et dimensions).",
            format!(
                "convertir en PNG, redimensionner en {}×{}",
                IMAGE_TARGET_WIDTH, IMAGE_TARGET_HEIGHT
            ),
            format!(
                "Convertir en PNG et redimensionner en {}×{}.",
                IMAGE_TARGET_WIDTH, IMAGE_TARGET_HEIGHT
            ),
        ),
        (false, true) => (
            "Cette image utilise un format non pris en charge par la Lunii.",
            "convertir en PNG".to_string(),
            "Convertir l'image en PNG.".to_string(),
        ),
        (true, false) => (
            "Cette image n'a pas les dimensions attendues.",
            format!(
                "redimensionner en {}×{}",
                IMAGE_TARGET_WIDTH, IMAGE_TARGET_HEIGHT
            ),
            "Redimensionner l'image au format Lunii attendu.".to_string(),
        ),
        (true, true) => unreachable!("cas conforme déjà traité"),
    };

    let mut image_issue = issue(PackValidationSeverity::Warning, "image", label, message);
    image_issue.file_path = Some(file_path.clone());
    image_issue.technical_details = Some(format!(
        "Détecté : {} {}×{}. Attendu : PNG, BMP ou JPEG en {}×{}.",
        format.as_deref().unwrap_or("format inconnu"),
        width,
        height,
        IMAGE_TARGET_WIDTH,
        IMAGE_TARGET_HEIGHT
    ));
    image_issue.auto_fix_available = true;
    image_issue.auto_fix_description = Some(fix_description);

    (
        ImageValidationItem {
            file_path,
            label: label.to_string(),
            status: "warning".to_string(),
            auto_fix_available: true,
            fix_summary: Some(fix_summary),
            width: Some(width),
            height: Some(height),
            format,
        },
        vec![image_issue],
    )
}

pub(crate) fn fix_image_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Image illisible pour correction : {}", e))?;
    // Ne redimensionne que si nécessaire (une image déjà au bon format n'a
    // alors qu'à être réencodée en PNG, sans rééchantillonnage inutile).
    let normalized = if img.width() == IMAGE_TARGET_WIDTH && img.height() == IMAGE_TARGET_HEIGHT {
        img
    } else {
        img.resize_exact(
            IMAGE_TARGET_WIDTH,
            IMAGE_TARGET_HEIGHT,
            image::imageops::FilterType::Lanczos3,
        )
    };
    let mut output = Vec::new();
    normalized
        .write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
        .map_err(|e| format!("Encodage PNG impossible : {}", e))?;
    Ok(output)
}
