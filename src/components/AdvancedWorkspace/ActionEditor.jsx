import { useTranslation, Trans } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
// L'éditeur d'une Liste de choix — une Action du modèle : les choix que la
// molette fait défiler, dans l'ordre qui la définit, puis qui ouvre la liste.
//
// L'**ordre** est une donnée sémantique et le **rang** l'identité d'une
// occurrence. Trois conséquences visibles ici :
//
// - deux occurrences visant le même Écran restent deux lignes distinctes, et
//   aucune n'est fusionnée avec l'autre ;
// - permuter envoie une **permutation des rangs**, jamais une liste de cibles ;
// - retirer une occurrence est une décision, pas un effet de bord : les
//   transitions que le retrait priverait de destination sont montrées d'abord.

import { useEffect, useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Button } from '../common/Button';
import { HelpHint } from '../common/HelpHint';
import { Select } from '../common/Select';
import { Tooltip } from '../common/Tooltip';
import { ContextMenu } from '../TreePanel/ContextMenu.jsx';
import {
  ChevronDown, ChevronRight, Dices, Ellipsis, GripVertical, Plus, Trash2,
} from '../icons/LucideLocal.jsx';
import { ActionSelectionFields } from './ActionSelectionFields.jsx';
import { LandingSelect, landingGesture } from './LandingSelect.jsx';
import {
  NodeLink, NodeThumbnail, OPENER_SLOT_LABELS, positionText,
} from './connectionRows.jsx';
import { NodeNameEditor } from './NodeNameEditor.jsx';
import { NodePicker } from './NodePicker.jsx';
import { useAdvancedNodeThumbnails } from '../AdvancedGraphCanvas/useAdvancedNodeThumbnails.js';
import { isEntryStage } from '../../store/advancedGraphView/graphViewModel.js';
import {
  RANDOM_OPTION_INDEX,
  advancedGestures,
  optionTarget,
} from '../../store/projectModel/advancedGestures.js';
import {
  describeActionProvenance,
  movePermutation,
} from '../../store/advancedAuthoring/actionProvenance.js';

// Une ligne de choix : poignée pour glisser, place « 2/14 », vignette, nom, et
// un menu « ⋯ » qui porte tous les gestes de la ligne.
// Qui commence sur ce choix : « départ de Stage 2 », ou le nombre d'Écrans
// au-delà de deux.
function startsText(names) {
  if (names.length <= 2) return t('graph:action.departure.names', { names: names.length === 2 ? t('graph:action.names.join', { first: names[0], second: names[1] }) : names[0] ?? '' });
  return t('graph:action.departure.count', { count: names.length });
}

