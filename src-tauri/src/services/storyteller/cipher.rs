//! V3 creation transport, independently implemented from the L8c recipe and
//! specification-conteuse. AES recipe remains subject to the E4 hardware check.
//! No playlist writes, device discovery or official-story decryption.
use super::{failure, PlainStory, Result, Scratch};
use crate::{
    services::storyteller_device::Metadata,
    support::user_message::{codes, UserMessage},
};
use aes::{
    cipher::{BlockDecrypt, BlockEncrypt, KeyInit},
    Aes128,
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        Err(UserMessage::new(codes::STORYTELLER_SEND_CANCELLED))
    } else {
        Ok(())
    }
}

/// Local transport result, ready for the driver's copy and playlist operation.
#[derive(Debug)]
pub(crate) struct EncryptedStory {
    pub(crate) path: PathBuf,
    pub(crate) total_bytes: u64,
    pub(crate) uuid: uuid::Uuid,
    target: Metadata,
    material_fingerprint: [u8; 32],
}

impl EncryptedStory {
    /// Revalidate the target before copying, without exposing key material.
    pub(crate) fn matches_device(&self, root: &Path) -> bool {
        Metadata::read_cipher_material(root).is_ok_and(|(metadata, _, _, bt, fingerprint)| {
            metadata == self.target
                && fingerprint == self.material_fingerprint
                && fs::read(self.path.join("bt")).is_ok_and(|v| v == bt)
        })
    }
}

