//! Reference replacement reads cached candidates, never a source file.
use crate::services::catalogue::{data::card, store::error, Result};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, Transaction};

pub fn replace_values(tx: &Transaction<'_>, card: &str, exemplar: &str) -> Result<()> {
    write_values(tx, card, exemplar, false)
}

/// A rescan retains the last accepted value only for invalid observations.
pub fn refresh_values(tx: &Transaction<'_>, card: &str, exemplar: &str) -> Result<()> {
    write_values(tx, card, exemplar, true)
}
fn write_values(tx: &Transaction<'_>, card: &str, exemplar: &str, refresh: bool) -> Result<()> {
    let fields = card::cached_candidates(tx, exemplar)
        .map_err(error)?
        .ok_or_else(|| UserMessage::new(codes::CATALOG_REFERENCE_NOT_READY))?;
    let provenance = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO provenance(id,kind,exemplar_id,retrieved_at) VALUES (?1,'file',?2,unixepoch())",params![provenance,exemplar]).map_err(error)?;
    // Replace the entire set, including absent fields. Corrections are separate.
    let retained = if refresh {
        fields
            .iter()
            .filter(|(_, v)| v["validity"] == "invalid")
            .map(|(k, _)| k.clone())
            .collect::<std::collections::BTreeSet<_>>()
    } else {
        Default::default()
    };
    let existing = tx
        .prepare("SELECT v.field,v.language FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind!='lunii'")
        .map_err(error)?
        .query_map([card], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for (field, language) in existing {
        if !retained.contains(&(field.clone(), language.clone())) {
            tx.execute(
                "DELETE FROM reference_value WHERE fiche_id=?1 AND field=?2 AND language=?3",
                params![card, field, language],
            )
            .map_err(error)?;
        }
    }
    for ((field, language), candidate) in fields {
        if candidate["validity"] == "valid" && !candidate["value"].is_null() && field != "ageMax" {
            tx.execute(
                "INSERT INTO reference_value VALUES (?1,?2,?3,?4,?5,NULL)",
                params![
                    card,
                    field,
                    language,
                    candidate["value"].to_string(),
                    provenance
                ],
            )
            .map_err(error)?;
        }
    }

    Ok(())
}
pub fn select(tx: &Transaction<'_>, card: &str, exemplar: &str) -> Result<()> {
    let available:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.id=?1 AND e.fiche_id=?2 AND e.retired=0 AND o.state='available' AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id WHERE v.exemplar_id=e.id AND s.status='active'))",params![exemplar,card],|r|r.get(0)).map_err(error)?;
    if !available {
        return Err(UserMessage::new(codes::CATALOG_REFERENCE_NOT_READY));
    }
    replace_values(tx, card, exemplar)?;
    tx.execute("DELETE FROM import_reference WHERE fiche_id=?1", [card])
        .map_err(error)?;
    tx.execute("INSERT INTO reference_source VALUES (?1,?2,unixepoch(),1) ON CONFLICT(fiche_id) DO UPDATE SET exemplar_id=excluded.exemplar_id,selected_at=excluded.selected_at,revision=reference_source.revision+1",params![card,exemplar]).map_err(error)?;
    Ok(())
}
