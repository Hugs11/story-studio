use std::net::{IpAddr, Ipv6Addr};

use reqwest::Url;

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
    use super::is_allowed_local_host;

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
}
