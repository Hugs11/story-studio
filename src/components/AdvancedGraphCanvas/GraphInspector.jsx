import { useTranslation } from 'react-i18next';
import { translateGraph as t, graphTranslationEngine } from '../../i18n/graphPresentation.js';
// Inspecteur de lecture du graphe avancé. Le canvas restant muet, ce panneau
// porte la représentation DOM complète du nœud, sans geste d'auteur.

import './GraphInspector.css';

const PRESENCE_LABELS = { absent: "graph:inspector.absent.label", null: "graph:inspector.null.label", value: "graph:inspector.valeur.label" };

function PresenceValue({ field, render = (value) => String(value) }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  if (!field || field.presence !== 'value') {
    return (
      <span className="advanced-inspector__absent" data-presence={field?.presence ?? 'absent'}>
        {t(PRESENCE_LABELS[field?.presence ?? 'absent'])}
      </span>
    );
  }
  return <span className="advanced-inspector__value">{render(field.value)}</span>;
}

function Row({ label, children }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  return (
    <div className="advanced-inspector__row">
      <span className="advanced-inspector__label">{label}</span>
      <span className="advanced-inspector__cell">{children}</span>
    </div>
  );
}

function Section({ title, count = null, className = '', children }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
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
  useTranslation('graph', { i18n: graphTranslationEngine() });
  if (!transition || transition.presence !== 'value') {
    return <Row label={label}><PresenceValue field={transition} /></Row>;
  }
  return (
    <Row label={label}>
      <span className="advanced-inspector__value">
        {transition.actionId}
        {transition.selection?.kind === 'random'
          ? <em>{t("graph:inspector.choiceDrawnAtRandomEachTimeTheListOpens.label")}</em>
          : <em>{t('graph:inspector.choice.ordinal', { index: transition.selection?.index })}</em>}
      </span>
    </Row>
  );
}