// Une ligne de choix dit aussi ce qui s'y passe : les Écrans qui ouvrent la
// liste sur ce choix, et une molette éteinte, qui arrête le défilement ici.
function DestinationRow({
  option, rank, count, label, starts = [], wheelOff = false, isEntry = false, disabled, thumbnails, onFocusPath, onOpenMenu,
}) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: option.optionId, disabled });
  const stagePath = option.target.stagePath;
  return (
    <li
      ref={setNodeRef}
      className={`advanced-options__row${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="advanced-options__lead advanced-options__handle"
        aria-label={t('graph:action.choice.move', { ordinal: rank + 1 })}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </button>
      <span className="advanced-options__rank advanced-options__position">{positionText(rank, count)}</span>
      {option.target.presence === 'null' ? (
        <em className="advanced-options__target advanced-field__absent">{t('graph:landing.target.fallback')}</em>
      ) : (
        <span className="advanced-options__target advanced-choice__target">
          <NodeThumbnail path={stagePath} thumbnails={thumbnails} />
          <NodeLink path={stagePath} label={label} onFocusPath={onFocusPath} />
          {starts.length > 0 && (
            <Tooltip text={startsText(starts)} asChild whenTruncated>
              <span className="advanced-choice__note">{startsText(starts)}</span>
            </Tooltip>
          )}
          {wheelOff && <span className="advanced-choice__note is-warning">{t('graph:action.wheel.disabled')}</span>}
          {isEntry && (
            <span className="advanced-choice__note is-warning">{t('graph:action.choice.entry')}</span>
          )}
        </span>
      )}
      <button
        type="button"
        className="advanced-options__more"
        aria-label={t('graph:action.choice.menu', { ordinal: rank + 1 })}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          onOpenMenu(rank, box.right - 200, box.bottom + 4);
        }}
      >
        <Ellipsis />
      </button>
    </li>
  );
}

// Le formulaire « Relier un Écran » : l'Écran qui ouvrira la liste, la touche
// par laquelle il l'ouvre, et — seulement si la liste a plusieurs choix — le
// choix sur lequel il arrive, pré-réglé sur le premier, le cas normal.
function WireForm({ initialSlot, index, action, disabled, onGesture, onClose }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const options = action.options ?? [];
  const [slot, setSlot] = useState(initialSlot);
  const [stagePath, setStagePath] = useState(null);
  const [selection, setSelection] = useState('0');
  const apply = () => {
    const stage = index.byPath.get(stagePath);
    if (!stage) return;
    onGesture(options.length === 0
      ? advancedGestures.connectStageToEmptyAction(stage.node.uuid, slot, action.id)
      : advancedGestures.setStageTransition(
        stage.node.uuid,
        slot,
        advancedGestures.transitionTo(
          action.id,
          selection === 'random' ? RANDOM_OPTION_INDEX : Number(selection),
        ),
      ));
    onClose();
  };
  const id = `advanced-wire-${slot}`;
  return (
    <div className="advanced-field__form">
      <p className="advanced-field__note">
        {slot === 'home'
          ? t('graph:action.wire.homeNote')
          : t('graph:action.wire.routeNote')}
      </p>
      <label htmlFor="advanced-wire-slot">{t('graph:action.wire.by')}</label>
      <Select
        id="advanced-wire-slot"
        value={slot}
        disabled={disabled}
        onChange={setSlot}
        options={[
          { value: 'ok', label: t('graph:action.wire.route') },
          { value: 'home', label: t('graph:action.wire.home') },
        ]}
      />
      <label htmlFor={id}>{t('graph:type.stage.label')}</label>
      <NodePicker
        id={id}
        index={index}
        kind="stage"
        value={stagePath}
        onChange={setStagePath}
        disabled={disabled}
      />
      <ActionSelectionFields
        id={`${id}-selection`}
        options={options}
        index={index}
        selection={selection}
        onChange={setSelection}
        disabled={disabled}
      />
      <div className="advanced-field__actions">
        <Button size="sm" onClick={onClose}>{t('common:dialog.cancel.label')}</Button>
        <Button size="sm" variant="primary" disabled={disabled || !stagePath} onClick={apply}>{t('graph:action.wire.confirm')}</Button>
      </div>
    </div>
  );
}

const ORDER_HELP = 'graph:action.order.help';

const ecrans = (count) => count === 0 ? t('graph:action.stages.none') : t('graph:selection.stages.count', { count });

// Le choix sur lequel un groupe d'Écrans ouvre la liste : « commencent sur
// 2/3 » puis l'Écran de ce choix, avec sa vignette et son lien. L'encadré
// parle déjà de cette liste : la phrase ne la renomme pas.
function ArrivalTarget({ landing, total, thumbnails, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const lead = <span className="advanced-options__verb">{t('graph:action.arrival.verb')}</span>;
  if (landing.random) {
    return (
      <>
        {lead}
        <span className="advanced-options__random"><Dices aria-hidden="true" />{t('graph:action.arrival.random')}</span>
      </>
    );
  }
  if (landing.unknown) return <>{lead}<em className="advanced-field__absent">{t('graph:action.arrival.unknown')}</em></>;
  const position = (
    <span className="advanced-options__rank advanced-options__position">{positionText(landing.rank, total)}</span>
  );
  if (landing.missing) return <>{lead}{position}<em className="advanced-field__absent">{t('graph:action.arrival.missing')}</em></>;
  if (!landing.stagePath) return <>{lead}{position}<em className="advanced-field__absent">{t('graph:landing.target.fallback')}</em></>;
  return (
    <>
      {lead}
      {position}
      <NodeThumbnail path={landing.stagePath} thumbnails={thumbnails} />
      <NodeLink path={landing.stagePath} label={landing.label} onFocusPath={onFocusPath} />
    </>
  );
}

// Un Écran qui ouvre la liste, dans l'ordre du graphe : l'Écran d'origine,
// puis, dessous, le choix sur lequel il l'ouvre — réglable sur place, comme
// dans le panneau de l'Écran. Dans un groupe, l'en-tête dit déjà l'arrivée, et
// la ligne ne la répète pas.
function ProvenanceRow({
  row, slot, actionId, choices, showArrival = true, disabled, thumbnails, onGesture, onFocusPath,
}) {
  const origin = (
    <div className="advanced-options__row">
      <span className="advanced-options__target">
        <NodeThumbnail path={row.sourcePath} thumbnails={thumbnails} />
        <NodeLink path={row.sourcePath} label={row.source.label.label} onFocusPath={onFocusPath} />
      </span>
    </div>
  );
  if (!showArrival) return <li className="advanced-options__group">{origin}</li>;
  return (
    <li className="advanced-options__group">
      {origin}
      <LandingSelect
        id={`advanced-landing-${encodeURIComponent(row.key)}`}
        landing={row.landing}
        choices={choices}
        disabled={disabled}
        onChange={(value) => onGesture(landingGesture(row.source.node.uuid, slot, actionId, value))}
      />
    </li>
  );
}

// Plusieurs Écrans qui ouvrent la liste par HOME sur le même choix : un
// en-tête qui dit l'arrivée et combien d'Écrans, déplié sur ces Écrans. Un
// menu mesuré en reçoit 170 sur un seul choix ; un Écran seul n'est pas groupé.
function HomeGroup({ group, total, thumbnails, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [open, setOpen] = useState(false);
  return (
    <li className="advanced-options__group">
      <div className="advanced-options__row">
        <button
          type="button"
          className="advanced-options__lead advanced-options__toggle"
          aria-expanded={open}
          aria-label={open ? t('graph:action.group.collapse') : t('graph:action.group.expand')}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
        {/* Un seul choix : il n'y a pas de point de départ à dire, et le
            nombre d'Écrans est déjà dans l'intertitre. L'en-tête ne sert
            qu'à les déplier. */}
        {total === 1 && !group.landing.random && !group.landing.unknown && !group.landing.missing ? (
          <span className="advanced-options__target">
            <button type="button" className="advanced-link" onClick={() => setOpen((value) => !value)}>
              {open ? t('graph:action.group.hide', { count: group.rows.length }) : t('graph:action.group.show', { count: group.rows.length })}
            </button>
          </span>
        ) : (
          <span className="advanced-options__target">
            <span className="advanced-count">{ecrans(group.rows.length)}</span>
            <ArrivalTarget
              landing={group.landing}
              total={total}
              thumbnails={thumbnails}
              onFocusPath={onFocusPath}
            />
          </span>
        )}
      </div>
      {open && (
        <ol className="advanced-options advanced-options--nested">
          {group.rows.map((row) => (
            <ProvenanceRow
              key={row.key}
              row={row}
              showArrival={false}
              thumbnails={thumbnails}
              onFocusPath={onFocusPath}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

export function ActionEditor({
  inspected,
  project,
  index,
  disabled,
  onGesture,
  onDelete,
  onRemoveOption,
  wireRequested = false,
  onWireRequestHandled = null,
  onFocusPath,
  focusName = false,
  onNameFocusHandled = null,
  onViewConnections,
}) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const action = inspected.node;
  const options = action.options ?? [];
  const [insertAt, setInsertAt] = useState(null);
  const [insertTarget, setInsertTarget] = useState(null);
  const [retargeting, setRetargeting] = useState(null);
  const [retargetTo, setRetargetTo] = useState(null);
  const [menu, setMenu] = useState(null);
  // La touche pré-choisie du raccord en cours (« Relier un Écran »), ou null.
  // Un seul formulaire ouvert à la fois dans le panneau.
  const [wiring, setWiring] = useState(null);

  const provenance = useMemo(
    () => describeActionProvenance(index, inspected.path),
    [index, inspected.path],
  );
  // Les vignettes des Écrans nommés dans le panneau : destinations et
  // provenances, une seule fois chacun.
  const thumbnailEntries = useMemo(() => {
    const entries = new Map();
    const add = (path) => {
      const entry = path ? index?.byPath.get(path) : null;
      if (entry) entries.set(path, entry);
    };
    options.forEach((option) => add(option.target.stagePath));
    provenance.ok.forEach((row) => add(row.sourcePath));
    provenance.home.groups.forEach((group) => group.rows.forEach((row) => add(row.sourcePath)));
    return [...entries.values()];
  }, [index, options, provenance]);
  const thumbnails = useAdvancedNodeThumbnails(project, thumbnailEntries);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const closeForms = () => {
    setWiring(null);
    setInsertAt(null);
    setInsertTarget(null);
    setRetargeting(null);
    setRetargetTo(null);
  };

  // Le « Raccorder » d'une Action orpheline, venu de la liste des problèmes,
  // ouvre ici « Relier un Écran », sur la touche OK.
  useEffect(() => {
    if (!wireRequested) return;
    setInsertAt(null);
    setRetargeting(null);
    setWiring('ok');
    onWireRequestHandled?.();
  }, [wireRequested, onWireRequestHandled]);

  const applyInsert = () => {
    const target = insertTarget === null
      ? optionTarget.null()
      : optionTarget.stage(index.byPath.get(insertTarget).node.uuid);
    onGesture(advancedGestures.insertActionOption(action.id, insertAt, target));
    closeForms();
  };

  const applyRetarget = () => {
    const target = retargetTo === null
      ? optionTarget.null()
      : optionTarget.stage(index.byPath.get(retargetTo).node.uuid);
    onGesture(advancedGestures.setActionOptionTarget(action.id, retargeting, target));
    closeForms();
  };

  const move = (from, to) => {
    if (from === to || to < 0 || to >= options.length) return;
    onGesture(advancedGestures.reorderActionOptions(
      action.id,
      movePermutation(options.length, from, to),
    ));
  };

  const labelOf = (option) => (option.target.stagePath
    ? index?.byPath.get(option.target.stagePath)?.label.label ?? option.target.stageUuid
    : option.target.stageUuid);

  // Les choix, pour le menu « commence sur » des Écrans qui ouvrent la liste.
  const choices = options.map((option, rank) => ({
    key: option.optionId,
    rank,
    label: option.target.presence === 'null' ? null : labelOf(option),
  }));

  // Par choix : les Écrans qui ouvrent la liste en commençant dessus, et une
  // molette éteinte, qui arrête le défilement sur ce choix.
  const startsByRank = new Map();
  [...provenance.ok, ...provenance.home.groups.flatMap((group) => group.rows)].forEach((row) => {
    if (!Number.isInteger(row.landing.rank) || row.landing.missing) return;
    const names = startsByRank.get(row.landing.rank) ?? [];
    names.push(row.source.label.label);
    startsByRank.set(row.landing.rank, names);
  });
  const wheelOff = (option) => {
    const wheel = option.target.stagePath
      ? index?.byPath.get(option.target.stagePath)?.node.controls?.wheel
      : null;
    return options.length > 1 && wheel?.presence === 'value' && wheel.value === false;
  };

  // Tous les gestes d'une ligne, dans le menu « ⋯ ». Monter et Descendre y
  // restent : c'est la voie du clavier, et celle de qui ne glisse pas.
  const menuActions = (rank) => [
    { label: t('graph:action.menu.edit'), fn: () => { closeForms(); setRetargeting(rank); } },
    { label: t('graph:action.menu.insert'), fn: () => { closeForms(); setInsertAt(rank); } },
    'sep',
    {
      label: t('graph:action.menu.up'),
      fn: () => move(rank, rank - 1),
      disabledReason: rank === 0 ? t('graph:action.menu.first') : undefined,
    },
    {
      label: t('graph:action.menu.down'),
      fn: () => move(rank, rank + 1),
      disabledReason: rank === options.length - 1 ? t('graph:action.menu.last') : undefined,
    },
    'sep',
    { label: t('graph:action.menu.remove'), danger: true, fn: () => onRemoveOption(rank) },
  ];


  return (
    <div className="advanced-editor">
      <section className="card advanced-editor__identity-card">
      <header className="advanced-editor__header">
        <span className="advanced-editor__kind advanced-editor__kind--action">{t('graph:type.action.label')}</span>
        {/* Le repli d'une liste se dit déjà : « Liste sans nom ». */}
        <h2 className="advanced-editor__title">
          {inspected.label.isFallback
            ? (
              <Tooltip text={t('graph:stage.name.fallbackHelp')} asChild>
                <em className="advanced-editor__fallback">{inspected.label.label}</em>
              </Tooltip>
            )
            : inspected.label.label}
        </h2>
        {/* L'identifiant, discret à côté du nom : sélectionnable, jamais une
            section à déplier. */}
        <Tooltip text={t('graph:stage.id.label')} asChild>
          <code className="advanced-editor__identifier">
            {inspected.identifier}
            {action.occurrence > 0 && t('graph:stage.id.occurrence', { ordinal: action.occurrence })}
          </code>
        </Tooltip>
      </header>

      <div className="field-row advanced-editor__name-row">
        <span className="field-label">{t('graph:name.field.aria')}</span>
        <div className="advanced-editor__name-control">
          <NodeNameEditor
            kind="action"
            node={action}
            disabled={disabled}
            focusRequested={focusName}
            onFocusHandled={onNameFocusHandled}
            onGesture={onGesture}
          />
        </div>
      </div>
      </section>

      {/* Deux encadrés, et deux seulement : les choix, éditables, puis qui
          ouvre la liste. Les choix ne sont pas répétés plus bas. */}
      <section className="card advanced-editor__section">
        <div className="card-title-row">
          <div className="card-title"><Trans i18n={graphTranslationEngine()} t={t} i18nKey="graph:action.order.title" values={{ count: options.length }} components={{ badge: <span className="advanced-count" /> }} /></div>
          <div className="card-copy card-copy--inline">{t('graph:action.order.description')}{' '}<HelpHint text={t(ORDER_HELP)} />
          </div>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={({ active, over }) => {
            if (!over || active.id === over.id) return;
            const from = options.findIndex((option) => option.optionId === active.id);
            const to = options.findIndex((option) => option.optionId === over.id);
            if (from >= 0 && to >= 0) move(from, to);
          }}
        >
          <SortableContext
            items={options.map((option) => option.optionId)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="advanced-options">
              {options.map((option, rank) => (
                <DestinationRow
                  key={option.optionId}
                  option={option}
                  rank={rank}
                  count={options.length}
                  label={labelOf(option)}
                  starts={startsByRank.get(rank)}
                  wheelOff={wheelOff(option)}
                  isEntry={isEntryStage(index?.byPath.get(option.target.stagePath))}
                  disabled={disabled}
                  thumbnails={thumbnails}
                  onFocusPath={onFocusPath}
                  onOpenMenu={(menuRank, x, y) => setMenu({ rank: menuRank, x, y })}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>

        <div className="advanced-field__actions">
          <Button size="sm" disabled={disabled} onClick={() => { closeForms(); setInsertAt(options.length); }}>
            <Plus />{t('graph:action.choice.add')}</Button>
        </div>

        {insertAt !== null && (
          <div className="advanced-field__form">
            <p className="advanced-field__note">{t('graph:action.choice.new', { ordinal: insertAt + 1 })}</p>
            <label htmlFor="advanced-insert-target">{t('graph:action.choice.target')}</label>
            <NodePicker
              id="advanced-insert-target"
              forChoice
              index={index}
              kind="stage"
              value={insertTarget}
              onChange={setInsertTarget}
              disabled={disabled}
              emptyLabel={t('graph:action.choice.none')}
            />
            <div className="advanced-field__actions">
              <Button size="sm" onClick={closeForms}>{t('common:dialog.cancel.label')}</Button>
              <Button size="sm" variant="primary" disabled={disabled} onClick={applyInsert}>{t('graph:action.choice.insert')}</Button>
            </div>
          </div>
        )}

        {retargeting !== null && (
          <div className="advanced-field__form">
            <p className="advanced-field__note">
              {t('graph:action.choice.retarget', { ordinal: retargeting + 1 })}
            </p>
            <label htmlFor="advanced-retarget-target">{t('graph:action.choice.target')}</label>
            <NodePicker
              id="advanced-retarget-target"
              forChoice
              index={index}
              kind="stage"
              value={retargetTo}
              onChange={setRetargetTo}
              disabled={disabled}
              emptyLabel={t('graph:action.choice.none')}
            />
            <div className="advanced-field__actions">
              <Button size="sm" onClick={closeForms}>{t('common:dialog.cancel.label')}</Button>
              <Button size="sm" variant="primary" disabled={disabled} onClick={applyRetarget}>{t('graph:action.choice.change')}</Button>
            </div>
          </div>
        )}
      </section>

      {/* Qui ouvre la liste, après ses choix, dans l'ordre du graphe :
          l'Écran d'origine, puis le choix sur lequel il arrive. Par HOME,
          les Écrans qui arrivent sur un même choix sont groupés. */}
      <section className="card advanced-editor__section">
        <div className="advanced-editor__section-heading advanced-editor__section-heading--list">
          <div className="card-title">{t('graph:action.arrivals.title')}</div>
          {onViewConnections && (
            <button type="button" className="advanced-link" onClick={() => onViewConnections(inspected.path)}>{t('graph:connections.reveal.label')}</button>
          )}
        </div>

        {/* Seuls les accès qui existent sont montrés, comme dans le panneau
            d'un Écran : une sortie sans Écran n'a pas de ligne. */}
        {provenance.ok.length + provenance.home.total === 0 && (
          <p className="advanced-field__warning">{t('graph:action.arrivals.empty')}</p>
        )}

        {provenance.ok.length > 0 && (
          <>
            <div className="advanced-options__subhead">
              {t('graph:action.arrivals.caption', { opener: t(OPENER_SLOT_LABELS.ok), stages: ecrans(provenance.ok.length) })}
            </div>
            <ol className="advanced-options">
              {provenance.ok.map((row) => (
                <ProvenanceRow
                  key={row.key}
                  row={row}
                  slot="ok"
                  actionId={action.id}
                  choices={choices}
                  disabled={disabled}
                  thumbnails={thumbnails}
                  onGesture={onGesture}
                  onFocusPath={onFocusPath}
                />
              ))}
            </ol>
          </>
        )}

        {provenance.home.total > 0 && (
          <div className="advanced-options__subhead">
            {t('graph:action.arrivals.caption', { opener: t(OPENER_SLOT_LABELS.home), stages: ecrans(provenance.home.total) })}
          </div>
        )}
        {provenance.home.total > 0 && (
          <ol className="advanced-options">
            {provenance.home.groups.map((group) => (group.rows.length === 1 ? (
              <ProvenanceRow
                key={group.rows[0].key}
                row={group.rows[0]}
                slot="home"
                actionId={action.id}
                choices={choices}
                disabled={disabled}
                thumbnails={thumbnails}
                onGesture={onGesture}
                onFocusPath={onFocusPath}
              />
            ) : (
              <HomeGroup
                key={group.landing.key}
                group={group}
                total={options.length}
                thumbnails={thumbnails}
                onFocusPath={onFocusPath}
              />
            )))}
          </ol>
        )}

        <div className="advanced-field__actions">
          <Button size="sm" disabled={disabled} onClick={() => { closeForms(); setWiring('ok'); }}>
            <Plus />{t('graph:action.wire.open')}</Button>
        </div>
        {wiring && (
          <WireForm
            initialSlot={wiring}
            index={index}
            action={action}
            disabled={disabled}
            onGesture={onGesture}
            onClose={closeForms}
          />
        )}
      </section>

      <details className="advanced-editor__technical">
        <summary>{t('graph:stage.technical.title')}</summary>
      <section className="advanced-editor__section">
        <h3>{t('graph:stage.layout.title')}</h3>
        <dl className="advanced-editor__identity">
          {/* Un nœud n'a qu'une position, celle du graphe à plat. */}
          <dt>{t('graph:stage.layout.position')}</dt>
          <dd>{Math.round(action.layout.x)}, {Math.round(action.layout.y)}</dd>
        </dl>
      </section>
      </details>

      {/* Le même encadré que l'éditeur libre : la corbeille animée, et le
          texte qui dit ce que la suppression emporte. La confirmation reste
          celle du graphe. */}
      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            disabled={disabled}
            onClick={onDelete}
            aria-label={t('graph:action.remove.label')}
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">{t('graph:action.remove.label')}</span>
          <p className="card-danger-desc">{t('graph:action.remove.description')}</p>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={menuActions(menu.rank)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
