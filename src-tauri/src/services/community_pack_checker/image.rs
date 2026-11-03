use crate::support::user_message;
use crate::support::user_message::codes;
use std::io::Cursor;
use std::path::Path;

use image::{guess_format, ImageFormat};

use super::models::{
    issue, FixDisposition, ImageValidationItem, PackValidationIssue, PackValidationSeverity,
    IMAGE_TARGET_HEIGHT, IMAGE_TARGET_WIDTH,
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
        _ => codes::CHECKER_IMAGE_FORMAT_UNKNOWN_TRANSPORT,
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
            codes::CHECKER_IMAGE_UNREADABLE_TRANSPORT,
        );
        image_issue.code = Some(codes::CHECKER_IMAGE_UNREADABLE.to_string());
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
            codes::CHECKER_IMAGE_FORMAT_DIMENSIONS_TRANSPORT,
            {
                let _msg_image_target_width = (IMAGE_TARGET_WIDTH).to_string();
                let _msg_image_target_height = (IMAGE_TARGET_HEIGHT).to_string();
                user_message::UserMessage::new(
                codes::CHECKER_IMAGE_CONVERT_RESIZE_TITLE,
            )
                .param(
                    "targetWidth",
                    user_message::transport_param(_msg_image_target_width.clone()),
                )
                .param(
                    "targetHeight",
                    user_message::transport_param(_msg_image_target_height.clone()),
                )
                .with_detail(format!(
                    "convertir en PNG, redimensionner en {_msg_image_target_width}×{_msg_image_target_height}",
                    _msg_image_target_height = user_message::transport_detail(&_msg_image_target_height),
                    _msg_image_target_width = user_message::transport_detail(&_msg_image_target_width),
                ))
                .into_transport()
            },
            {
                let _msg_image_target_width = (IMAGE_TARGET_WIDTH).to_string();
                let _msg_image_target_height = (IMAGE_TARGET_HEIGHT).to_string();
                user_message::UserMessage::new(
                codes::CHECKER_IMAGE_CONVERT_RESIZE_DESCRIPTION,
            )
                .param(
                    "targetWidth",
                    user_message::transport_param(_msg_image_target_width.clone()),
                )
                .param(
                    "targetHeight",
                    user_message::transport_param(_msg_image_target_height.clone()),
                )
                .with_detail(format!(
                    "Convertir en PNG et redimensionner en {_msg_image_target_width}×{_msg_image_target_height}.",
                    _msg_image_target_height = user_message::transport_detail(&_msg_image_target_height),
                    _msg_image_target_width = user_message::transport_detail(&_msg_image_target_width),
                ))
                .into_transport()
            },
        ),
        (false, true) => (
            codes::CHECKER_IMAGE_FORMAT_TRANSPORT,
            user_message::UserMessage::new(codes::CHECKER_PNG_CONVERSION_TITLE)
                .with_detail("convertir en PNG".to_string())
                .into_transport(),
            user_message::UserMessage::new(codes::CHECKER_PNG_CONVERSION_DESCRIPTION)
                .with_detail("Convertir l'image en PNG.".to_string())
                .into_transport(),
        ),
        (true, false) => (
            codes::CHECKER_IMAGE_DIMENSIONS_TRANSPORT,
            {
                let _msg_image_target_width = (IMAGE_TARGET_WIDTH).to_string();
                let _msg_image_target_height = (IMAGE_TARGET_HEIGHT).to_string();
                user_message::UserMessage::new(codes::CHECKER_IMAGE_RESIZE_TITLE)
                    .param(
                        "targetWidth",
                        user_message::transport_param(_msg_image_target_width.clone()),
                    )
                    .param(
                        "targetHeight",
                        user_message::transport_param(_msg_image_target_height.clone()),
                    )
                    .with_detail(format!(
                        "redimensionner en {_msg_image_target_width}×{_msg_image_target_height}",
                        _msg_image_target_height =
                            user_message::transport_detail(&_msg_image_target_height),
                        _msg_image_target_width =
                            user_message::transport_detail(&_msg_image_target_width),
                    ))
                    .into_transport()
            },
            user_message::UserMessage::new(codes::CHECKER_IMAGE_RESIZE_DESCRIPTION)
                .with_detail("Redimensionner l'image au format Lunii attendu.".to_string())
                .into_transport(),
        ),
        (true, true) => unreachable!("cas conforme déjà traité"),
    };

    let mut image_issue = issue(PackValidationSeverity::Warning, "image", label, message);
    image_issue.code = Some(
        match (format_supported, dimensions_ok) {
            (false, false) => codes::CHECKER_IMAGE_FORMAT_DIMENSIONS,
            (false, true) => codes::CHECKER_IMAGE_FORMAT,
            _ => codes::CHECKER_IMAGE_DIMENSIONS,
        }
        .to_string(),
    );
    image_issue.file_path = Some(file_path.clone());
    image_issue.technical_details = Some({
        let detected_image_format = (format
            .as_deref()
            .unwrap_or(codes::CHECKER_IMAGE_FORMAT_UNKNOWN_TRANSPORT))
        .to_string();
        let _msg_width = (width).to_string();
        let _msg_height = (height).to_string();
        let _msg_image_target_width = (IMAGE_TARGET_WIDTH).to_string();
        let _msg_image_target_height = (IMAGE_TARGET_HEIGHT).to_string();
        user_message::UserMessage::new(
            codes::CHECKER_IMAGE_FORMAT_UNEXPECTED,
        )
            .param("format", user_message::transport_param(detected_image_format.clone()))
            .param("width", user_message::transport_param(_msg_width.clone()))
            .param("height", user_message::transport_param(_msg_height.clone()))
            .param(
                "targetWidth",
                user_message::transport_param(_msg_image_target_width.clone()),
            )
            .param(
                "targetHeight",
                user_message::transport_param(_msg_image_target_height.clone()),
            )
            .with_detail(format!(
                "Détecté : {detected_image_format} {_msg_width}×{_msg_height}. Attendu : PNG, BMP ou JPEG en {_msg_image_target_width}×{_msg_image_target_height}.",
                _msg_height = user_message::transport_detail(&_msg_height),
                _msg_image_target_height = user_message::transport_detail(&_msg_image_target_height),
                _msg_image_target_width = user_message::transport_detail(&_msg_image_target_width),
                detected_image_format = user_message::transport_detail(&detected_image_format),
                _msg_width = user_message::transport_detail(&_msg_width),
            ))
            .into_transport()
    });
    image_issue.auto_fix_available = true;
    image_issue.fix_disposition = FixDisposition::Automatic;
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
    let img = image::load_from_memory(bytes).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_IMAGE_CORRECTION_UNREADABLE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Image illisible pour correction : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
            ))
            .into_transport()
    })?;
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
        .map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::CHECKER_PNG_ENCODE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Encodage PNG impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
    Ok(output)
}
