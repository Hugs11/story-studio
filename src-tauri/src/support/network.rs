use std::net::{IpAddr, Ipv6Addr};
use std::time::Duration;

use reqwest::Url;

/// Construit un client HTTP bloquant avec un timeout donné.
/// Partagé par les services qui font des requêtes réseau (ComfyUI, XTTS gardent
/// historiquement leur propre copie ; les nouveaux usages passent par ici).
pub(crate) fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Impossible de créer le client HTTP : {}", e))
}

/// Construit un client HTTP public qui valide aussi les redirections. Utilisé
/// pour les artefacts épinglés téléchargés depuis des hôtes officiels.
pub(crate) fn public_download_client(
    timeout: Duration,
    service: &'static str,
) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let next = attempt.url().as_str();
            if attempt.previous().len() >= 10 {
                return attempt.error(std::io::Error::other(format!(
                    "Trop de redirections pendant le téléchargement {}.",
                    service
                )));
            }
            match require_public_download_url(next, service) {
                Ok(()) => attempt.follow(),
                Err(err) => attempt.error(std::io::Error::other(err)),
            }
        }))
        .build()
        .map_err(|e| format!("Impossible de créer le client HTTP : {}", e))
}

fn is_allowed_local_host(host: &str) -> bool {
    if matches!(host, "localhost") {
        return true;
    }

    let Ok(ip) = host.parse::<IpAddr>() else {
        return false;
    };

    match ip {
        IpAddr::V4(ipv4) => ipv4.is_loopback() || ipv4.is_private(),
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback() || ipv6.is_unique_local() || is_ipv6_unicast_link_local(&ipv6)
        }
    }
}

fn is_ipv6_unicast_link_local(ip: &Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// Hôtes officiels autorisés pour le téléchargement d'artefacts tiers
/// (binaire Piper, voix). Toute autre origine est refusée.
const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "huggingface.co",
    "hf.co",
];

/// Valide qu'une URL de téléchargement est en HTTPS et pointe vers un hôte
/// officiel connu (ou un sous-domaine). Les URL sont épinglées dans le code
/// (catalogue Piper) ; cette vérification est une défense supplémentaire avant
/// toute requête réseau sortante.
pub(crate) fn require_public_download_url(url: &str, service: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|e| format!("URL {} invalide : {}", service, e))?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "URL {} refusée : seul HTTPS est autorisé (reçu : {}).",
            service,
            parsed.scheme()
        ));
    }
    let host = parsed.host_str().unwrap_or("");
    let allowed = ALLOWED_DOWNLOAD_HOSTS
        .iter()
        .any(|&allowed| host == allowed || host.ends_with(&format!(".{}", allowed)));
    if !allowed {
        return Err(format!(
            "URL {} refusée : hôte non officiel ({}).",
            service, host
        ));
    }
    Ok(())
}

pub(crate) fn require_local_url(url: &str, service: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|e| format!("URL {} invalide : {}", service, e))?;
    let host = parsed.host_str().unwrap_or("");
    if !is_allowed_local_host(host) {
        return Err(format!(
            "URL {} refusée : seuls localhost et les IP privées du réseau local sont autorisés (reçu : {}).",
            service, host
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_local_host, require_public_download_url};

    #[test]
    fn allows_loopback_and_private_lan_hosts() {
        assert!(is_allowed_local_host("localhost"));
        assert!(is_allowed_local_host("127.0.0.1"));
        assert!(is_allowed_local_host("::1"));
        assert!(is_allowed_local_host("10.1.10.1"));
        assert!(is_allowed_local_host("172.16.0.1"));
        assert!(is_allowed_local_host("172.31.255.254"));
        assert!(is_allowed_local_host("192.168.1.20"));
        assert!(is_allowed_local_host("fd00::1"));
        assert!(is_allowed_local_host("fe80::1"));
    }

    #[test]
    fn rejects_public_or_named_hosts() {
        assert!(!is_allowed_local_host("8.8.8.8"));
        assert!(!is_allowed_local_host("1.1.1.1"));
        assert!(!is_allowed_local_host("172.32.0.1"));
        assert!(!is_allowed_local_host("example.com"));
        assert!(!is_allowed_local_host("server.local"));
    }

    #[test]
    fn public_download_urls_allow_official_artifact_hosts() {
        for url in [
            "https://github.com/rhasspy/piper/releases/download/x/file.zip",
            "https://release-assets.githubusercontent.com/github-production-release-asset/file",
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/file.onnx",
            "https://us.aws.cdn.hf.co/xet-bridge-us/file",
        ] {
            assert!(require_public_download_url(url, "test").is_ok(), "{url}");
        }
    }

    #[test]
    fn public_download_urls_reject_unexpected_hosts() {
        assert!(require_public_download_url("http://github.com/file", "test").is_err());
        assert!(require_public_download_url("https://example.com/file", "test").is_err());
    }
}
