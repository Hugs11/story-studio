//! Enveloppe UI ; les erreurs historiques conservent leur format sérialisé.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) mod codes;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct UserMessage {
    pub(crate) code: String,
    #[serde(default)]
    pub(crate) params: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

impl UserMessage {
    pub(crate) fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: Map::new(),
            detail: None,
        }
    }

    pub(crate) fn param(mut self, name: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(name.into(), value.into());
        self
    }

    pub(crate) fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Transport transitoire pour les services renvoyant encore String.
    /// Contient l’enveloppe, sans phrase sentinelle à reconnaître.
    pub(crate) fn into_transport(self) -> String {
        #[cfg(test)]
        {
            let presentation_code = self
                .params
                .get("context")
                .and_then(Value::as_str)
                .filter(|context| context.starts_with(&format!("{}_", self.code)))
                .unwrap_or(&self.code);
            if let Some((_, names, _)) = codes::REGISTRY
                .iter()
                .find(|(code, _, _)| *code == presentation_code)
            {
                for name in *names {
                    assert!(
                        self.params.contains_key(*name),
                        "{} missing parameter {}",
                        presentation_code,
                        name
                    );
                }
            }
        }
        serde_json::to_string(&self).unwrap_or_else(|_| {
            format!(r#"{{"code":"{}","params":{{}}}}"#, codes::UNEXPECTED_ERROR)
        })
    }
}

/// An application label and its translatable value; author data remains literal.
#[derive(Clone)]
pub(crate) struct MessageLabel {
    raw: String,
    value: Value,
}
impl MessageLabel {
    pub(crate) fn literal(raw: impl Into<String>, code: &str) -> Self {
        Self::new(raw, UserMessage::new(code))
    }
    pub(crate) fn new(raw: impl Into<String>, message: UserMessage) -> Self {
        Self {
            raw: raw.into(),
            value: serde_json::to_value(message).expect("serializable label"),
        }
    }
    pub(crate) fn data(raw: impl Into<String>) -> Self {
        let raw = raw.into();
        Self {
            value: Value::String(raw.clone()),
            raw,
        }
    }
    pub(crate) fn value(&self) -> Value {
        self.value.clone()
    }
}
impl std::ops::Deref for MessageLabel {
    type Target = str;
    fn deref(&self) -> &str {
        &self.raw
    }
}
impl std::fmt::Display for MessageLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.raw)
    }
}

impl From<String> for UserMessage {
    fn from(detail: String) -> Self {
        serde_json::from_str(&detail)
            .unwrap_or_else(|_| Self::new(codes::UNEXPECTED_ERROR).with_detail(detail))
    }
}

impl std::fmt::Display for UserMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.detail.as_deref().unwrap_or(&self.code))
    }
}
impl std::error::Error for UserMessage {}

/// La valeur historique accompagne séparément le message UI. L’adaptation est
/// réversible sans insérer ses champs dans le contrat d’interpolation ni changer
/// sa sérialisation (y compris celle des diagnostics persistés).
#[derive(Debug, Clone)]
pub(crate) struct AdaptedError<E> {
    pub(crate) message: UserMessage,
    original: E,
}
impl<E> AdaptedError<E> {
    pub(crate) fn into_original(self) -> E {
        self.original
    }
}

macro_rules! adapter {
    ($ty:path, $convert:expr) => {
        impl From<$ty> for AdaptedError<$ty> {
            fn from(original: $ty) -> Self {
                Self {
                    message: ($convert)(&original),
                    original,
                }
            }
        }
        impl From<$ty> for UserMessage {
            fn from(error: $ty) -> Self {
                AdaptedError::from(error).message
            }
        }
        impl From<AdaptedError<$ty>> for $ty {
            fn from(error: AdaptedError<$ty>) -> Self {
                error.into_original()
            }
        }
    };
}

adapter!(
    crate::native_pack::StoryDecodeError,
    |error: &crate::native_pack::StoryDecodeError| {
        let messages = error
            .diagnostics
            .iter()
            .map(|diagnostic| {
                let message = UserMessage {
                    code: diagnostic.code.clone(),
                    params: diagnostic.params.clone(),
                    detail: Some(diagnostic.message.clone()),
                }
                .into_transport();
                compose_messages(
                    &[
                        format!("{} {}: ", diagnostic.code, diagnostic.path),
                        message,
                    ],
                    "",
                )
            })
            .collect::<Vec<_>>();
        UserMessage::from(compose_messages(&messages, " | ")).with_detail(error.to_string())
    }
);

