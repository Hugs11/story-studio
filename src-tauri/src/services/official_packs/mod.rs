//! Shared official identity recognition, independent of import/export and device drivers.
use sha2::{Digest, Sha256};

const EMBEDDED: &[u8] = include_bytes!("../../../resources/official-uuid-digests.v1.bin");
const DOMAIN: &[u8] = b"story-studio/official-uuid/v1:";

/// Lookup failures propagate: callers must not interpret a broken catalogue as absence.
pub(crate) trait OfficialCatalogue {
    type Error;
    fn contains_official(&self, canonical_uuid: &str) -> Result<bool, Self::Error>;
}

pub(crate) fn is_official<C: OfficialCatalogue + ?Sized>(
    uuid: &str,
    catalogue: Option<&C>,
) -> Result<bool, C::Error> {
    recognize(EMBEDDED, uuid, catalogue)
}

fn recognize<C: OfficialCatalogue + ?Sized>(
    digests: &[u8],
    uuid: &str,
    catalogue: Option<&C>,
) -> Result<bool, C::Error> {
    let Ok(uuid) = uuid::Uuid::parse_str(uuid) else {
        return Ok(false);
    };
    let canonical = uuid.hyphenated().to_string();
    let digest = fingerprint(&canonical);
    let mut low = 0;
    let mut high = digests.len() / 32;
    while low < high {
        let mid = low + (high - low) / 2;
        match digests[mid * 32..(mid + 1) * 32].cmp(&digest) {
            std::cmp::Ordering::Less => low = mid + 1,
            std::cmp::Ordering::Greater => high = mid,
            std::cmp::Ordering::Equal => return Ok(true),
        }
    }
    match catalogue {
        Some(catalogue) => catalogue.contains_official(&canonical),
        None => Ok(false),
    }
}

fn fingerprint(uuid: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(DOMAIN);
    hash.update(uuid.as_bytes());
    hash.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";
    struct Fake;
    impl OfficialCatalogue for Fake {
        type Error = &'static str;
        fn contains_official(&self, uuid: &str) -> Result<bool, Self::Error> {
            Ok(uuid == B)
        }
    }
    #[test]
    fn cross_language_vector() {
        let hex: String = fingerprint(A).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "412e99b765c7b817432e5828c1eabbdbcb81478589dfc3343cc9dfeb1e87cbca"
        );
    }
    #[test]
    fn empty_and_absent() {
        assert!(!recognize::<Fake>(&[], A, None).unwrap());
        assert!(!recognize::<Fake>(&fingerprint(A), B, None).unwrap());
        assert!(!recognize::<Fake>(&[], "invalid", Some(&Fake)).unwrap());
    }
    #[test]
    fn found_and_normalized() {
        let mut records = [fingerprint(A), fingerprint(B)];
        records.sort();
        let bytes = records.concat();
        for input in [
            A.to_uppercase(),
            A.replace('-', ""),
            format!("{{{A}}}"),
            format!("urn:uuid:{A}"),
        ] {
            assert!(recognize::<Fake>(&bytes, &input, None).unwrap());
        }
        assert!(recognize::<Fake>(&bytes, B, None).unwrap());
    }
    #[test]
    fn catalogue_fallback() {
        assert!(recognize(&[], &B.to_uppercase(), Some(&Fake)).unwrap());
        assert!(!recognize(&[], A, Some(&Fake)).unwrap());
    }
    #[test]
    fn catalogue_errors_propagate_and_embedded_match_short_circuits() {
        struct Broken;
        impl OfficialCatalogue for Broken {
            type Error = &'static str;
            fn contains_official(&self, _: &str) -> Result<bool, Self::Error> {
                Err("unavailable")
            }
        }
        assert_eq!(recognize(&[], A, Some(&Broken)), Err("unavailable"));
        assert_eq!(recognize(&fingerprint(A), A, Some(&Broken)), Ok(true));
    }
    #[test]
    fn embedded_format() {
        assert_eq!(EMBEDDED.len() % 32, 0);
        assert!(EMBEDDED
            .chunks_exact(32)
            .zip(EMBEDDED.chunks_exact(32).skip(1))
            .all(|(a, b)| a < b));
    }
}
