// Ce qu'un refus d'export a empêché.
//
// Le branchement se fait sur `kind`, et sur `preparation.error.kind` pour les
// cinq sous-types — jamais sur une recherche de mots dans un message. Les
// textes reçus (`message`, `detail`) sont affichés tels quels : ce sont des
// données, pas des sources de décision.
//
// Une **annulation** n'est pas une panne d'écriture : un `output-write` survenu
// pendant un abandon reste une panne d'écriture, avec résidu possible.
//
// Les textes tutoient et parlent du pack, comme le reste du rapport commun.
import { useMemo } from 'react';

import { Button } from '../common/Button';
import {
  EXPORT_REFUSAL,
  PREPARATION_REFUSAL,
  groupUnavailableMedia,
  mediaFieldLabel,
} from '../../store/advancedExport/exportOutcome.js';

// Les chemins des Écrans, tels que la vue relue les donne. Ce
// rapport se peint aussi dans la file de rendu, qui ne connaît pas la vue du
// graphe : la correspondance lui est donc **tendue**, plutôt que déduite d'un
// index qu'elle n'a pas. Sans elle, l'identifiant reste lisible, il n'est
// simplement plus cliquable.
function StageList({ stageIds, stagePaths, onFocusPath }) {
  const pathByUuid = useMemo(() => {
    const table = new Map();
    for (const entry of Array.isArray(stagePaths) ? stagePaths : []) {
      if (entry?.uuid) table.set(entry.uuid, entry.path ?? null);
    }
    return table;
  }, [stagePaths]);
  if (!stageIds || stageIds.length === 0) return null;
  return (
    <ul className="advanced-export__stages">
      {stageIds.map((uuid) => {
        // Le chemin d'un nœud appartient à Rust : il est **retrouvé** dans
        // la vue relue, jamais recomposé à partir d'un UUID.
        const path = pathByUuid.get(uuid) ?? null;
        return (
          <li key={uuid}>
            {path && onFocusPath
              ? <button type="button" className="advanced-link" onClick={() => onFocusPath(path)}>{uuid}</button>
              : <code>{uuid}</code>}
          </li>
        );
      })}
    </ul>
  );
}