adapter!(
    crate::native_pack::editing::GestureError,
    |error: &crate::native_pack::editing::GestureError| {
        UserMessage {
            code: error.code.to_string(),
            params: error.params.clone(),
            detail: Some(error.message.clone()),
        }
    }
);
adapter!(
    crate::native_pack::persistence::PersistenceError,
    |error: &crate::native_pack::persistence::PersistenceError| {
        UserMessage::new(error.code)
            .param("path", error.path.clone())
            .param("found", error.found.clone())
            .param("expected", error.expected.clone())
            .with_detail(error.to_string())
    }
);
adapter!(
    crate::services::youtube::YoutubeError,
    |error: &crate::services::youtube::YoutubeError| {
        let code = serde_json::to_value(error.code).ok();
        UserMessage::new(
            code.as_ref()
                .and_then(Value::as_str)
                .unwrap_or(codes::UNEXPECTED_ERROR),
        )
        .with_detail(&error.message)
    }
);
adapter!(
    crate::native_pack::advanced_export::AdvancedExportError,
    |error: &crate::native_pack::advanced_export::AdvancedExportError| {
        use crate::native_pack::advanced_export::AdvancedExportError as E;
        let value = serde_json::to_value(error).ok();
        let code = value
            .as_ref()
            .and_then(|value| value.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or(codes::UNEXPECTED_ERROR);
        let mut message = UserMessage::new(code).with_detail(error.to_string());
        match error {
            E::PayloadDecode { .. } => {}
            E::MediaUnavailable { entries } => message = message.param("count", entries.len()),
            E::ArchiveNameCollision { conflicts } => {
                message = message.param("count", conflicts.len())
            }
            E::MediaOracle { disagreements } => {
                message = message.param("count", disagreements.len())
            }
            E::OutputWrite { path, .. } => message = message.param("path", path.clone()),
            _ => {}
        }
        message
    }
);

/// A collection of coded messages, rendered with the historical separator by JS.
pub(crate) fn message_list(messages: &[String], separator: &str) -> Value {
    serde_json::json!({ "messages": messages.iter().map(|message| {
            serde_json::from_str::<Value>(message).unwrap_or_else(|_| Value::String(message.clone()))
            }).collect::<Vec<_>>(), "separator": separator })
}

/// Conserve une cause déjà codée lors de la composition d'un message.
/// Les valeurs d'auteur et les sorties d'outils restent des chaînes littérales.
pub(crate) fn transport_param(value: String) -> Value {
    serde_json::from_str::<UserMessage>(&value)
        .ok()
        .and_then(|message| serde_json::to_value(message).ok())
        .unwrap_or(Value::String(value))
}

/// Adapt a synchronous String service without changing its short-circuiting.
pub(crate) fn user_message_result<T>(
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, UserMessage> {
    run().map_err(UserMessage::from)
}

/// Keep the original diagnostic prose separate from nested IPC envelopes.
pub(crate) fn transport_detail(value: &str) -> String {
    serde_json::from_str::<UserMessage>(value)
        .ok()
        .and_then(|message| message.detail)
        .unwrap_or_else(|| value.to_string())
}

pub(crate) fn compose_messages(messages: &[String], separator: &str) -> String {
    let mut parts = message_list(messages, separator);
    parts["data"] = Value::Bool(true);
    UserMessage::new(codes::UI_MESSAGE_PARTS)
        .param("parts", parts)
        .with_detail(
            messages
                .iter()
                .map(|message| transport_detail(message))
                .collect::<Vec<_>>()
                .join(separator),
        )
        .into_transport()
}

pub(crate) fn generation_cancelled() -> UserMessage {
    UserMessage::new(codes::GENERATION_CANCELLED).with_detail("Génération annulée.")
}

/// Ajoute un contexte sans perdre la cause codée dans les services String.
pub(crate) fn contextual_error(context: &str, error: String) -> String {
    match serde_json::from_str::<UserMessage>(&error) {
        Ok(mut message) => {
            message.detail = Some(format!("{context} : {}", message));
            message.into_transport()
        }
        Err(_) => format!("{context} : {error}"),
    }
}

pub(crate) fn coded_error(code: &str, detail: impl Into<String>) -> String {
    UserMessage::new(code).with_detail(detail).into_transport()
}

/// Assert semantic causes in tests, including composed String transports.
#[cfg(test)]
pub(crate) fn contains_code(transport: &str, code: &str) -> bool {
    fn contains(value: &Value, code: &str) -> bool {
        match value {
            Value::Object(map) => {
                map.get("code").and_then(Value::as_str) == Some(code)
                    || map.values().any(|value| contains(value, code))
            }
            Value::Array(values) => values.iter().any(|value| contains(value, code)),
            Value::String(text) => {
                serde_json::from_str::<Value>(text).is_ok_and(|value| contains(&value, code))
            }
            _ => false,
        }
    }
    serde_json::from_str::<Value>(transport).is_ok_and(|value| contains(&value, code))
}

#[cfg(test)]
pub(crate) trait MessageTransportAssertions {
    fn contains_any_code(&self, expected: &[&str]) -> bool;
}
#[cfg(test)]
impl MessageTransportAssertions for str {
    fn contains_any_code(&self, expected: &[&str]) -> bool {
        expected.iter().any(|code| contains_code(self, code))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn decoder_adapter_preserves_diagnostics_and_technical_display() {
        let original =
            crate::native_pack::decode_story_document("{bad").expect_err("syntax refusal");
        let historical = original.to_string();
        let adapted = super::AdaptedError::from(original.clone());
        assert_eq!(adapted.message.code, super::codes::UI_MESSAGE_PARTS);
        assert_eq!(adapted.message.detail.as_deref(), Some(historical.as_str()));
        let diagnostic = &original.diagnostics[0];
        assert!(super::contains_code(
            &adapted.message.clone().into_transport(),
            &diagnostic.code
        ));
        assert_eq!(adapted.into_original(), original);
    }

    use super::*;
    #[test]
    fn rust_message_registry_matches_versioned_file() {
        let messages: Vec<_> = codes::REGISTRY
            .iter()
            .map(|(code, params, plural)| {
                let mut value = serde_json::json!({"code": code, "params": params});
                if let Some(plural) = plural {
                    assert!(params.contains(plural), "{code}: plural parameter absent");
                    value["plural"] = serde_json::json!(plural);
                }
                if codes::LABEL_CODES.contains(code) {
                    value["label"] = Value::Bool(true);
                }
                value
            })
            .collect();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/locales/_generated/rust-messages.json");
        if std::env::var_os("UPDATE_RUST_MESSAGES").is_some() {
            std::fs::write(
                &path,
                format!("{}\n", serde_json::to_string_pretty(&messages).unwrap()),
            )
            .unwrap();
        }
        let checked: Value = serde_json::from_str(
            &std::fs::read_to_string(path).expect("versioned registry is required"),
        )
        .unwrap();
        assert_eq!(checked, serde_json::to_value(messages).unwrap(), "Update: cd src-tauri && UPDATE_RUST_MESSAGES=1 cargo test rust_message_registry_matches_versioned_file");
    }
    #[test]
    fn all_legacy_adapters_are_reversible_without_wire_changes() {
        use crate::native_pack::{
            advanced_export::AdvancedExportError, persistence::PersistenceError,
        };
        let persistence = PersistenceError {
            code: "INVALID_PAYLOAD_JSON",
            path: "/".into(),
            found: "x".into(),
            expected: "y".into(),
        };
        let expected = serde_json::to_value(&persistence).unwrap();
        let adapted = AdaptedError::from(persistence);
        assert_eq!(adapted.message.params["found"], "x");
        assert_eq!(
            serde_json::to_value(PersistenceError::from(adapted)).unwrap(),
            expected
        );
        let youtube =
            crate::services::youtube::YoutubeError::from("raw external output".to_string());
        let expected = serde_json::to_value(&youtube).unwrap();
        let adapted = AdaptedError::from(youtube);
        assert_eq!(adapted.message.code, "other");
        assert_eq!(
            serde_json::to_value(crate::services::youtube::YoutubeError::from(adapted)).unwrap(),
            expected
        );
        for export in [
            AdvancedExportError::ExportCancelled,
            AdvancedExportError::OutputWrite {
                path: "/tmp/a".into(),
                message: "Permission denied".into(),
            },
        ] {
            let expected = serde_json::to_value(&export).unwrap();
            let adapted = AdaptedError::from(export);
            assert_eq!(
                serde_json::to_value(AdvancedExportError::from(adapted)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn envelope_and_legacy_roundtrip_keep_the_wire_contract() {
        let error = crate::native_pack::editing::GestureError::new(
            "UNKNOWN_NODE",
            "/stage/a",
            "Texte modifié pour le test".into(),
        )
        .with_references(vec!["/action/b".into()]);
        let before = serde_json::to_value(&error).unwrap();
        let adapted = AdaptedError::from(error);
        assert_eq!(adapted.message.code, "UNKNOWN_NODE");
        assert_eq!(
            serde_json::to_value(adapted.into_original()).unwrap(),
            before
        );
        assert_eq!(
            serde_json::to_value(UserMessage::new(codes::GENERATION_CANCELLED)).unwrap(),
            serde_json::json!({"code":"GENERATION_CANCELLED", "params":{}})
        );
    }
}
