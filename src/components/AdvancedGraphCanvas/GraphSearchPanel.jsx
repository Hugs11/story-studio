// La liste de recherche — chemin **principal** d'accès au graphe, pas un
// complément du canvas.
//
// Un rendu canvas n'expose rien au DOM. Cette liste est donc le seul endroit où
// un lecteur d'écran, une navigation au clavier et une recherche textuelle
// atteignent réellement les nœuds — y compris ceux que le viewport ne dessine
// pas au zoom courant, et y compris les nœuds détachés.

import { useEffect, useMemo, useRef, useState } from 'react';

import { moveListFocus, SEARCH_SCOPES } from '../../store/advancedGraphView/graphSearch.js';
import { WORKSPACE_MODE_ADVANCED } from '../../store/projectWorkState.js';
import { NodeIcon } from '../icons/NodeIcon.jsx';
import { X } from '../icons/LucideLocal.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { StructureActionsBar, StructureSearchButton } from '../structure/StructureActionsBar.jsx';
import {
  buildUsedNodeColors,
  matchesNodeColor,
  toggleNodeColorFilter,
} from '../tree/nodeColorFilter.js';
import { TreeSearchBar } from '../TreePanel/TreeSearchBar.jsx';
import { useAdvancedNodeThumbnails } from './useAdvancedNodeThumbnails.js';
import './GraphSearchPanel.css';

const LIST_ID = 'advanced-search-results';
const NOOP = () => {};

function optionId(path) {
  return `advanced-option-${encodeURIComponent(path)}`;
}

function nodeIdentifier(entry) {
  return entry.node.uuid ?? entry.node.id ?? '';
}

// L'Écran racine ouvre toujours la liste, quelle que soit sa place dans le
// document : c'est par lui que l'écoute commence, et il doit se trouver sans
// chercher. Il ne remonte que s'il fait partie des résultats.
function pinRootFirst(found, rootPath) {
  if (!rootPath) return found;
  const index = found.results.findIndex((result) => result.path === rootPath);
  if (index <= 0) return found;
  const results = [
    found.results[index],
    ...found.results.slice(0, index),
    ...found.results.slice(index + 1),
  ];
  return { ...found, results };
}

