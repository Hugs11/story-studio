use super::*;
/// Preserve the complete raw envelope (including absent/null distinctions).
/// No schema migration, default age, version or generated identity is applied.
pub fn project(path: &Path) -> Result<Observation, String> {
    read_project(path, None)
}
pub(super) fn project_for_scan(
    path: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Observation, String> {
    read_project(path, Some(cancel))
}
fn read_project(
    path: &Path,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Observation, String> {
    let raw = json(std::fs::File::open(path).map_err(|e| e.to_string())?)?;
    if !raw.is_object() {
        return Err("invalidProjectEnvelope".into());
    }
    if raw
        .get("schemaVersion")
        .is_some_and(|v| v.as_u64().is_none_or(|v| v > 4))
    {
        return Err("projectSchemaUnsupported".into());
    }
    if raw.get("schemaVersion").and_then(Value::as_u64) == Some(4)
        && raw.get("authoringMode").is_none()
    {
        return Err("invalidProjectEnvelope".into());
    }
    let mut out = Observation::new("project");
    for (pointer, kind) in [
        ("/schemaVersion", "integer"),
        ("/authoringMode", "string"),
        ("/projectType", "string"),
        ("/projectName", "string"),
        ("/name", "string"),
        ("/packVersion", "integer"),
        ("/packMinAge", "age"),
        ("/packDescription", "string"),
        ("/packConventionSource", "unknown"),
        ("/thumbnailImage", "string"),
        ("/rootImage", "string"),
    ] {
        out.fields
            .insert(pointer.into(), observed(&raw, pointer, kind));
    }
    for (field, kind) in [
        ("title", "string"),
        ("subtitle", "string"),
        ("keywords", "keywords"),
        ("description", "string"),
        ("version", "integer"),
        ("minAge", "age"),
        ("author", "string"),
        ("language", "string"),
        ("producer", "string"),
        ("bonus", "string"),
        ("uuid", "string"),
        ("packUuid", "string"),
        ("originalUuid", "string"),
    ] {
        let pointer = format!("/packMetadata/{field}");
        out.fields
            .insert(pointer.clone(), observed(&raw, &pointer, kind));
    }
    let advanced = raw.get("authoringMode").and_then(Value::as_str) == Some("advanced");
    let payload = if advanced {
        if raw.get("schemaVersion").and_then(Value::as_u64) != Some(4)
            || raw.get("projectType").and_then(Value::as_str) != Some("advanced")
        {
            return Err("invalidProjectEnvelope".into());
        }
        if raw
            .get("rootEntries")
            .and_then(Value::as_array)
            .is_none_or(|entries| !entries.is_empty())
            || raw
                .pointer("/authoring/mediaBindings")
                .and_then(Value::as_array)
                .is_none()
        {
            return Err("invalidProjectEnvelope".into());
        }
        for key in ["nativeGraph", "rootItems", "menus", "entries"] {
            if raw.get(key).is_some_and(|value| {
                !value.is_null() && value.as_array().is_none_or(|items| !items.is_empty())
            }) {
                return Err("invalidProjectEnvelope".into());
            }
        }
        let encoded = raw
            .pointer("/authoring/payload")
            .and_then(Value::as_str)
            .ok_or("invalidProjectPayload")?;
        crate::native_pack::persistence::decode_authoring_payload(encoded)
            .map_err(|e| e.to_string())?;
        Some(
            serde_json::from_str::<Value>(
                raw.pointer("/authoring/payload")
                    .and_then(Value::as_str)
                    .ok_or("invalidProjectPayload")?,
            )
            .map_err(|e| e.to_string())?,
        )
    } else {
        if raw
            .get("authoringMode")
            .is_some_and(|v| v.as_str() != Some("free"))
            || raw.get("authoring").is_some()
            || raw.get("projectType").and_then(Value::as_str) == Some("advanced")
        {
            return Err("invalidProjectEnvelope".into());
        }
        None
    };
    if let Some(payload) = payload.as_ref() {
        for (pointer, kind) in [
            ("/payloadVersion", "integer"),
            ("/context/packIdentity", "unknown"),
            ("/document/title", "string"),
            ("/document/description", "string"),
            ("/document/version", "integer"),
            ("/document/uuid", "string"),
        ] {
            let mut field = observed(payload, pointer, kind);
            field.source = format!("/authoring/payload#{pointer}");
            out.fields.insert(field.source.clone(), field);
        }
        if let Some(value) = payload.pointer("/context/packIdentity/value") {
            let mut id = identity(value, "/authoring/payload#/context/packIdentity/value");
            if payload
                .pointer("/context/packIdentity/origin")
                .and_then(Value::as_str)
                == Some("requiresGeneration")
            {
                id.reliable = false;
            }
            out.identity = Some(id);
        }
        out.title = payload
            .pointer("/document/title")
            .and_then(Value::as_str)
            .map(str::to_owned);
    } else {
        for pointer in ["/packMetadata/uuid", "/packMetadata/packUuid"] {
            if let Some(value) = raw.pointer(pointer) {
                let id = identity(value, pointer);
                if out
                    .identity
                    .as_ref()
                    .is_some_and(|old| old.value != id.value)
                {
                    if let Some(old) = out.identity.as_mut() {
                        old.reliable = false;
                    }
                    break;
                }
                out.identity = Some(id);
            }
        }
    }
    out.title = out.title.or_else(|| {
        ["/packMetadata/title", "/projectName", "/name"]
            .iter()
            .find_map(|p| {
                raw.pointer(p)
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
            })
    });
    out.age_min = ["/packMetadata/minAge", "/packMinAge"]
        .iter()
        .find_map(|p| raw.pointer(p).and_then(age));
    out.cover = ["/thumbnailImage", "/rootImage"].iter().find_map(|p| {
        raw.pointer(p)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .cloned()
    });
    if out.cover.is_none() {
        if let Some(payload) = payload.as_ref() {
            let image = payload
                .pointer("/document/stageNodes")
                .and_then(Value::as_array)
                .and_then(|nodes| {
                    nodes
                        .iter()
                        .find(|n| n.get("squareOne").and_then(Value::as_bool) == Some(true))
                })
                .and_then(|node| node.get("image"))
                .and_then(Value::as_str);
            if let Some(image) = image {
                out.cover = raw
                    .pointer("/authoring/mediaBindings")
                    .and_then(Value::as_array)
                    .and_then(|bindings| {
                        bindings.iter().find(|b| {
                            b.get("assetRef").and_then(Value::as_str) == Some(image)
                                && b.get("status").and_then(Value::as_str) == Some("resolved")
                        })
                    })
                    .and_then(|b| b.get("path"))
                    .filter(|v| v.is_string())
                    .cloned();
            }
        }
    }
    // Resolve for the consumer without changing the raw project reference.
    if let Some(relative) = out.cover.as_ref().and_then(Value::as_str) {
        let cover = Path::new(relative);
        let resolved = if cover.is_absolute() {
            cover.to_owned()
        } else {
            path.parent().unwrap_or(Path::new(".")).join(cover)
        };
        out.cover = Some(
            serde_json::json!({"raw":relative,"path":crate::support::paths::path_for_frontend(&resolved),"available":resolved.is_file()}),
        );
    }
    out.raw = raw;
    if let Some(cancel) = cancel {
        super::listening::project(&mut out, path, payload.as_ref(), cancel);
    }
    Ok(out)
}
