//! D23 last resort: bounded first-screen image for a recognized creation only.
use super::*;
use std::io::Read;
fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    safe(path, false)?;
    if fs::metadata(path)?.len() > limit {
        return Err(Error::IncompleteStory);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(Error::IncompleteStory);
    }
    Ok(bytes)
}
impl Device {
    /// A name-only sidecar does not replace the story's first-screen fallback.
    /// Callers keep orphans on their strictly sidecar-only resolution path.
    pub(crate) fn read_creation_cover<C: OfficialCatalogue>(
        &self,
        id: Uuid,
        card: &cards::Card,
        catalogue: &C,
    ) -> Result<Vec<u8>> {
        match &card.cover_png {
            Some(bytes) => Ok(bytes.clone()),
            None => self.read_first_screen(id, catalogue),
        }
    }

    /// Availability checks do not clone a cached PNG or encode a discarded fallback.
    pub(crate) fn check_creation_cover<C: OfficialCatalogue>(
        &self,
        id: Uuid,
        card: &cards::Card,
        catalogue: &C,
    ) -> Result<()> {
        if card.cover_png.is_some() {
            Ok(())
        } else {
            self.check_first_screen(id, catalogue)
        }
    }
    pub(crate) fn check_first_screen<C: OfficialCatalogue>(
        &self,
        id: Uuid,
        catalogue: &C,
    ) -> Result<()> {
        cards::check_cover_image(&self.first_screen_image(id, catalogue)?)
    }

    #[cfg(test)]
    pub(crate) fn first_screen<C: OfficialCatalogue>(
        &self,
        id: Uuid,
        catalogue: &C,
    ) -> Option<Vec<u8>> {
        self.read_first_screen(id, catalogue).ok()
    }
    pub(crate) fn read_first_screen<C: OfficialCatalogue>(
        &self,
        id: Uuid,
        catalogue: &C,
    ) -> Result<Vec<u8>> {
        cards::reduced_cover(&self.first_screen_image(id, catalogue)?)
    }
    fn first_screen_image<C: OfficialCatalogue>(&self, id: Uuid, catalogue: &C) -> Result<Vec<u8>> {
        if recognizes_official(&id.to_string(), Some(catalogue)) != (false, false) {
            return Err(Error::OfficialStory);
        }
        let story = state::story_path(&self.root, id);
        safe(&story, true)?;
        let ni = bounded(&story.join("ni"), 512 + 44 * 100_000)?;
        let index = i32::from_le_bytes(
            ni.get(512..516)
                .ok_or(Error::IncompleteStory)?
                .try_into()
                .map_err(|_| Error::IncompleteStory)?,
        );
        if index < 0 {
            return Err(Error::IncompleteStory);
        }
        let cipher = crate::services::storyteller::cipher::DeviceCipher::for_story(
            &self.root,
            &bounded(&story.join("bt"), 32)?,
        )?;
        let ri = cipher
            .decrypt(&bounded(&story.join("ri"), 12 * 100_000 + 16)?, None)
            .map_err(|_| Error::UnreadableStory)?;
        let start = (index as usize)
            .checked_mul(12)
            .ok_or(Error::IncompleteStory)?;
        let record = ri.get(start..start + 12).ok_or(Error::IncompleteStory)?;
        if &record[..4] != b"000\\" {
            return Err(Error::UnreadableStory);
        }
        let name = std::str::from_utf8(&record[4..]).map_err(|_| Error::UnreadableStory)?;
        if !valid_folder(name) {
            return Err(Error::UnreadableStory);
        }
        safe(&story.join("rf"), true)?;
        safe(&story.join("rf/000"), true)?;
        let image = cipher
            .decrypt(
                &bounded(&story.join("rf/000").join(name), 10 * 1024 * 1024)?,
                None,
            )
            .map_err(|_| Error::UnreadableStory)?;
        if !image.starts_with(b"BM") {
            return Err(Error::UnreadableStory);
        }
        Ok(image)
    }
}