/// Intentionally no Debug/serialization: contains device-specific secrets.
pub(crate) struct DeviceCipher {
    metadata: Metadata,
    key: [u8; 16],
    iv: [u8; 16],
    bt: [u8; 32],
    material_fingerprint: [u8; 32],
}
// Keep existing v6 test vectors and manual manufacturing recipes unchanged.
#[cfg(test)]
pub(crate) type V6Cipher = DeviceCipher;
impl DeviceCipher {
    /// Explicit local .md input, never discovers or mounts a device.
    pub(crate) fn from_metadata(root: &Path) -> Result<Self> {
        Self::read_metadata(root).map_err(|e| {
            UserMessage::new(if e == crate::services::storyteller_device::Error::Io {
                codes::STORYTELLER_CIPHER_METADATA_IO
            } else {
                codes::STORYTELLER_CIPHER_METADATA_REFUSED
            })
        })
    }
    fn read_metadata(root: &Path) -> crate::services::storyteller_device::Result<Self> {
        let (metadata, key, iv, bt, material_fingerprint) = Metadata::read_cipher_material(root)?;
        Ok(Self {
            metadata,
            key,
            iv,
            bt,
            material_fingerprint,
        })
    }
    /// E15: v7 stories identify their recipe by bt; older stories keep v6 keys.
    /// This selects a recipe, not proof of valid plaintext: callers must validate
    /// decrypted indexes and the expected BMP/MP3 header before exposing media.
    pub(crate) fn for_story(
        root: &Path,
        story_bt: &[u8],
    ) -> crate::services::storyteller_device::Result<Self> {
        if story_bt.len() != 32 {
            return Err(crate::services::storyteller_device::Error::IncompleteStory);
        }
        let mut cipher = Self::read_metadata(root)?;
        if cipher.metadata.version == 7 && story_bt != cipher.bt {
            let serial = cipher
                .metadata
                .serial()
                .ok_or(crate::services::storyteller_device::Error::InvalidMetadata)?;
            (cipher.key, cipher.iv) = Metadata::legacy_material(serial.as_bytes());
            for bytes in [&mut cipher.key, &mut cipher.iv] {
                for word in bytes.chunks_exact_mut(4) {
                    word.reverse();
                }
            }
        }
        Ok(cipher)
    }
    /// Try the story-selected recipe first, then the other available v7/v6
    /// recipe. A recipe is accepted after structural validation of the indexes
    /// only; repatriated media are preserved as-is. Accepted risk: if indexes and
    /// media used different recipes, unreadable media may be published and will
    /// be reported when sending the story back to a device.
    pub(crate) fn candidates(
        root: &Path,
        bt: &[u8],
    ) -> crate::services::storyteller_device::Result<Vec<Self>> {
        let first = Self::for_story(root, bt)?;
        let mut result = vec![first];
        let mut other = Self::read_metadata(root)?;
        if other.metadata.version == 7 {
            if bt == other.bt {
                let serial = other
                    .metadata
                    .serial()
                    .ok_or(crate::services::storyteller_device::Error::InvalidMetadata)?;
                (other.key, other.iv) = Metadata::legacy_material(serial.as_bytes());
                for bytes in [&mut other.key, &mut other.iv] {
                    for word in bytes.chunks_exact_mut(4) {
                        word.reverse();
                    }
                }
            }
            result.push(other);
        }
        Ok(result)
    }
    fn cbc(&self, bytes: &mut [u8], decrypt: bool) {
        let aes = Aes128::new((&self.key).into());
        let mut previous = self.iv;
        for block in bytes.chunks_exact_mut(16) {
            if decrypt {
                let ciphertext: [u8; 16] = block.try_into().expect("AES block");
                aes.decrypt_block(block.into());
                for (byte, mask) in block.iter_mut().zip(previous) {
                    *byte ^= mask;
                }
                previous = ciphertext;
            } else {
                for (byte, mask) in block.iter_mut().zip(previous) {
                    *byte ^= mask;
                }
                aes.encrypt_block(block.into());
                previous.copy_from_slice(block);
            }
        }
    }
    fn encrypt_prefix(&self, bytes: &mut Vec<u8>) {
        let prefix = bytes.len().min(512);
        bytes.resize(prefix.div_ceil(16) * 16, 0);
        self.cbc(bytes, false);
    }
    /// Inverse for a non-official creation (E14). None preserves zero padding.
    /// For short media, trailing zeroes are ambiguous: never strip them by value.
    /// Exact recovery requires an external original length or a format-specific
    /// length (e.g. BMP bfSize); MP3 has no universal trustworthy total length.
    /// ri/si lengths are ni image/sound count * 12; li length is 4 * the maximum
    /// (start + count) over both transitions of every ni node (not node count).
    /// Already padded write_plain_story inputs retain their pre-existing padding.
    pub(crate) fn decrypt(&self, bytes: &[u8], original_len: Option<usize>) -> Result<Vec<u8>> {
        let prefix = bytes.len().min(512);
        if !prefix.is_multiple_of(16) {
            return Err(failure("unaligned encrypted prefix"));
        }
        let mut plain = bytes.to_vec();
        self.cbc(&mut plain[..prefix], true);
        if let Some(len) = original_len {
            let expected = if len < 512 {
                len.div_ceil(16) * 16
            } else {
                len
            };
            if bytes.len() != expected || plain[len..].iter().any(|b| *b != 0) {
                return Err(failure("invalid original length or padding"));
            }
            plain.truncate(len);
        }
        Ok(plain)
    }
    /// Separate output parent, scratch + exclusive rename. Source remains clear.
    /// Accepts the capability returned by write_plain_story; no .pi access.
    pub(crate) fn encrypt_story(
        &self,
        plain: &PlainStory,
        output: &Path,
        cancel: &AtomicBool,
    ) -> Result<EncryptedStory> {
        check(cancel)?;
        if !output.is_absolute() {
            return Err(failure("output must be absolute"));
        }
        let output = output.canonicalize().map_err(failure)?;
        let destination = output.join(super::story_folder(plain.uuid));
        if destination.symlink_metadata().is_ok() {
            return Err(failure("story already exists"));
        }
        let scratch = Scratch::new(&output)?;
        let story = scratch.0.join("story");
        fs::create_dir(&story).map_err(failure)?;
        let mut total = 0;
        for name in ["ni", "li", "ri", "si", "nm"] {
            let source = plain.path.join(name);
            if name == "nm" && !source.try_exists().map_err(failure)? {
                continue;
            }
            total += self.copy_file(
                &source,
                &story.join(name),
                name != "ni" && name != "nm",
                cancel,
            )?;
        }
        for folder in ["rf", "sf"] {
            let source = plain.path.join(folder).join("000");
            for dir in [&plain.path, &plain.path.join(folder), &source] {
                if !fs::symlink_metadata(dir)
                    .map_err(failure)?
                    .file_type()
                    .is_dir()
                {
                    return Err(failure("invalid media directory"));
                }
            }
            let target = story.join(folder).join("000");
            fs::create_dir_all(&target).map_err(failure)?;
            for entry in fs::read_dir(source).map_err(failure)? {
                let entry = entry.map_err(failure)?;
                let name = entry.file_name();
                if !name.to_str().is_some_and(|s| {
                    s.len() == 8
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
                }) {
                    return Err(failure("invalid media name"));
                }
                total += self.copy_file(&entry.path(), &target.join(name), true, cancel)?;
            }
        }
        let mut bt = fs::File::create_new(story.join("bt")).map_err(failure)?;
        bt.write_all(&self.bt).map_err(failure)?;
        bt.sync_all().map_err(failure)?;
        // Windows cannot rename a directory while a child handle is open.
        // Finish and close the staged file before publishing its directory.
        drop(bt);
        check(cancel)?;
        crate::services::catalogue::files::publish::no_replace(&story, &destination)?;
        Ok(EncryptedStory {
            path: destination,
            uuid: plain.uuid,
            total_bytes: total + 32,
            target: self.metadata.clone(),
            material_fingerprint: self.material_fingerprint,
        })
    }
    fn copy_file(
        &self,
        source: &Path,
        destination: &Path,
        encrypted: bool,
        cancel: &AtomicBool,
    ) -> Result<u64> {
        check(cancel)?;
        if !fs::symlink_metadata(source)
            .map_err(failure)?
            .file_type()
            .is_file()
        {
            return Err(failure("invalid story file"));
        }
        let mut input = fs::File::open(source).map_err(failure)?;
        let mut output = fs::File::create_new(destination).map_err(failure)?;
        let mut prefix = Vec::new();
        Read::by_ref(&mut input)
            .take(512)
            .read_to_end(&mut prefix)
            .map_err(failure)?;
        if encrypted {
            self.encrypt_prefix(&mut prefix);
        }
        output.write_all(&prefix).map_err(failure)?;
        let mut total = prefix.len() as u64;
        let mut buffer = [0; 64 * 1024];
        loop {
            check(cancel)?;
            let count = input.read(&mut buffer).map_err(failure)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(failure)?;
            total += count as u64;
            #[cfg(test)]
            tests::after_copy_chunk(cancel);
        }
        output.sync_all().map_err(failure)?;
        Ok(total)
    }
}
#[cfg(test)]
mod lab_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod v7_tests;
