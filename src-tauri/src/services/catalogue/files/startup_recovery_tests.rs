use super::*;

/// A journal left by the removed copy/convert operation is never resumed:
/// startup closes it, reports nothing and stops reserving its cards.
#[test]
fn startup_closes_legacy_transfer_journals_without_resuming_or_blocking() {
    let f = Fixture::new(false);
    let card = f.card["ficheId"].as_str().unwrap().to_owned();
    let pending =
        json!({"stage":"publishing","target":{"ficheId":card},"progress":{"transfer":{}}});
    let finished = json!({"stage":"complete","target":{"ficheId":card}});
    f.store
        .write(|tx| {
            for (id, evidence) in [
                ("legacy-pending", pending.to_string()),
                ("legacy-complete", finished.to_string()),
                ("legacy-garbage", "not json".to_string()),
            ] {
                tx.execute(
                    "INSERT INTO file_journal(id,evidence_json) VALUES (?1,?2)",
                    rusqlite::params![id, evidence],
                )
                .map_err(error)?;
            }
            tx.execute(
                "INSERT INTO file_operation VALUES ('inherited','inherited','{}','running','{}')",
                [],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let blocked = f
        .store
        .write(|tx| require_associations_available(tx, std::slice::from_ref(&card)));
    assert_eq!(
        blocked.unwrap_err().code,
        codes::CATALOG_FILE_RECOVERY_REQUIRED
    );
    let warnings = f.store.recover_file_operations().unwrap();
    assert!(warnings.is_empty());
    let (pending_stage, complete_stage, garbage, operation): (String, String, String, String) = f
        .store
        .read(|c| {
            let stage = |id: &str| {
                c.query_row(
                    "SELECT evidence_json FROM file_journal WHERE id=?1",
                    [id],
                    |r| r.get::<_, String>(0),
                )
            };
            Ok((
                serde_json::from_str::<Value>(&stage("legacy-pending")?).unwrap()["stage"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                serde_json::from_str::<Value>(&stage("legacy-complete")?).unwrap()["stage"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                stage("legacy-garbage")?,
                c.query_row(
                    "SELECT state FROM file_operation WHERE id='inherited'",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(
        (
            pending_stage.as_str(),
            complete_stage.as_str(),
            garbage.as_str(),
            operation.as_str()
        ),
        ("failed", "complete", "not json", "interrupted")
    );
    f.store
        .write(|tx| require_associations_available(tx, std::slice::from_ref(&card)))
        .unwrap();
}
