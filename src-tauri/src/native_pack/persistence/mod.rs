//! Codec de projet avancé : document + contexte, sans import, préparation ni
//! readiness. Le transport JavaScript porte exclusivement la chaîne produite
//! ici.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    DecodedStoryDocument, DocumentOrigin, PackIdentityOrigin, StoryDocument, StoryDocumentContext,
};

// Acquisition d'un document avancé. La production des liaisons médias vit ici
// parce qu'elle dérive du même document acquis.
#[allow(dead_code)]
mod acquisition;

#[allow(unused_imports)]
pub(crate) use acquisition::{
    create_advanced_document, initialize_advanced_document, initialize_advanced_payload,
    media_bindings_for_document, referenced_asset_refs, system_pack_identity, AdvancedAcquisition,
    AdvancedMediaBinding, AssetLocation, MediaBindingStatus, PackIdentitySource,
};

pub(crate) const AUTHORING_PAYLOAD_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistenceError {
    pub(crate) code: &'static str,
    pub(crate) path: String,
    pub(crate) found: String,
    pub(crate) expected: String,
}

impl PersistenceError {
    fn new(code: &'static str, path: &str, found: impl ToString, expected: &str) -> Self {
        Self {
            code,
            path: path.into(),
            found: found.to_string(),
            expected: expected.into(),
        }
    }
}

impl std::fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} à {} : trouvé {}, attendu {}",
            self.code, self.path, self.found, self.expected
        )
    }
}
impl std::error::Error for PersistenceError {}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPayload {
    payload_version: u64,
    document: StoryDocument,
    context: StoryDocumentContext,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredPayloadRef<'a> {
    payload_version: u64,
    document: &'a StoryDocument,
    context: &'a StoryDocumentContext,
}

/// Codec d'écriture : il ne génère aucune identité et ne consulte aucun blocage.
/// L'acquisition résout l'identité **avant** de l'appeler.
pub(crate) fn encode_authoring_payload(
    payload: &DecodedStoryDocument,
) -> Result<String, PersistenceError> {
    serde_json::to_string(&StoredPayloadRef {
        payload_version: AUTHORING_PAYLOAD_VERSION,
        document: &payload.document,
        context: &payload.context,
    })
    .map_err(|error| {
        PersistenceError::new(
            "PAYLOAD_ENCODING_FAILED",
            "/",
            error,
            "document et contexte sérialisables",
        )
    })
}

/// Il n'existe aucun ancien format avancé publié. Une version absente/antérieure
/// réclame une migration nommée ; elle ne passe jamais par le décodeur d'import.
pub(crate) fn decode_authoring_payload(
    input: &str,
) -> Result<DecodedStoryDocument, PersistenceError> {
    let raw: Value = serde_json::from_str(input).map_err(|error| {
        PersistenceError::new("INVALID_PAYLOAD_JSON", "/", error, "objet JSON complet")
    })?;
    let object = raw
        .as_object()
        .ok_or_else(|| PersistenceError::new("INVALID_PAYLOAD_SHAPE", "/", &raw, "objet JSON"))?;
    match object.get("payloadVersion") {
        None => {
            return Err(PersistenceError::new(
                "PAYLOAD_MIGRATION_REQUIRED",
                "/payloadVersion",
                "absent",
                "version 1 ; aucune migration antérieure définie",
            ))
        }
        Some(value) => {
            if value.as_i64().is_some_and(|version| version < 0) {
                return Err(PersistenceError::new(
                    "PAYLOAD_MIGRATION_REQUIRED",
                    "/payloadVersion",
                    value,
                    "version 1 ; aucune migration antérieure définie",
                ));
            }
            let version = value.as_u64().ok_or_else(|| {
                PersistenceError::new(
                    "INVALID_PAYLOAD_VERSION",
                    "/payloadVersion",
                    value,
                    "entier positif ou nul",
                )
            })?;
            if version < AUTHORING_PAYLOAD_VERSION {
                return Err(PersistenceError::new(
                    "PAYLOAD_MIGRATION_REQUIRED",
                    "/payloadVersion",
                    version,
                    "version 1 ; aucune migration antérieure définie",
                ));
            }
            if version > AUTHORING_PAYLOAD_VERSION {
                return Err(PersistenceError::new(
                    "UNSUPPORTED_PAYLOAD_VERSION",
                    "/payloadVersion",
                    version,
                    "version 1",
                ));
            }
        }
    }
    validate_control_shapes(&raw)?;
    if let Some(members) = raw
        .pointer("/context/opaqueMembers")
        .and_then(Value::as_array)
    {
        for (index, member) in members.iter().enumerate() {
            if member
                .as_object()
                .is_some_and(|object| !object.contains_key("value"))
            {
                return Err(PersistenceError::new(
                    "INVALID_AUTHORING_PAYLOAD",
                    &format!("/context/opaqueMembers/{index}/value"),
                    "absent",
                    "valeur opaque, null compris",
                ));
            }
        }
    }
    let stored: StoredPayload = serde_json::from_value(raw.clone()).map_err(|error| {
        PersistenceError::new(
            "INVALID_AUTHORING_PAYLOAD",
            "/",
            error,
            "document et contexte d'édition complets, types et variantes connus",
        )
    })?;
    // Serde accepte aussi les structs sous forme de tableaux et ignore certains
    // champs inconnus. Un projet enregistré n'est pas un nouvel import : refuser
    // ces formes au lieu de perdre silencieusement leurs données au prochain encode.
    let canonical = serde_json::to_value(&stored).map_err(|error| {
        PersistenceError::new(
            "PAYLOAD_ENCODING_FAILED",
            "/",
            error,
            "payload sérialisable",
        )
    })?;
    validate_stored_shape(&raw, &canonical, "")?;
    Ok(DecodedStoryDocument {
        document: stored.document,
        context: stored.context,
        source_value: Value::Null,
    })
}