function LinkSummary({ inspected, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const rows = [
    ...inspected.outgoing.map((edge) => ({
      ...edge,
      directionKey: 'outgoing',
      direction: t("graph:inspector.sortant.label"),
      path: edge.to,
      description: edge.kind === 'stage-ok'
        ? 'OK'
        : edge.kind === 'stage-home'
          ? 'HOME'
          : t("graph:inspector.choix.label", { ordinal: edge.ordinal ?? '—' }),
    })),
    ...inspected.incoming.map((edge) => ({
      ...edge,
      directionKey: 'incoming',
      direction: t("graph:inspector.entrant.label"),
      path: edge.from,
      description: edge.kind === 'action-option' ? t("graph:inspector.choix.label", { ordinal: edge.ordinal ?? '—' }) : edge.kind,
    })),
  ].filter((edge) => edge.path);

  return (
    <Section title={t("graph:inspector.liens.label")} count={rows.length} className="advanced-inspector__links">
      <div className="advanced-inspector__link-counts">
        <span>{t('graph:inspector.links.incomingCount', { count: inspected.incoming.length })}</span>
        <span>{t('graph:inspector.links.outgoingCount', { count: inspected.outgoing.length })}</span>
      </div>
      {rows.length === 0 ? (
        <p className="advanced-inspector__muted">{t("graph:inspector.detachedNodeNoIncomingOrOutgoingLinks.label")}</p>
      ) : (
        <ul className="advanced-inspector__link-list">
          {rows.map((edge) => (
            <li key={`${edge.directionKey}-${edge.edgeId}`}>
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
  useTranslation('graph', { i18n: graphTranslationEngine() });
  if (!inspected) {
    return (
      <aside className="advanced-inspector advanced-inspector--readonly" aria-label={t("graph:inspector.inspecteur.label")}>
        <div className="advanced-inspector__empty">
          <strong>{t("graph:inspector.noNodeSelected.label")}</strong>
          <span>{t("graph:inspector.selectANodeInTheListToViewAll.label")}</span>
        </div>
      </aside>
    );
  }

  const { node, kind } = inspected;
  const isStage = kind === 'stage';
  const isEntry = isStage && node.squareOne?.presence === 'value' && node.squareOne.value === true;

  return (
    <aside className="advanced-inspector advanced-inspector--readonly" aria-label={t("graph:inspector.inspecteur.label")}>
      <header className="advanced-inspector__header">
        <div className="advanced-inspector__headline">
          <span className="advanced-inspector__kind">{isStage ? t("graph:inspector.ecran.label") : t('graph:inspector.node.actionLabel')}</span>
          {isEntry && <span className="advanced-inspector__badge advanced-inspector__badge--entry">{t("graph:inspector.entree.label")}</span>}
        </div>
        <h2 className="advanced-inspector__title">
          {inspected.label.label}
          {inspected.label.isFallback && (
            <em className="advanced-inspector__fallback" title={t("graph:inspector.displayFallbackNotAnAuthoredName.label")}>
              {' '}{t("common:status.node.fallback")}</em>
          )}
        </h2>
        <code className="advanced-inspector__identifier">{inspected.identifier}</code>
      </header>

      <Section title={t("graph:inspector.identite.label")}>
        <Row label={t("graph:inspector.identifiant.label")}>
          <code>{inspected.identifier}</code>
          {node.occurrence > 0 && <em>{t('graph:inspector.identifier.occurrence', { occurrence: node.occurrence })}</em>}
        </Row>
        <Row label={t("graph:inspector.nom.label")}><PresenceValue field={node.name} /></Row>
        {isStage && (
          <Row label={t("graph:inspector.entree.label")}>
            <PresenceValue field={node.squareOne} render={(value) => (value ? t("graph:inspector.oui.label") : t("graph:inspector.non.label"))} />
          </Row>
        )}
      </Section>

      {isStage && (
        <>
          <Section title={t("common:workspace.media.tab")} count={inspected.media.length}>
            <Row label={t("graph:inspector.audio.label")}>
              <PresenceValue field={{ presence: node.audio.presence, value: node.audio.assetRef }} />
            </Row>
            <Row label={t("graph:inspector.image.label")}>
              <PresenceValue field={{ presence: node.image.presence, value: node.image.assetRef }} />
            </Row>
            {inspected.media.map((media) => (
              <Row key={`${media.field}-${media.assetRef}`} label={t('graph:inspector.media.usageLabel', { field: media.field })}>
                <code>{media.assetRef}</code>
                {media.usageCount > 1 && <em>{t('graph:inspector.media.usageCount', { count: media.usageCount })}</em>}
              </Row>
            ))}
          </Section>

          <Section title={t("graph:inspector.controles.label")} className="advanced-inspector__controls">
            {['wheel', 'ok', 'home', 'pause', 'autoplay'].map((control) => (
              <Row key={control} label={control}>
                <PresenceValue
                  field={node.controls[control]}
                  render={(value) => (value ? t("graph:inspector.active.label") : t("graph:inspector.desactive.label"))}
                />
              </Row>
            ))}
          </Section>

          <Section title={t("graph:inspector.transitions.label")}>
            <Transition label={t("common:dialog.confirm.label")} transition={node.okTransition} />
            <Transition label={t("graph:inspector.home.label")} transition={node.homeTransition} />
          </Section>
        </>
      )}

      {!isStage && (
        <Section title={t("graph:inspector.options.label")} count={node.options.length} className="advanced-inspector__options">
          <ol start={0}>
            {node.options.map((option) => (
              <li key={option.optionId}>
                {option.target.presence === 'null'
                  ? <em className="advanced-inspector__absent" data-presence="null">{t("graph:inspector.cibleNulle.label")}</em>
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

      <Section title={t("graph:inspector.disposition.label")}>
        {/* Un nœud n'a qu'une position, celle du graphe à plat. */}
        <Row label={t("graph:inspector.position.label")}>
          {Math.round(node.layout.x)}, {Math.round(node.layout.y)}
        </Row>
      </Section>

      <LinkSummary inspected={inspected} onFocusPath={onFocusPath} />
    </aside>
  );
}
