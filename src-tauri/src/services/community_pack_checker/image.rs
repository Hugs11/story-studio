use std::io::Cursor;
use std::path::Path;

use image::ImageFormat;

use super::models::{
    issue, ImageValidationItem, PackValidationIssue, PackValidationSeverity, IMAGE_TARGET_HEIGHT,
    IMAGE_TARGET_WIDTH,
};

pub(crate) fn analyze_image_bytes(
    bytes: &[u8],
    asset_name: &str,
    label: &str,
) -> (ImageValidationItem, Vec<PackValidationIssue>) {
    let file_path = format!("assets/{}", asset_name);
    let format = Path::new(asset_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_uppercase());

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
    if width == IMAGE_TARGET_WIDTH && height == IMAGE_TARGET_HEIGHT {
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

    let mut image_issue = issue(
        PackValidationSeverity::Warning,
        "image",
        label,
        "Cette image n'a pas les dimensions attendues.",
    );
    image_issue.file_path = Some(file_path.clone());
    image_issue.technical_details = Some(format!(
        "Détecté : {}×{}. Attendu : {}×{}.",
        width, height, IMAGE_TARGET_WIDTH, IMAGE_TARGET_HEIGHT
    ));
    image_issue.auto_fix_available = true;
    image_issue.auto_fix_description =
        Some("Redimensionner l'image au format Lunii attendu.".to_string());

    (
        ImageValidationItem {
            file_path,
            label: label.to_string(),
            status: "warning".to_string(),
            auto_fix_available: true,
            fix_summary: Some(format!(
                "redimensionner en {}×{}",
                IMAGE_TARGET_WIDTH, IMAGE_TARGET_HEIGHT
            )),
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
    let resized = img.resize_exact(
        IMAGE_TARGET_WIDTH,
        IMAGE_TARGET_HEIGHT,
        image::imageops::FilterType::Lanczos3,
    );
    let mut output = Vec::new();
    resized
        .write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
        .map_err(|e| format!("Encodage PNG impossible : {}", e))?;
    Ok(output)
}
