//! Erreurs YouTube typées. yt-dlp ne renvoie que du texte : la classification
//! (pure, testée) transforme ses messages anglais en une cause stable, que le
//! frontend exploite (arrêt d'un lot sur blocage) et en un conseil lisible.

use crate::support::user_message::codes;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum YoutubeErrorCode {
    /// Vérification anti-robot ou limitation de débit : toute nouvelle requête
    /// depuis la même connexion prolonge le blocage.
    Blocked,
    AgeRestricted,
    Private,
    MembersOnly,
    GeoBlocked,
    Unavailable,
    Live,
    TooLarge,
    Network,
    /// Mode « outils installés uniquement » : yt-dlp n'est pas installé et
    /// la vérification de fond ne le télécharge jamais d'elle-même.
    ToolMissing,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct YoutubeError {
    pub code: YoutubeErrorCode,
    pub message: String,
}

impl YoutubeError {
    pub fn new(code: YoutubeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn is_blocked(&self) -> bool {
        self.code == YoutubeErrorCode::Blocked
    }
}

impl From<String> for YoutubeError {
    fn from(message: String) -> Self {
        Self::new(YoutubeErrorCode::Other, message)
    }
}

impl std::fmt::Display for YoutubeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Dernière ligne `ERROR:` de yt-dlp, ou à défaut la dernière ligne non vide.
fn error_detail(output: &str) -> &str {
    let lines = || {
        output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
    };
    lines()
        .rfind(|line| line.starts_with("ERROR:"))
        .or_else(|| lines().next_back())
        .unwrap_or(codes::YOUTUBE_UNKNOWN_ERROR_TRANSPORT)
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

/// Classe une sortie d'échec de yt-dlp. `context` préfixe le détail brut
/// lorsqu'aucune cause connue n'est reconnue.
pub fn classify_failure(output: &str, context: &str) -> YoutubeError {
    let text = output.to_lowercase().replace('’', "'");
    let (code, message) = if text.contains("not a bot") {
        (YoutubeErrorCode::Blocked, codes::YOUTUBE_BLOCKED_TRANSPORT)
    } else if contains_any(&text, &["http error 429", "too many requests"]) {
        (
            YoutubeErrorCode::Blocked,
            codes::YOUTUBE_RATE_LIMIT_TRANSPORT,
        )
    } else if contains_any(
        &text,
        &[
            "confirm your age",
            "age-restricted",
            "age restricted",
            "inappropriate for some users",
        ],
    ) {
        (
            YoutubeErrorCode::AgeRestricted,
            codes::YOUTUBE_AGE_RESTRICTED_TRANSPORT,
        )
    } else if contains_any(
        &text,
        &[
            "members-only",
            "members only",
            "join this channel",
            "channel's members",
        ],
    ) {
        (
            YoutubeErrorCode::MembersOnly,
            codes::YOUTUBE_MEMBERS_ONLY_TRANSPORT,
        )
    } else if text.contains("private video") {
        (YoutubeErrorCode::Private, codes::YOUTUBE_PRIVATE_TRANSPORT)
    } else if contains_any(
        &text,
        &["in your country", "geo restriction", "geo-restricted"],
    ) {
        (
            YoutubeErrorCode::GeoBlocked,
            codes::YOUTUBE_GEO_BLOCKED_TRANSPORT,
        )
    } else if contains_any(
        &text,
        &[
            "live event will begin",
            "premieres in",
            "premiere will begin",
            "this live event",
            "is live now",
        ],
    ) {
        (YoutubeErrorCode::Live, codes::YOUTUBE_LIVE_TRANSPORT)
    } else if contains_any(&text, &["larger than max-filesize", "max-filesize"]) {
        (
            YoutubeErrorCode::TooLarge,
            codes::YOUTUBE_TOO_LARGE_TRANSPORT,
        )
    } else if contains_any(
        &text,
        &[
            "video unavailable",
            "has been removed",
            "no longer available",
            "account associated with this video has been terminated",
            "this video is not available",
        ],
    ) {
        (
            YoutubeErrorCode::Unavailable,
            // « This video is not available » couvre aussi une vidéo « made for
            // kids » lue sans moteur JavaScript : ne pas affirmer une suppression.
            codes::YOUTUBE_UNAVAILABLE_TRANSPORT,
        )
    } else if contains_any(
        &text,
        &[
            "failed to establish a new connection",
            "name or service not known",
            "temporary failure in name resolution",
            "getaddrinfo failed",
            "network is unreachable",
            "nodename nor servname",
            "timed out",
        ],
    ) {
        (YoutubeErrorCode::Network, codes::YOUTUBE_NETWORK_TRANSPORT)
    } else {
        return YoutubeError::new(
            YoutubeErrorCode::Other,
            crate::support::user_message::UserMessage::new(codes::YOUTUBE_FAILURE_CONTEXT_DETAIL)
                .param(
                    "context",
                    crate::support::user_message::transport_param(context.to_string()),
                )
                .param(
                    "output",
                    crate::support::user_message::transport_param(error_detail(output).to_string()),
                )
                .into_transport(),
        );
    };
    YoutubeError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::{classify_failure, YoutubeErrorCode};
    use crate::support::user_message::{self, codes};

    fn code(output: &str) -> YoutubeErrorCode {
        classify_failure(output, "Téléchargement impossible").code
    }

    #[test]
    fn recognizes_blocking_answers() {
        assert_eq!(
            code("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies"),
            YoutubeErrorCode::Blocked
        );
        assert_eq!(
            code("ERROR: Unable to download API page: HTTP Error 429: Too Many Requests"),
            YoutubeErrorCode::Blocked
        );
    }

    #[test]
    fn recognizes_video_level_causes() {
        let cases = [
            ("ERROR: [youtube] x: Sign in to confirm your age.", YoutubeErrorCode::AgeRestricted),
            ("ERROR: [youtube] x: Private video. Sign in", YoutubeErrorCode::Private),
            ("ERROR: [youtube] x: Join this channel to get access to members-only content", YoutubeErrorCode::MembersOnly),
            ("ERROR: [youtube] x: The uploader has not made this video available in your country", YoutubeErrorCode::GeoBlocked),
            ("ERROR: [youtube] x: This live event will begin in 3 hours.", YoutubeErrorCode::Live),
            ("ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader", YoutubeErrorCode::Unavailable),
            ("[download] File is larger than max-filesize (1 bytes > 0 bytes). Aborting.", YoutubeErrorCode::TooLarge),
            ("ERROR: Unable to download API page: <urlopen error [Errno -3] Temporary failure in name resolution>", YoutubeErrorCode::Network),
        ];
        for (output, expected) in cases {
            assert_eq!(code(output), expected, "{output}");
        }
    }

    #[test]
    fn unknown_failure_keeps_the_last_error_line() {
        let error = classify_failure(
            "WARNING: something\nERROR: [youtube] x: Strange failure\n\n",
            "Téléchargement impossible",
        );
        assert_eq!(error.code, YoutubeErrorCode::Other);
        let message: user_message::UserMessage = serde_json::from_str(&error.message).unwrap();
        assert_eq!(message.code, codes::YOUTUBE_FAILURE_CONTEXT_DETAIL);
        assert_eq!(
            message.params["output"],
            "ERROR: [youtube] x: Strange failure"
        );
        assert_eq!(message.params["context"], "Téléchargement impossible");
        let empty = classify_failure("", "Lecture impossible");
        let message: user_message::UserMessage = serde_json::from_str(&empty.message).unwrap();
        assert_eq!(message.params["context"], "Lecture impossible");
        assert_eq!(
            message.params["output"]["code"],
            codes::YOUTUBE_UNKNOWN_ERROR
        );
    }

    #[test]
    fn serializes_codes_for_the_frontend() {
        let json = serde_json::to_value(classify_failure("not a bot", "x")).unwrap();
        assert_eq!(json["code"], "blocked");
        let message: user_message::UserMessage =
            serde_json::from_str(json["message"].as_str().unwrap()).unwrap();
        assert_eq!(message.code, "blocked");
        assert!(message.params.is_empty());
    }
}
