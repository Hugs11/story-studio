//! All personal rows, identity mappings, revision and receipt share one transaction.
use super::{
    import::{invalid, ApplyImport, Prepared},
    matching::{rows, stable, text},
    staging, Result,
};
use crate::services::catalogue::{
    data::{
        card,
        mutate::{metadata, names},
    },
    scan,
    store::{error, Store},
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::atomic::Ordering};
fn remember(
    tx: &Transaction<'_>,
    origin: &str,
    kind: &str,
    id: &str,
    target: &str,
    row: &Value,
) -> Result<()> {
    tx.execute("INSERT INTO import_identity VALUES (?1,?2,?3,?4,?5) ON CONFLICT(origin_catalogue_id,entity_type,origin_entity_id) DO UPDATE SET local_entity_id=excluded.local_entity_id,last_imported_json=excluded.last_imported_json",params![origin,kind,id,target,row.to_string()]).map_err(error)?;
    Ok(())
}
pub(super) fn apply(
    store: &Store,
    prepared: &Prepared,
    args: &ApplyImport,
    op: &scan::Operation,
) -> Result<Value> {
    let doc = &prepared.staged.document;
    let plan = &prepared.plan;
    let origin = text(doc, "originCatalogueId")?;
    let mut source_rows = BTreeMap::new();
    for table in ["corrections", "referenceValues"] {
        for row in rows(doc, table) {
            source_rows.insert(
                (
                    table,
                    plan.cards[text(row, "ficheId")?].as_str(),
                    text(row, "field")?,
                    row["language"].as_str().unwrap(),
                ),
                row,
            );
        }
    }
    let mut label_actions = BTreeMap::new();
    for action in &plan.actions {
        super::export::check(&op.cancel)?;
        #[cfg(test)]
        super::import_tests::record_review_work(0);
        if action.kind == "tag" {
            let label = action.incoming.as_str().ok_or_else(invalid)?;
            label_actions
                .entry((action.kind.as_str(), action.target.as_str(), label))
                .or_insert(action);
        }
    }
    let forget_targets = plan
        .forget_intents
        .iter()
        .filter(|intent| {
            intent.conflict_id.as_ref().is_none_or(|id| {
                args.choices
                    .get(id)
                    .is_some_and(|choice| choice == "incoming")
            })
        })
        .map(|intent| intent.target.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let official = super::matching::Index::new(doc);
    let receipt_key = stable(&[
        &prepared.staged.digest,
        &serde_json::to_string(&args.choices).map_err(error)?,
        &serde_json::to_string(&args.associations).map_err(error)?,
    ]);
    let (result,_boundary)=store.write_guarded(|tx| {
        super::export::check(&op.cancel)?;
        let revision:i64=tx.query_row("SELECT revision FROM catalogue",[],|r|r.get(0)).map_err(error)?;
        if revision!=args.expected_catalogue_revision {return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));}
        let replay:Option<String>=tx.query_row("SELECT result_json FROM import_receipt WHERE archive_digest=?1",[&receipt_key],|r|r.get(0)).optional().map_err(error)?;
        if let Some(replay)=replay {
            let result:Value=serde_json::from_str(&replay).map_err(error)?;
            if result["catalogueRevision"]==revision {return Ok(result);}
        }

        crate::services::catalogue::files::require_associations_available(tx,&plan.cards.values().cloned().collect::<Vec<_>>())?;
        // Only an explicit individual choice reaches a covered or grouped fiche:
        // refuse it atomically, naming the fiche, as local forgetting would.
        if !forget_targets.is_empty() {
            let covered=crate::services::catalogue::data::mutate::forget::covered(tx).map_err(error)?;
            for target in &forget_targets {
                if !super::matching::forgettable(&covered,target,&super::relations::canonical(tx,target)?) {
                    return Err(UserMessage::new(codes::CATALOG_IMPORT_FORGET_REFUSED).param("title",plan.label(target)));
                }
            }
        }
        // Files are durable before any row can refer to them. GC holds this lock too.
        staging::publish(store,tx,&prepared.staged,&op.cancel)?;
        let operation=uuid::Uuid::new_v4().to_string();
        let mut before=BTreeMap::new();
        for old in plan.pending.keys(){before.insert(old.clone(),card::snapshot(tx,old).map_err(error)?);}
        for row in rows(doc,"cards") {
            super::export::check(&op.cancel)?;
            let id=text(row,"id")?;let target=&plan.cards[id];
            before.insert(target.clone(),card::snapshot(tx,target).map_err(error)?);
            tx.execute("INSERT OR IGNORE INTO fiche VALUES (?1,?2,0,0)",params![target,row["createdAt"].as_i64().unwrap()]).map_err(error)?;
            if row["luniiFilled"]==true {tx.execute("INSERT OR IGNORE INTO lunii_filled(fiche_id) VALUES (?1)",[target]).map_err(error)?;}
            remember(tx,origin,"card",id,target,row)?;
        }
        let mixed = super::matching::mixed_uuid_cards(doc);
        for identity in rows(doc,"identities") {
            if mixed.contains(text(identity,"ficheId")?) {continue;}
            tx.execute("INSERT INTO saved_pack_identity VALUES (?1,?2,?3) ON CONFLICT(pack_uuid) DO UPDATE SET provenance_json=excluded.provenance_json WHERE saved_pack_identity.fiche_id=excluded.fiche_id",params![text(identity,"packUuid")?,plan.cards[text(identity,"ficheId")?],identity["provenance"].to_string()]).map_err(error)?;
        }
        let mut provenances=BTreeMap::new();
        for row in rows(doc,"provenances") {
            let id=text(row,"id")?; let target=format!("import-{}",stable(&[origin,"provenance",id]));
            // Imported locators are evidence only; never attach to a local exemplar.
            tx.execute("INSERT OR IGNORE INTO provenance(id,kind,locator_json,url,language,retrieved_at,raw_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![target,text(row,"kind")?,if row["locator"].is_null(){None}else{Some(row["locator"].to_string())},row["url"].as_str(),row["language"].as_str(),row["retrievedAt"].as_i64(),row.to_string()]).map_err(error)?;
            provenances.insert(id.to_string(),target);
        }
        tx.execute("INSERT INTO operation VALUES (?1,'importCatalogue','running',?2,?3,unixepoch(),NULL)",params![operation,args.request_id,revision]).map_err(error)?;
        for action in &plan.actions {
            if matches!(action.kind.as_str(),"group"|"convergence") && (action.local.is_none() || args.choices.get(&action.id).is_some_and(|choice|choice=="incoming")) {
                super::relations::apply(tx,&action.kind,&action.incoming,&operation)?;
            }
        }
        // Vacate only destinations whose occupants are moving too. A stationary
        // collision reuses the named entity and preserves all local memberships.
        let kind = "tag";
        let changes=plan.actions.iter().filter(|a| a.kind==kind && (a.local.is_none() || args.choices.get(&a.id).is_some_and(|v|v=="incoming"))).collect::<Vec<_>>();
        let mut moving=changes.iter().map(|a|a.target.clone()).collect::<std::collections::BTreeSet<_>>();
        let mut dependents=BTreeMap::<String,Vec<String>>::new();
        let mut blocked=std::collections::VecDeque::new();
        for a in &changes {
            super::export::check(&op.cancel)?;
            #[cfg(test)] super::import_tests::record_review_work(2);
            let (_,key)=names::label(a.incoming.as_str().ok_or_else(invalid)?)?;
            let occupant:Option<String>=tx.query_row("SELECT id FROM tag WHERE normalized_label=?1",[key],|r|r.get(0)).optional().map_err(error)?;
            if let Some(id)=occupant.filter(|id|id!=&a.target) {
                if moving.contains(&id) {dependents.entry(id).or_default().push(a.target.clone());}
                else {blocked.push_back(a.target.clone());}
            }
        }
        // Each blocked occupant invalidates its predecessors once. Cycles with
        // no stationary occupant remain movable, including label permutations.
        while let Some(id)=blocked.pop_front() {
            super::export::check(&op.cancel)?;
            #[cfg(test)] super::import_tests::record_review_work(2);
            if !moving.remove(&id) {continue;}
            if let Some(previous)=dependents.remove(&id) {
                for target in previous {
                    super::export::check(&op.cancel)?;
                    #[cfg(test)] super::import_tests::record_review_work(2);
                    blocked.push_back(target);
                }
            }
        }
        for id in &moving {
            super::export::check(&op.cancel)?;
            tx.execute("UPDATE tag SET normalized_label=?2 WHERE id=?1",params![id,format!("temporary-{}",uuid::Uuid::new_v4())]).map_err(error)?;
        }
        for a in changes.iter().filter(|a|moving.contains(&a.target)) {
            super::export::check(&op.cancel)?;
            let (label,key)=names::label(a.incoming.as_str().ok_or_else(invalid)?)?;
            tx.execute("INSERT INTO tag VALUES (?1,?2,?3,1) ON CONFLICT(id) DO UPDATE SET label=excluded.label,normalized_label=excluded.normalized_label,revision=revision+1",params![a.target,label,key]).map_err(error)?;
        }

        let mut imported=0;let mut kept=0;
        for action in &plan.actions {
            super::export::check(&op.cancel)?;
            if action.local.is_some() && args.choices.get(&action.id).map(String::as_str).unwrap_or("local")=="local" {kept+=1;continue;}
            let resolved=super::relations::canonical(tx,&action.target)?;
            let target=&resolved;let value=&action.incoming;
            match action.kind.as_str() {
                "pendingForgotten"|"forgotten"=>{},
                "group"|"convergence"=>{},
                "ageRange"|"pendingAgeRange"=>{
                    for row in value["writes"].as_array().ok_or_else(invalid)? {
                        let mut row=row.clone();
                        if action.kind=="ageRange" {row["provenanceId"]=json!(provenances[text(&row,"provenanceId")?]);}
                        super::reconcile::apply_correction(tx,target,&row)?;
                    }
                },
                "pendingCorrections"=>{super::reconcile::apply_correction(tx,target,value)?;},
                "pendingFavorite"=>{tx.execute("UPDATE fiche SET favorite=?2 WHERE id=?1",params![target,value.as_i64().ok_or_else(invalid)?]).map_err(error)?;},
                "pendingLuniiValue"=>{
                    tx.execute("INSERT INTO reference_value VALUES (?1,?2,?3,?4,?5,?6)",params![target,text(value,"field")?,text(value,"language")?,value["value"].to_string(),text(value,"provenanceId")?,value["imageSha256"].as_str()]).map_err(error)?;
                },
                "pendingReferenceBundle"|"referenceBundle"=>{
                    let local_origin:String=tx.query_row("SELECT id FROM catalogue",[],|r|r.get(0)).map_err(error)?;
                    let source_exemplar=value["source"]["exemplarId"].as_str().or_else(||value["source"].as_str());
                    let available = if origin == local_origin { if let Some(ex)=source_exemplar { tx.query_row("SELECT EXISTS(SELECT 1 FROM exemplar WHERE id=?1 AND fiche_id=?2)",params![ex,target],|r|r.get::<_,bool>(0)).map_err(error)? } else {false} } else {false};
                    if available {
                        tx.execute("INSERT INTO reference_source VALUES (?1,?2,unixepoch(),1) ON CONFLICT(fiche_id) DO UPDATE SET exemplar_id=excluded.exemplar_id,selected_at=excluded.selected_at,revision=reference_source.revision+1",params![target,source_exemplar]).map_err(error)?;
                        tx.execute("DELETE FROM import_reference WHERE fiche_id=?1",[target]).map_err(error)?;
                    } else {
                        tx.execute("DELETE FROM reference_source WHERE fiche_id=?1",[target]).map_err(error)?;
                        tx.execute("INSERT OR REPLACE INTO import_reference VALUES (?1,?2)",params![target,value["source"].to_string()]).map_err(error)?;
                    }
                    tx.execute("DELETE FROM reference_value WHERE fiche_id=?1 AND NOT EXISTS (SELECT 1 FROM provenance p WHERE p.id=reference_value.provenance_id AND p.kind='lunii')",[target]).map_err(error)?;
                    for row in value["values"].as_array().ok_or_else(invalid)? {
                        let provenance=if action.kind=="pendingReferenceBundle"{text(row,"provenanceId")?}else{&provenances[text(row,"provenanceId")?]};
                        tx.execute("INSERT INTO reference_value VALUES (?1,?2,?3,?4,?5,?6)",params![target,text(row,"field")?,row["language"].as_str().unwrap(),row["value"].to_string(),provenance,row["imageSha256"].as_str()]).map_err(error)?;
                    }
                },
                "favorite"=>{tx.execute("UPDATE fiche SET favorite=?2 WHERE id=?1",params![target,value.as_i64().ok_or_else(invalid)?]).map_err(error)?;},
                "tag"=>{
                    // Resolved together before applying data, including name permutations.
                },
                "corrections"|"referenceValues"=>{
                    let table=if action.kind=="corrections"{"correction"}else{"reference_value"};
                    let source=source_rows.get(&(action.kind.as_str(),action.target.as_str(),text(value,"field")?,value["language"].as_str().unwrap())).ok_or_else(invalid)?;
                    let provenance=&provenances[text(source,"provenanceId")?];
                    if table=="correction" {
                        tx.execute("INSERT INTO correction VALUES (?1,?2,?3,?4,?5,?6,?7,1) ON CONFLICT(fiche_id,field,language) DO UPDATE SET state=excluded.state,value_json=excluded.value_json,provenance_id=excluded.provenance_id,image_sha256=excluded.image_sha256,revision=revision+1",params![target,text(value,"field")?,value["language"].as_str().unwrap(),text(value,"state")?,if value["value"].is_null(){None}else{Some(value["value"].to_string())},provenance,value["imageSha256"].as_str()]).map_err(error)?;
                    } else {
                        tx.execute("INSERT INTO reference_value VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(fiche_id,field,language) DO NOTHING",params![target,text(value,"field")?,value["language"].as_str().unwrap(),value["value"].to_string(),provenance,value["imageSha256"].as_str()]).map_err(error)?;
                    }
                },
                _=>return Err(invalid()),
            }
            imported+=1;
        }
        let mut labels=plan.labels.clone();
        let (table, kind) = ("tags", "tag");
        for row in rows(doc,table) {
            let id=text(row,"id")?;
            let key=(kind.into(),id.into());
            let target=&plan.labels[&key];
            super::export::check(&op.cancel)?;
            #[cfg(test)] super::import_tests::record_review_work(0);
            let action=label_actions.get(&(kind,target.as_str(),row["label"].as_str().ok_or_else(invalid)?)).copied();
            let desired=action.and_then(|a|a.local.as_ref().filter(|_|args.choices.get(&a.id).map(String::as_str).unwrap_or("local")=="local")).unwrap_or(&row["label"]);
            let (label,normalized)=names::label(desired.as_str().ok_or_else(invalid)?)?;
            let existing:Option<String>=tx.query_row("SELECT id FROM tag WHERE normalized_label=?1",[&normalized],|r|r.get(0)).optional().map_err(error)?;
            let distinct=existing.unwrap_or_else(||format!("import-{}",stable(&[origin,kind,id,"distinct"])));
            tx.execute("INSERT OR IGNORE INTO tag VALUES (?1,?2,?3,1)",params![distinct,label,normalized]).map_err(error)?;
            labels.insert(key.clone(),distinct);
            remember(tx,origin,kind,id,&labels[&key],row)?;
        }

        let (table, kind) = ("tagMembers", "tag");
        for row in rows(doc,table) {
            let label=&labels[&(kind.into(),text(row,"tagId")?.into())];
            let target=super::relations::canonical(tx,&plan.cards[text(row,"ficheId")?])?;
            imported+=tx.execute("INSERT OR IGNORE INTO tag_member (tag_id,fiche_id) VALUES (?1,?2)",params![label,target]).map_err(error)?;
            if row["provenance"].is_object() {
                tx.execute("INSERT OR IGNORE INTO enrichment_tag_origin VALUES (?1,?2,?3)",params![label,target,row["provenance"].to_string()]).map_err(error)?;
            }
        }

        // Purge the waiting fiche's own history before reconciliation removes
        // its identity, so it cannot survive under an obsolete identifier.
        for (old,target) in &plan.pending {
            if forget_targets.contains(target.as_str()) {
                // Keep the structural row only until reconciliation inside this
                // transaction; the final target purge below erases both identities.
                crate::services::catalogue::data::mutate::forget::purge_personal(tx,std::slice::from_ref(old))?;
                before.remove(old);
            }
        }
        super::reconcile::finish(tx,plan)?;
        // Attach only to final references, after waiting transfers and grouping.
        for row in rows(doc,"referenceValues") {
            if row["field"]=="cover" && row["imageSha256"].is_string()
                && crate::services::catalogue::lunii_db::valid_cover(&row["value"])
                && official.is_official(row) {
                let target=super::relations::canonical(tx,&plan.cards[text(row,"ficheId")?])?;
                crate::services::catalogue::lunii_db::restore_covers(tx,&[target],&[(row["value"].clone(),text(row,"imageSha256")?.to_owned())])?;
            }
        }

        // Retain unresolved evidence, including groups not safe to restore.
        let mut evidence=doc.clone();evidence.as_object_mut().unwrap().remove("retainedImports");
        let selected=plan.actions.iter().filter(|action|action.local.is_none() || args.choices.get(&action.id).is_some_and(|choice|choice=="incoming")).collect::<Vec<_>>();
        let mut retained=vec![evidence];
        if let Some(previous)=doc.get("retainedImports").and_then(Value::as_array) {retained.extend(previous.iter().cloned());}
        super::relations::refresh_retained(tx,&selected,origin,&op.cancel)?;
        for mut document in retained {
            super::relations::trim_retained(tx,&mut document,&selected,origin)?;
            if !super::relations::has_retained(&document) {continue;}
            let bytes=document.to_string();let digest=super::validate::payload(bytes.as_bytes()).sha256;
            tx.execute("INSERT OR IGNORE INTO pending_import VALUES (?1,?2,?3)",params![text(&document,"originCatalogueId")?,digest,bytes]).map_err(error)?;
        }
        // Forget last: no membership, waiting transfer or retained evidence may
        // recreate data purged by the same local operation.
        let forgotten=forget_targets.iter()
            .map(|target|super::relations::canonical(tx,target)).collect::<Result<std::collections::BTreeSet<_>>>()?;
        if !forgotten.is_empty() {
            crate::services::catalogue::data::mutate::forget::apply(tx,&forgotten.iter().cloned().collect::<Vec<_>>())?;
            for id in before.keys().cloned().collect::<Vec<_>>() {
                if forgotten.contains(&super::relations::canonical(tx,&id)?) {before.remove(&id);}
            }
        }
        for original in plan.cards.values() {
            let target=&super::relations::canonical(tx,original)?;
            if forgotten.contains(target) {continue;}
            if !metadata::age_interval_valid(tx,target).map_err(error)? {return Err(UserMessage::new(codes::CATALOG_IMPORT_AGE_INTERVAL_CONFLICT).param("title",plan.label(original)));}
            tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1",[target]).map_err(error)?;
            tx.execute("DELETE FROM cache.search_projection WHERE fiche_id=?1",[target]).map_err(error)?;
        }
        tx.execute("UPDATE catalogue SET revision=revision+1",[]).map_err(error)?;
        let result=json!({"imported":imported,"keptLocal":kept,"ignored":0,"unresolved":plan.preview.unresolved.len(),"catalogueRevision":revision+1,"reportId":operation});
        // Forgetting may remove this operation's earlier association history too.
        // Recreate only its receipt, without any forgotten personal snapshots.
        // It may also survive only as the anchor of unrelated restored decisions.
        tx.execute("INSERT INTO operation VALUES (?1,'importCatalogue','running',?2,?3,unixepoch(),NULL) ON CONFLICT(id) DO UPDATE SET request_key=excluded.request_key",params![operation,args.request_id,revision]).map_err(error)?;
        tx.execute("UPDATE operation SET status='committed',recovery_json=?2 WHERE id=?1",params![operation,json!({"mutation":args,"outcome":result}).to_string()]).map_err(error)?;
        for (target,snapshot) in before {
            tx.execute("INSERT INTO operation_change VALUES (?1,'fiche',?2,?3,?4,COALESCE((SELECT revision FROM fiche WHERE id=?2),0))",params![operation,target,serde_json::to_string(&snapshot).map_err(error)?,serde_json::to_string(&card::snapshot(tx,&target).map_err(error)?).map_err(error)?]).map_err(error)?;
        }
        tx.execute("INSERT INTO import_receipt VALUES (?1,?2,?3) ON CONFLICT(archive_digest) DO UPDATE SET operation_id=excluded.operation_id,result_json=excluded.result_json",params![receipt_key,operation,result.to_string()]).map_err(error)?;
        Ok(result)
    }, || {
        let boundary=op.progress.lock().map_err(error)?;
        super::export::check(&op.cancel)?;
        Ok(boundary)
    })?;
    op.published.store(true, Ordering::SeqCst);
    if !forget_targets.is_empty() {
        if let Err(reason) = store.clean_erased_thumbnails() {
            log::warn!(
                "Catalogue thumbnail cleanup after imported forgetting: {}",
                reason.code
            );
        }
        if let Err(message) = store.clean_orphan_images() {
            log::warn!(
                "Catalogue image cleanup after imported forgetting: {}",
                message.code
            );
        }
    }
    Ok(result)
}
