use super::*;

pub(super) fn validate_reference_image_extension(path: &str) -> Result<(), String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "bmp")
    ) {
        return Err(format!(
            "Extension d'image de référence non autorisée (attendu : png, jpg, jpeg, webp, bmp) : {}",
            path
        ));
    }
    Ok(())
}

pub(super) fn image_mime_from_path(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    }
}

pub(super) fn join_url(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

pub(super) fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Impossible de créer le client HTTP : {}", e))
}

pub(super) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub(super) fn read_ws_frame(stream: &mut TcpStream) -> Result<Option<String>, String> {
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .map_err(|e| format!("Lecture WebSocket ComfyUI impossible : {}", e))?;

    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut len = (header[1] & 0x7f) as u64;
    if len == 126 {
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
        len = u16::from_be_bytes(buf) as u64;
    } else if len == 127 {
        let mut buf = [0u8; 8];
        stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
        len = u64::from_be_bytes(buf);
    }

    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask).map_err(|e| e.to_string())?;
    }

    if len > 10 * 1024 * 1024 {
        return Err("Message WebSocket ComfyUI trop volumineux.".to_string());
    }
    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .map_err(|e| format!("Payload WebSocket ComfyUI illisible : {}", e))?;
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }

    match opcode {
        1 => String::from_utf8(payload)
            .map(Some)
            .map_err(|e| format!("Message texte WebSocket ComfyUI invalide : {}", e)),
        8 => Ok(None),
        _ => Ok(Some(String::new())),
    }
}

pub(super) fn ws_path_for_client(base_url: &reqwest::Url, client_id: &str) -> String {
    let base_path = base_url.path().trim_end_matches('/');
    let path = if base_path.is_empty() {
        "/ws".to_string()
    } else {
        format!("{}/ws", base_path)
    };
    format!("{}?clientId={}", path, client_id)
}

pub(super) fn safe_comfyui_output_filename(filename: &str) -> Result<String, String> {
    if filename.trim().is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.chars().any(char::is_control)
    {
        return Err(format!("Nom de sortie ComfyUI invalide : {}", filename));
    }
    let file_name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Nom de sortie ComfyUI invalide : {}", filename))?;
    if file_name != filename {
        return Err(format!("Nom de sortie ComfyUI invalide : {}", filename));
    }
    Ok(file_name.to_string())
}