fn validate_control_shapes(raw: &Value) -> Result<(), PersistenceError> {
    let Some(stages) = raw
        .pointer("/document/stageNodes")
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    for (index, stage) in stages.iter().enumerate() {
        let Some(controls) = stage
            .get("controlSettings")
            .filter(|value| !value.is_null())
        else {
            continue;
        };
        let path = format!("/document/stageNodes/{index}/controlSettings");
        let object = controls.as_object().ok_or_else(|| {
            PersistenceError::new(
                "INVALID_CONTROL_SETTINGS",
                &path,
                controls,
                "objet, null ou absence",
            )
        })?;
        for key in ["wheel", "ok", "home", "pause", "autoplay"] {
            if let Some(value) = object
                .get(key)
                .filter(|value| !value.is_null() && !value.is_boolean())
            {
                return Err(PersistenceError::new(
                    "INVALID_CONTROL_SETTINGS",
                    &format!("{path}/{key}"),
                    value,
                    "booléen, null ou absence",
                ));
            }
        }
    }
    Ok(())
}

fn validate_stored_shape(
    raw: &Value,
    canonical: &Value,
    path: &str,
) -> Result<(), PersistenceError> {
    match (raw, canonical) {
        (Value::Object(input), Value::Object(output)) => {
            for (key, value) in input {
                let child = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                if let Some(expected) = output.get(key) {
                    validate_stored_shape(value, expected, &child)?;
                } else if !(key == "exportDispositionOrigin"
                    && value.is_null()
                    && path.starts_with("/context/opaqueMembers/")
                    || key == "discarded"
                        && value.as_array().is_some_and(Vec::is_empty)
                        && path.starts_with("/context/diagnostics/"))
                {
                    return Err(PersistenceError::new(
                        "UNKNOWN_PAYLOAD_FIELD",
                        &child,
                        "champ non représenté",
                        "champ du codec v1 ; extensions dans context.opaqueMembers",
                    ));
                }
            }
        }
        (Value::Array(input), Value::Array(output)) => {
            for (index, (value, expected)) in input.iter().zip(output).enumerate() {
                validate_stored_shape(value, expected, &format!("{path}/{index}"))?;
            }
        }
        (Value::Array(_), Value::Object(_)) => {
            return Err(PersistenceError::new(
                "INVALID_PAYLOAD_SHAPE",
                path,
                "tableau",
                "objet",
            ))
        }
        _ => {}
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum IdentityStatus {
    Resolved,
    RequiresGeneration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthoringPayloadSummary {
    pub(crate) payload_version: u64,
    pub(crate) document_origin: DocumentOrigin,
    pub(crate) stage_count: usize,
    pub(crate) action_count: usize,
    pub(crate) title: Option<String>,
    pub(crate) identity_status: IdentityStatus,
}

/// Validation d'ouverture pure : retourne uniquement une vue dérivée ; l'appelant
/// garde la chaîne originale, sans la réémettre ni interpréter son contenu en JS.
pub(crate) fn validate_authoring_payload(
    input: &str,
) -> Result<AuthoringPayloadSummary, PersistenceError> {
    let payload = decode_authoring_payload(input)?;
    Ok(AuthoringPayloadSummary {
        payload_version: AUTHORING_PAYLOAD_VERSION,
        document_origin: payload.context.document_origin,
        stage_count: payload.document.stage_nodes.len(),
        action_count: payload.document.action_nodes.len(),
        title: payload.document.title.value().cloned(),
        identity_status: if payload.context.pack_identity.origin
            == PackIdentityOrigin::RequiresGeneration
        {
            IdentityStatus::RequiresGeneration
        } else {
            IdentityStatus::Resolved
        },
    })
}

#[cfg(test)]
mod tests;
