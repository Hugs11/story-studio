//! Empreintes de contenu de la chaîne de traçabilité.
//!
//! SHA-256 pour l'instantané, la clé de tâche et la sortie : ce sont les
//! égalités sur lesquelles la garantie 1 repose, et elle déclare supposer
//! l'absence de collision. Le nom d'archive, lui, reste en SHA-1 — c'est la
//! forme que le writer Libre produit déjà et que les deux passerelles
//! consomment, et la contrainte de Lunii.QT porte sur ses huit derniers
//! caractères, pas sur sa résistance.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

const CHUNK: usize = 256 * 1024;

pub(crate) fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Empreinte d'un fichier, lue par blocs : un média peut peser plus que la
/// mémoire qu'on veut lui consacrer.
pub(crate) fn sha256_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut scratch = vec![0_u8; CHUNK];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut scratch)?;
        if read == 0 {
            break;
        }
        hasher.update(&scratch[..read]);
        total += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}
