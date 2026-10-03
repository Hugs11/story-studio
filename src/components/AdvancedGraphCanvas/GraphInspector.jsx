// Inspecteur de lecture du graphe avancé. Le canvas restant muet, ce panneau
// porte la représentation DOM complète du nœud, sans geste d'auteur.

import './GraphInspector.css';

const PRESENCE_LABELS = { absent: 'absent', null: 'null', value: 'valeur' };

function PresenceValue({ field, render = (value) => String(value) }) {
  if (!field || field.presence !== 'value') {
    return (
      <span className="advanced-inspector__absent" data-presence={field?.presence ?? 'absent'}>
        {PRESENCE_LABELS[field?.presence ?? 'absent']}
      </span>
    );
  }
  return <span className="advanced-inspector__value">{render(field.value)}</span>;
}

function Row({ label, children }) {
  return (
    <div className="advanced-inspector__row">
      <span className="advanced-inspector__label">{label}</span>
      <span className="advanced-inspector__cell">{children}</span>
    </div>
  );
}

function Section({ title, count = null, className = '', children }) {
  return (
    <section className={`advanced-inspector__section ${className}`.trim()}>
      <h3>
        <span>{title}</span>
        {count !== null && <span className="advanced-inspector__count">{count}</span>}
      </h3>
      <div className="advanced-inspector__section-body">{children}</div>
    </section>
  );
}

function Transition({ label, transition }) {
  if (!transition || transition.presence !== 'value') {
    return <Row label={label}><PresenceValue field={transition} /></Row>;
  }
  return (
    <Row label={label}>
      <span className="advanced-inspector__value">
        {transition.actionId}
        {transition.selection?.kind === 'random'
          ? <em> — choix tiré au sort à chaque ouverture</em>
          : <em> — choix {transition.selection?.index}</em>}
      </span>
    </Row>
  );
}

function LinkSummary({ inspected, onFocusPath }) {
  const rows = [
    ...inspected.outgoing.map((edge) => ({
      ...edge,
      direction: 'Sortant',
      path: edge.to,
      description: edge.kind === 'stage-ok'
        ? 'OK'
        : edge.kind === 'stage-home'
          ? 'HOME'
          : `choix ${edge.ordinal ?? '—'}`,
    })),
    ...inspected.incoming.map((edge) => ({
      ...edge,
      direction: 'Entrant',
      path: edge.from,
      description: edge.kind === 'action-option' ? `choix ${edge.ordinal ?? '—'}` : edge.kind,
    })),
  ].filter((edge) => edge.path);

  return (
    <Section title="Liens" count={rows.length} className="advanced-inspector__links">
      <div className="advanced-inspector__link-counts">
        <span>{inspected.incoming.length} entrant{inspected.incoming.length > 1 ? 's' : ''}</span>
        <span>{inspected.outgoing.length} sortant{inspected.outgoing.length > 1 ? 's' : ''}</span>
      </div>
      {rows.length === 0 ? (
        <p className="advanced-inspector__muted">Nœud détaché : aucun lien entrant ni sortant.</p>
      ) : (
        <ul className="advanced-inspector__link-list">
          {rows.map((edge) => (
            <li key={`${edge.direction}-${edge.edgeId}`}>
              <span className="advanced-inspector__link-direction">{edge.direction}</span>
              <button
                type="button"
                className="advanced-inspector__link"
                onClick={() => onFocusPath(edge.path)}
              >
                {edge.path}
              </button>
              <span className="advanced-inspector__link-kind">{edge.description}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function GraphInspector({ inspected, onFocusPath }) {
  if (!inspected) {
    return (
      <aside className="advanced-inspector advanced-inspector--readonly" aria-label="Inspecteur">
        <div className="advanced-inspector__empty">
          <strong>Aucun nœud sélectionné</strong>
          <span>Choisissez un nœud dans la liste pour consulter tous ses détails.</span>
        </div>
      </aside>
    );
  }

  const { node, kind } = inspected;
  const isStage = kind === 'stage';
  const isEntry = isStage && node.squareOne?.presence === 'value' && node.squareOne.value === true;

  return (
    <aside className="advanced-inspector advanced-inspector--readonly" aria-label="Inspecteur">
      <header className="advanced-inspector__header">
        <div className="advanced-inspector__headline">
          <span className="advanced-inspector__kind">{isStage ? 'Écran' : 'Liste de choix'}</span>
          {isEntry && <span className="advanced-inspector__badge advanced-inspector__badge--entry">Racine</span>}
        </div>
        <h2 className="advanced-inspector__title">
          {inspected.label.label}
          {inspected.label.isFallback && (
            <em className="advanced-inspector__fallback" title="Repli d'affichage, pas un nom d'auteur">
              {' '}(sans nom)
            </em>
          )}
        </h2>
        <code className="advanced-inspector__identifier">{inspected.identifier}</code>
      </header>

      <Section title="Identité">
        <Row label="Identifiant">
          <code>{inspected.identifier}</code>
          {node.occurrence > 0 && <em> — occurrence {node.occurrence}</em>}
        </Row>
        <Row label="Nom"><PresenceValue field={node.name} /></Row>
        {isStage && (
          <Row label="Racine">
            <PresenceValue field={node.squareOne} render={(value) => (value ? 'oui' : 'non')} />
          </Row>
        )}
      </Section>

      {isStage && (
        <>
          <Section title="Médias" count={inspected.media.length}>
            <Row label="Audio">
              <PresenceValue field={{ presence: node.audio.presence, value: node.audio.assetRef }} />
            </Row>
            <Row label="Image">
              <PresenceValue field={{ presence: node.image.presence, value: node.image.assetRef }} />
            </Row>
            {inspected.media.map((media) => (
              <Row key={`${media.field}-${media.assetRef}`} label={`${media.field} · usage`}>
                <code>{media.assetRef}</code>
                {media.usageCount > 1 && <em> — utilisé par {media.usageCount} écrans</em>}
              </Row>
            ))}
          </Section>

          <Section title="Contrôles" className="advanced-inspector__controls">
            {['wheel', 'ok', 'home', 'pause', 'autoplay'].map((control) => (
              <Row key={control} label={control}>
                <PresenceValue
                  field={node.controls[control]}
                  render={(value) => (value ? 'activé' : 'désactivé')}
                />
              </Row>
            ))}
          </Section>

          <Section title="Transitions">
            <Transition label="OK" transition={node.okTransition} />
            <Transition label="HOME" transition={node.homeTransition} />
          </Section>
        </>
      )}

      {!isStage && (
        <Section title="Options" count={node.options.length} className="advanced-inspector__options">
          <ol start={0}>
            {node.options.map((option) => (
              <li key={option.optionId}>
                {option.target.presence === 'null'
                  ? <em className="advanced-inspector__absent" data-presence="null">cible nulle</em>
                  : (
                    <button
                      type="button"
                      className="advanced-inspector__link"
                      disabled={option.target.stagePath === null}
                      onClick={() => option.target.stagePath && onFocusPath(option.target.stagePath)}
                    >
                      {option.target.stageUuid}
                    </button>
                  )}
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section title="Disposition">
        {/* Un nœud n'a qu'une position, celle du graphe à plat. */}
        <Row label="Position">
          {Math.round(node.layout.x)}, {Math.round(node.layout.y)}
        </Row>
      </Section>

      <LinkSummary inspected={inspected} onFocusPath={onFocusPath} />
    </aside>
  );
}