function occurrenceLabel(entry) {
  if (entry.node.uniqueId !== false) return '';
  const occurrence = entry.path.match(/#(\d+)$/)?.[1];
  return occurrence === undefined ? '' : ` · occurrence ${Number(occurrence) + 1}`;
}

// `summary` — le décompte de la liste — occupe la place libre à gauche de la
// barre, au lieu d'une ligne à part sous elle.
export function GraphNodeListActions({
  onSearch,
  onClose,
  summary = null,
  dragHandleProps = {},
}) {
  return (
    <header
      className="structure-panel-header structure-panel-header--actions"
      {...dragHandleProps}
    >
      <StructureActionsBar
        variant="panel"
        ariaLabel="Outils de la liste des nœuds"
        leading={summary}
        trailing={(
          <>
            <StructureSearchButton
              label="Rechercher dans la liste des nœuds"
              onClick={onSearch}
            />
            <Tooltip text="Masquer la liste des nœuds" placement="below">
              <button
                type="button"
                className="structure-actions-btn"
                aria-label="Masquer la liste des nœuds"
                onClick={onClose}
              >
                <X className="structure-actions-icon" aria-hidden="true" />
              </button>
            </Tooltip>
          </>
        )}
      />
    </header>
  );
}

// Lignes rendues d'un coup, puis par paliers. La liste n'en matérialise
// qu'une fenêtre — un profil à 9 121 nœuds ne doit pas peindre 9 121 lignes —
// mais la fenêtre **s'ouvre** : au clavier quand le parcours la dépasse, à la
// demande sinon. Une borne dure de 200 résultats rendait le reste de la liste
// définitivement inatteignable, sur la seule voie d'accès clavier au graphe.
const PAGE_SIZE = 200;

// `entry` — l'état de l'Écran d'entrée du pack. Quand il est unique, l'Écran
// racine est épinglé en tête de liste et porte le badge « racine ». Sans
// racine unique, aucun Écran n'est présenté comme tel.
export default function GraphSearchPanel({
  search,
  focus,
  onFocusPath,
  // Ouverture du menu contextuel au clavier, sur le nœud courant de la liste.
  onContextMenuRequest = null,
  counts,
  project = null,
  entry = null,
  searchActive = false,
  onSearchActiveChange = NOOP,
  searchFocusTrigger = 0,
  // Barre d'outils montée par l'hôte au-dessus de la liste. Elle reçoit le
  // décompte ; sans elle, la liste le rend elle-même sur sa propre ligne.
  renderHeader = null,
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState(SEARCH_SCOPES.ALL);
  const [selectedColors, setSelectedColors] = useState(() => new Set());
  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  const listRef = useRef(null);
  const searchInputRef = useRef(null);
  const pendingSearchFocusRef = useRef(false);

  // La recherche rend **tout** ce qu'elle trouve ; c'est le rendu, et lui
  // seul, qui est fenêtré. Le clavier parcourt donc la liste entière.
  const baseFound = useMemo(
    () => search({ query, scope, limit: Number.MAX_SAFE_INTEGER }),
    [search, query, scope],
  );
  const allColors = useMemo(
    () => buildUsedNodeColors(
      search({ query: '', scope: SEARCH_SCOPES.ALL, limit: Number.MAX_SAFE_INTEGER })
        .results.map((entry) => entry.node.personalColor),
    ),
    [search],
  );
  const rootPath = entry?.status === 'unique' ? entry.stagePath ?? null : null;
  const found = useMemo(() => {
    if (selectedColors.size === 0) return pinRootFirst(baseFound, rootPath);
    const results = baseFound.results.filter((entry) => (
      matchesNodeColor(entry.node.personalColor, selectedColors)
    ));
    return pinRootFirst({ results, total: results.length, truncated: false }, rootPath);
  }, [baseFound, selectedColors, rootPath]);
  const focusIndex = useMemo(
    () => (focus ? found.results.findIndex((result) => result.path === focus) : -1),
    [found.results, focus],
  );
  // La fenêtre rendue : la page courante, **élargie** à ce qu'il faut pour
  // contenir le nœud désigné. C'est un calcul de rendu et non un effet : un
  // `aria-activedescendant` qui ne devient valide qu'au tour suivant désigne,
  // le temps d'une image, un élément que rien ne trouve.
  const effectiveWindow = Math.max(
    windowSize,
    focusIndex >= 0 ? Math.ceil((focusIndex + 1) / PAGE_SIZE) * PAGE_SIZE : 0,
  );
  const visible = useMemo(
    () => found.results.slice(0, effectiveWindow),
    [found.results, effectiveWindow],
  );
  const thumbnailUrls = useAdvancedNodeThumbnails(project, visible);

  // Une nouvelle recherche repart de la première page.
  useEffect(() => { setWindowSize(PAGE_SIZE); }, [query, scope, selectedColors]);

  useEffect(() => {
    if (searchFocusTrigger <= 0) return;
    pendingSearchFocusRef.current = true;
    onSearchActiveChange?.(true);
  }, [searchFocusTrigger, onSearchActiveChange]);

  useEffect(() => {
    if (!searchActive || !pendingSearchFocusRef.current || !searchInputRef.current) return;
    pendingSearchFocusRef.current = false;
    searchInputRef.current.focus();
    searchInputRef.current.select();
  }, [searchActive]);

  const clearSearch = () => {
    setQuery('');
    setScope(SEARCH_SCOPES.ALL);
    setSelectedColors(new Set());
    onSearchActiveChange?.(false);
  };

  useEffect(() => {
    if (!focus || !listRef.current) return;
    const active = listRef.current.querySelector(`#${CSS.escape(optionId(focus))}`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [focus, effectiveWindow]);

  const scopeLabels = [
    [SEARCH_SCOPES.ALL, 'Tout', false],
    [SEARCH_SCOPES.STAGES, 'Écrans', false],
    [SEARCH_SCOPES.ACTIONS, 'Listes de choix', false],
  ];

  // Le descendant actif ne peut désigner qu'une ligne **présente** dans le
  // document : au-delà de la fenêtre, l'attribut viserait un identifiant que
  // la technologie d'assistance ne trouverait pas.
  const activeDescendant = focus && focusIndex >= 0 && focusIndex < effectiveWindow
    ? optionId(focus)
    : undefined;

  // Flèches et Début/Fin parcourent la liste ; Entrée cadre le nœud. Le
  // parcours de la liste ne déplace pas la caméra : seule la validation le
  // fait, et elle reste un geste de vue de l'auteur.
  const onKeyDown = (event) => {
    const moves = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: 10,
      PageUp: -10,
    };
    if (event.key in moves) {
      event.preventDefault();
      const next = moveListFocus(found.results, focus, moves[event.key]);
      if (next) onFocusPath(next, { center: false });
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? found.results[0] : found.results.at(-1);
      if (target) onFocusPath(target.path, { center: false });
      return;
    }
    if (event.key === 'Enter' && focus) {
      event.preventDefault();
      onFocusPath(focus, { center: true });
      return;
    }
    // Ouvrir le menu contextuel **au clavier**, sur le nœud courant de la
    // liste.
    //
    // Le menu doit être utilisable au clavier. Le canvas, lui, vise le
    // nœud sous le pointeur, et il le demande au moteur — qui ne connaît de
    // survol que celui d'une vraie souris. Sans cette porte, il n'existait
    // donc **aucune** façon d'ouvrir le menu sans pointeur : le parcours
    // clavier pouvait atteindre chaque nœud de la liste et rien en faire.
    //
    // Shift+F10 et la touche Menu sont les deux raccourcis que les
    // environnements de bureau donnent au menu contextuel ; la liste les
    // reprend telles quelles plutôt que d'en inventer une troisième.
    if (onContextMenuRequest && focus
      && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      event.preventDefault();
      // Le menu est posé sur la ligne visée, pas au coin de l'écran : il doit
      // sortir de ce que l'auteur regarde.
      const row = listRef.current?.querySelector('[data-focused="true"]');
      const box = row?.getBoundingClientRect() ?? null;
      onContextMenuRequest({
        path: focus,
        x: box ? Math.round(box.left + box.width / 2) : 0,
        y: box ? Math.round(box.bottom) : 0,
      });
    }
  };

  const summary = (
    <p className="advanced-search__count" aria-live="polite">
      {/* Les comptes sont ceux du document entier, et une recherche dit
          combien de nœuds elle trouve. Ce qui reste à afficher est dit par
          le bouton de fin de liste, pas répété ici. */}
      {counts
        ? `${counts.stages} Écran${counts.stages === 1 ? '' : 's'} · ${counts.actions} liste${counts.actions === 1 ? '' : 's'} de choix · ${counts.edges} lien${counts.edges === 1 ? '' : 's'}`
        : `${found.total} résultat${found.total === 1 ? '' : 's'}`}
      {(query || scope !== SEARCH_SCOPES.ALL || selectedColors.size > 0)
        && ` · ${found.total} trouvé${found.total === 1 ? '' : 's'}`}
    </p>
  );

  return (
    <>
      {renderHeader?.(summary)}
      <section className="advanced-search" aria-label="Liste des nœuds du graphe">
        {searchActive && (
          <>
            <TreeSearchBar
              searchTerm={query}
              setSearchTerm={setQuery}
              setSearchActive={(active) => {
                if (!active && scope !== SEARCH_SCOPES.ALL) return;
                onSearchActiveChange(active);
              }}
              inputRef={searchInputRef}
              usedColors={allColors}
              selectedColors={selectedColors}
              onToggleColor={(color) => setSelectedColors((current) => (
                toggleNodeColorFilter(current, color)
              ))}
              onClearSearch={clearSearch}
            >
              <div className="advanced-search__scopes" role="group" aria-label="Filtrer">
                {scopeLabels.map(([value, label, warning]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={scope === value}
                    className="advanced-search__scope"
                    data-warning={warning ? 'true' : undefined}
                    onClick={() => setScope(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </TreeSearchBar>
          </>
        )}

        {!renderHeader && summary}

        <ul
          id={LIST_ID}
          ref={listRef}
          className="advanced-search__list"
          role="listbox"
          tabIndex={0}
          aria-label="Nœuds du graphe"
          aria-activedescendant={activeDescendant}
          onKeyDown={onKeyDown}
        >
          {visible.length === 0 && (
            <li className="advanced-search__empty" role="presentation">
              Aucun nœud ne correspond à cette recherche.
            </li>
          )}
          {visible.map((result) => (
            <li
              key={result.path}
              id={optionId(result.path)}
              role="option"
              aria-selected={result.path === focus}
              className={`advanced-search__item${result.node.personalColor ? ' has-personal-color' : ''}`}
              style={result.node.personalColor
                ? { '--node-personal-color': result.node.personalColor }
                : undefined}
              data-kind={result.kind}
              data-focused={result.path === focus ? 'true' : undefined}
              onClick={() => onFocusPath(result.path, { center: true })}
              onContextMenu={onContextMenuRequest ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenuRequest({
                  path: result.path,
                  x: event.clientX,
                  y: event.clientY,
                });
              } : undefined}
            >
              {/* Le dessin de la nature, pris dans la table commune aux deux
                  editeurs. Il remplace la lettre dans un carre : l'arbre
                  portait deja une icone, et la liste du graphe ne doit pas
                  porter un « E » ou un « A » a la place.
                  Ce sont les deux dessins que le canvas peint juste a cote — le
                  cadre pour l'Ecran, l'aiguillage pour l'Action —, pour que
                  la liste et le graphe ne proposent pas deux facons de
                  reconnaitre un noeud. Le dessin reste **muet** : le libelle qui
                  le suit est la source, et l'icone accompagne. */}
              <span
                className={`advanced-search__icon${thumbnailUrls.has(result.path) ? ' has-thumbnail' : ''}`}
                style={thumbnailUrls.has(result.path)
                  ? { backgroundImage: `url(${thumbnailUrls.get(result.path)})` }
                  : undefined}
              >
                {!thumbnailUrls.has(result.path) && (
                  <NodeIcon workspaceMode={WORKSPACE_MODE_ADVANCED} nature={result.kind} />
                )}
              </span>
              <span className="advanced-search__identity">
                <span className="advanced-search__name">
                  {result.label.label}
                  {result.label.isFallback && <em className="advanced-search__fallback"> (sans nom)</em>}
                </span>
                <span className="advanced-search__identifier">
                  {result.kind === 'stage' ? 'Écran' : 'Liste de choix'} · {nodeIdentifier(result)}
                  {occurrenceLabel(result)}
                </span>
              </span>
              {result.path === rootPath && (
                <Tooltip text="Écran d’entrée : le pack commence ici" asChild>
                  <span className="advanced-search__root-badge">racine</span>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
        {visible.length < found.total && (
          // La suite de la liste reste atteignable : au clavier elle s'ouvre
          // toute seule quand le parcours la dépasse, et à la souris par ce
          // bouton. Le compte restant est dit, pas deviné.
          <button
            type="button"
            className="advanced-search__more"
            onClick={() => setWindowSize((size) => size + PAGE_SIZE)}
          >
            Afficher {Math.min(PAGE_SIZE, found.total - visible.length)} nœuds de plus
            <span> · {found.total - visible.length} restants</span>
          </button>
        )}
      </section>
    </>
  );
}