function RefusalBody({ refusal, embedded, stagePaths, onFocusPath, onOpenDiagnostics }) {
  // Intégré au rapport commun, le message y est déjà : ne pas le redire.
  const message = embedded ? null : refusal.message;
  switch (refusal.kind) {
    case EXPORT_REFUSAL.PAYLOAD_DECODE:
      return (
        <div>
          <p className="advanced-export__row-message">
            Le projet n'a pas pu être relu, le pack n'a pas été produit.
          </p>
          {refusal.codecError && (
            <p className="advanced-export__row-path">
              <code>{refusal.codecError.code}</code> {refusal.codecError.path}
              {' — trouvé : '}{refusal.codecError.found}
              {' ; attendu : '}{refusal.codecError.expected}
            </p>
          )}
        </div>
      );

    case EXPORT_REFUSAL.PREPARATION:
      return (
        <div>
          {message && <p className="advanced-export__row-message">{message}</p>}
          {refusal.preparationKind === PREPARATION_REFUSAL.GRAPH_INTEGRITY && (
            <ul className="advanced-export__rows">
              {refusal.integrityErrors.map((error, position) => (
                <li key={`${error.code}-${error.path}-${position}`} className="advanced-export__row">
                  <p className="advanced-export__row-head"><code>{error.code}</code></p>
                  <p className="advanced-export__row-message">{error.message}</p>
                  <p className="advanced-export__row-path"><code>{error.path}</code></p>
                </li>
              ))}
            </ul>
          )}
          {refusal.preparationKind === PREPARATION_REFUSAL.AUTHORING_ACTION_REQUIRED && (
            <>
              <ul className="advanced-export__rows">
                {refusal.diagnostics.map((diagnostic, position) => (
                  <li key={`${diagnostic.code}-${diagnostic.path}-${position}`} className="advanced-export__row">
                    <p className="advanced-export__row-head"><code>{diagnostic.code}</code></p>
                    <p className="advanced-export__row-message">{diagnostic.message}</p>
                    <p className="advanced-export__row-path"><code>{diagnostic.path}</code></p>
                  </li>
                ))}
              </ul>
              {onOpenDiagnostics && (
                <p className="advanced-export__actions">
                  {/* La résolution existe déjà, dans le panneau de diagnostics :
                      ce refus y conduit au lieu d'en fabriquer une seconde. */}
                  <Button size="sm" onClick={onOpenDiagnostics}>Ouvrir les résolutions</Button>
                </p>
              )}
            </>
          )}
          {refusal.preparationKind === PREPARATION_REFUSAL.READINESS_BLOCKED && (
            <ul className="advanced-export__rows">
              {refusal.diagnostics.map((line, position) => (
                <li key={`${position}-${String(line)}`} className="advanced-export__row">{String(line)}</li>
              ))}
            </ul>
          )}
        </div>
      );

    case EXPORT_REFUSAL.MEDIA_UNAVAILABLE: {
      const groups = groupUnavailableMedia(refusal.entries);
      return (
        <div>
          <p className="advanced-export__row-message">
            Le pack n'a pas été produit : {groups.length} média{groups.length > 1 ? 's sont' : ' est'} introuvable{groups.length > 1 ? 's' : ''}.
            Pour chacun, les écrans qui l'utilisent sont listés.
          </p>
          <ul className="advanced-export__rows">
            {groups.map((group) => (
              <li key={group.assetRef} className="advanced-export__row">
                <p className="advanced-export__row-head">
                  <code>{group.assetRef}</code>
                  {' — '}
                  {group.fields.map(mediaFieldLabel).join(', ')}
                </p>
                <p className="advanced-export__row-message">{group.causeLabel}</p>
                {group.byReferenceOnly ? (
                  <p className="advanced-export__row-message">
                    Aucun ancien emplacement n'est connu : choisis le fichier depuis l'écran
                    concerné.
                  </p>
                ) : group.lastKnownPath && (
                  <p className="advanced-export__row-path">
                    dernier emplacement connu : <code>{group.lastKnownPath}</code>
                  </p>
                )}
                {group.detail && <p className="advanced-export__row-path">{group.detail}</p>}
                <StageList stageIds={group.stageIds} stagePaths={stagePaths} onFocusPath={onFocusPath} />
              </li>
            ))}
          </ul>
        </div>
      );
    }

    case EXPORT_REFUSAL.ARCHIVE_NAME_COLLISION:
      return (
        <div>
          <p className="advanced-export__row-message">
            Deux médias portent le même nom dans le pack. C'est un défaut de Story Studio,
            pas du projet : le pack n'a pas été produit.
          </p>
          <ul className="advanced-export__rows">
            {refusal.conflicts.map((conflict) => (
              <li key={`${conflict.assetRef}-${conflict.archiveName}`} className="advanced-export__row">
                <code>{conflict.assetRef}</code> → <code>{conflict.archiveName}</code>
              </li>
            ))}
          </ul>
        </div>
      );

    case EXPORT_REFUSAL.MEDIA_ORACLE:
      return (
        <div>
          <p className="advanced-export__row-message">
            Les médias préparés ne correspondent pas à ceux du projet. Tes fichiers ne sont pas
            en cause ; le pack n'a pas été produit.
          </p>
          <ul className="advanced-export__rows">
            {refusal.disagreements.map((disagreement, position) => (
              <li key={`${disagreement.assetRef}-${position}`} className="advanced-export__row">
                <p className="advanced-export__row-head">
                  <code>{disagreement.assetRef}</code>
                  {disagreement.stageUuid && <> — écran <code>{disagreement.stageUuid}</code></>}
                  {disagreement.kind && <> — {mediaFieldLabel(disagreement.kind)}</>}
                </p>
                <p className="advanced-export__row-message">
                  attendu <code>{disagreement.expected}</code>, observé <code>{disagreement.observed}</code>
                </p>
              </li>
            ))}
          </ul>
        </div>
      );

    case EXPORT_REFUSAL.CANCELLED:
      return (
        <p className="advanced-export__row-message">
          Génération annulée : aucun pack n'a été produit et le projet est inchangé.
        </p>
      );

    case EXPORT_REFUSAL.OUTPUT_WRITE:
      return (
        <div>
          <p className="advanced-export__row-message">
            L'écriture du pack a échoué. Le projet et tes fichiers d'origine restent intacts.
          </p>
          {refusal.path && <p className="advanced-export__row-path"><code>{refusal.path}</code></p>}
          {message && <p className="advanced-export__row-message">{message}</p>}
          <p className="advanced-export__row-message">
            {/* Quand le nettoyage du fichier temporaire échoue après une
                annulation, le refus **devient** `output-write` pour ne pas
                masquer le résidu. Le dire est le seul moyen que l'auteur aille
                voir. */}
            Un fichier temporaire <code>.partial</code> a pu rester dans le dossier de sortie :
            tu peux le supprimer.
          </p>
        </div>
      );

    case EXPORT_REFUSAL.REQUEST:
      return (
        <p className="advanced-export__row-message">
          {/* Rien n'a été demandé au moteur : la garde est locale, et le dire
              évite de laisser croire qu'il a refusé. */}
          {message ? `${message} ` : ''}La génération n'a pas été lancée.
        </p>
      );

    case EXPORT_REFUSAL.UNTYPED:
    default:
      return (
        <p className="advanced-export__row-message">
          La génération s'est interrompue sans explication précise.
          {message && <> <code>{message}</code></>}
        </p>
      );
  }
}

// `embedded` : peint sous le rapport commun de la file, qui porte déjà le titre
// et le message du refus ; seul le détail utile à la correction reste.
export function ExportRefusalReport({ refusal, embedded = false, stagePaths = null, onFocusPath = null, onOpenDiagnostics = null, onDismiss = null }) {
  if (!refusal) return null;
  return (
    <section
      className="advanced-export__outcome advanced-export__outcome--refused"
      role="alert"
      data-kind={refusal.kind}
    >
      {!embedded && <h3>{refusal.title}</h3>}
      <RefusalBody
        refusal={refusal}
        embedded={embedded}
        stagePaths={stagePaths}
        onFocusPath={onFocusPath}
        onOpenDiagnostics={onOpenDiagnostics}
      />
      {onDismiss && (
        <p className="advanced-export__actions">
          <Button size="sm" onClick={onDismiss}>Fermer</Button>
        </p>
      )}
    </section>
  );
}
