// La couche HTML posée au-dessus du canvas : noms, pastilles, bandeaux de
// groupe et repères de la vue éloignée.
//
// Elle existe parce que le canvas est muet : rien n'y est exposé au DOM, et
// tout ce qui est texte, badge ou libellé doit être dessiné ici, positionné
// depuis la caméra du moteur. Elle travaille en **pixels écran**, ce qui est
// exactement ce qui manquait aux repères de la planche 3b : une largeur
// Cytoscape est une unité du graphe, donc un anneau de 56 unités mesure 0,56
// pixel à 1 % de zoom.

import { Tooltip } from '../common/Tooltip.jsx';
import { Check, House, Plus } from '../icons/LucideLocal.jsx';
import { GRAPH_LINK_PORTS } from '../../store/advancedAuthoring/graphLinkDraft.js';
import { farLandmarkMarks } from './farLandmarks.js';
import { PORT_OVERHANG } from './engines/engineContract.js';
import {
  actionCountFontPx, linkHandlePx, nodeLabelWidthPx, portDotPx, REVEALED_HANDLE, revealedHandleOffset,
} from './nodeOverlayMetrics.js';


function nodeBadge(node) {
  return node.isEntry ? { label: 'RACINE', tone: 'entry' } : null;
}

// La prise peinte qui correspond à une entrée de la liste fonctionnelle.
//
// Le moteur publie la géométrie, le modèle publie ce qui est raccordable : les
// deux se rejoignent par l'identifiant, et par l'ordinal pour une Action, dont
// la prise d'ajout occupe le dernier cran du rail. Rien n'est mesuré dans le
// document, donc rien ne peut glisser d'une image à l'autre.
function portAnchor(node, port) {
  const published = node.ports ?? null;
  if (!published) return null;
  if (port.id === GRAPH_LINK_PORTS.ACTION_OPTION) {
    const options = published.filter((candidate) => candidate.ordinal !== null);
    if (options.length === 0) return null;
    const wanted = Number(port.suggestedIndex);
    return options.find((candidate) => candidate.ordinal === wanted)
      ?? options[options.length - 1];
  }
  return published.find((candidate) => candidate.id === port.id) ?? null;
}

function LinkPortIcon({ id }) {
  if (id === GRAPH_LINK_PORTS.STAGE_OK) return <Check />;
  if (id === GRAPH_LINK_PORTS.STAGE_HOME) return <House />;
  return <Plus />;
}

export function GraphNodeOverlays({
  overlay,
  onLinkPortPointerDown = null,
  onInactiveLinkPort = null,
  // Un clic sur un repère du régime éloigné sélectionne son nœud. Le point est
  // minuscule et les liens passent par-dessus dans le canvas : c'est la marque
  // HTML, au-dessus d'eux, qui reçoit le pointeur.
  onSelectLandmark = null,
}) {
  const {
    detailLevel = 'full', nodes = [], zoom = 1, bounds = null, viewport = null,
  } = overlay ?? {};
  const simplified = detailLevel === 'simplified';
  if (simplified) {
    const marks = farLandmarkMarks(nodes, { bounds, viewport });
    const callouts = marks.filter((mark) => mark.callout);
    const select = (path) => (event) => {
      event.stopPropagation();
      onSelectLandmark?.(path);
    };
    // La règle — qui porte un repère, de quelle sorte, avec quel texte — vient
    // de `farLandmarks`, partagée avec la capture de recette. Deux
    // transcriptions de la même intention avaient déjà divergé une fois.
    return (
      <div className="advanced-node-overlays">
        {callouts.length > 0 && (
          <svg className="advanced-landmark-callouts" aria-hidden="true">
            {callouts.map(({ node, callout }) => (
              <line key={node.path} x1={node.x} y1={node.y} x2={callout.x} y2={callout.y} />
            ))}
          </svg>
        )}
        {callouts.map(({ node, label, title, callout }) => (
          <Tooltip key={`callout-${node.path}`} text={title} asChild disabled={!title}>
            <span
              className={`advanced-landmark-callout is-${callout.side}`}
              style={{
                top: `${callout.y}px`,
                ...(callout.side === 'right'
                  ? { left: `${callout.x}px` }
                  : { right: `calc(100% - ${callout.x}px)` }),
                maxWidth: `${callout.maxWidth}px`,
              }}
              role={onSelectLandmark ? 'button' : undefined}
              onClick={onSelectLandmark ? select(node.path) : undefined}
            >
              {label}
            </span>
          </Tooltip>
        ))}
        {marks.map(({
          node, kind, count, grouped, label, title, isTag, placement, offset,
        }) => (
          // Une seule bulle pour toute la marque : son nom, et pour une marque
          // regroupée, le nombre de nœuds qu'elle couvre.
          <Tooltip
            key={node.path}
            text={grouped ? `${count} nœuds dans cette zone` : title}
            asChild
            disabled={!grouped && !title}
          >
            <div
              className={`advanced-landmark advanced-landmark--${kind}${grouped ? ' is-grouped' : ''}`}
              style={{ transform: `translate3d(${node.x}px, ${node.y}px, 0) translate(-50%, -50%)` }}
              role={onSelectLandmark ? 'button' : undefined}
              aria-label={title ?? undefined}
              onClick={onSelectLandmark ? select(node.path) : undefined}
            >
              <i />
              {/* Une marque regroupée tient lieu de plusieurs nœuds voisins :
                  elle porte leur nombre, pas leur nom. C'est ce qui borne le
                  dessin par la taille de la fenêtre au lieu de celle du pack. */}
              {grouped && (
                <span className="advanced-landmark__count">{count}</span>
              )}
              {label !== null && placement !== 'callout' && (
                <span
                  className={`${isTag ? 'advanced-landmark__tag' : 'advanced-landmark__name'} is-${placement}`}
                  style={{ '--landmark-name-offset': `${offset}px` }}
                >
                  {label}
                </span>
              )}
            </div>
          </Tooltip>
        ))}
      </div>
    );
  }
  // Les noms, compteurs et badges HTML tombent à 30 %. La silhouette, le
  // glyphe et les décorations qui doivent survivre au dézoom sont peints par
  // Cytoscape et ne consomment donc aucune des 600 surimpressions.
  const full = detailLevel === 'full';
  // Ce qu'une prise peinte déborde sous la carte, en pixels écran. Le nom se
  // pose dessous : à fort zoom, la prise du bas grandit avec la carte et
  // recouvrait un nom posé à distance fixe.
  const portOverhang = `${PORT_OVERHANG * zoom}px`;
  // Les tailles qui suivent le zoom sont posées une fois, sur la couche.
  const layerStyle = {
    '--node-label-width': `${nodeLabelWidthPx(zoom)}px`,
    '--action-count-font': `${actionCountFontPx(zoom)}px`,
    '--link-handle-size': `${linkHandlePx(zoom)}px`,
    '--port-dot-size': `${portDotPx(zoom)}px`,
    '--revealed-handle-size': `${REVEALED_HANDLE.SIZE}px`,
    '--revealed-dot-size': `${REVEALED_HANDLE.DOT}px`,
  };
  return (
    <div className="advanced-node-overlays" style={layerStyle} aria-hidden={onLinkPortPointerDown ? undefined : 'true'}>
      {nodes.map((node) => {
        const badge = nodeBadge(node);
        return (
          <div
            key={node.path}
            data-node-path={node.path}
            data-node-kind={node.kind}
            className={`advanced-node-overlay advanced-node-overlay--${node.kind}${node.isEntry ? ' is-entry' : ''}${node.dimmed ? ' is-dimmed' : ''}`}
            style={{
              '--port-overhang': portOverhang,
              width: `${node.width}px`,
              height: `${node.height}px`,
              transform: `translate3d(${node.x}px, ${node.y}px, 0) translate(-50%, -50%)`,
            }}
          >
            {full && node.kind === 'action' && (
              <Tooltip text={`${node.outgoingCount} choix dans cette liste`} asChild>
                <span className="advanced-node-overlay__action-count">
                  {node.outgoingCount}
                </span>
              </Tooltip>
            )}
            {full && badge && (
              <span className={`advanced-node-overlay__badge is-${badge.tone}`}>{badge.label}</span>
            )}
            {full && (
              <span className="advanced-node-overlay__label">{node.label}</span>
            )}
            {node.selected && <span className="advanced-node-overlay__selection" />}
            {node.ports && onLinkPortPointerDown && (
              <div className={`advanced-node-overlay__ports is-${node.kind}`}>
                {(node.linkPorts ?? []).map((port) => [port, portAnchor(node, port)]).map(([port, anchor]) => anchor && (
                  <Tooltip key={port.id} text={port.active ? portHint(port) : `${port.label} — ouvrir les contrôles`} asChild wrap>
                    <button
                      type="button"
                      style={handlePlacement(node, anchor)}
                      className={`${port.active ? 'is-active' : 'is-inactive'} is-${port.id}${port.active && port.activateControl ? ' is-activation-required' : ''}${anchor.revealed ? ' is-revealed' : ''}${isAddPort(node, port, anchor) ? ' is-add' : ''}`}
                      aria-label={port.active ? portHint(port) : `${port.label} — contrôle désactivé`}
                      onPointerDown={port.active ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onLinkPortPointerDown(event, node, port, anchor);
                      } : undefined}
                      onClick={!port.active ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onInactiveLinkPort?.(node.path, port.control);
                      } : undefined}
                    >
                      <LinkPortIcon id={port.id} />
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Où poser une poignée. Au régime normal, sur sa prise ; révélée, hors de la
// carte dans le prolongement de la prise. L'ancre du trait, elle, reste la
// prise : c'est `anchor` qui part avec le geste, pas cette position.
function handlePlacement(node, anchor) {
  const { x, y } = anchor.revealed ? revealedHandleOffset(node, anchor) : { x: anchor.dx, y: anchor.dy };
  return { left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` };
}

// La prise d'ajout d'une Liste est creuse, comme sa pastille peinte.
function isAddPort(node, port, anchor) {
  if (port.id !== GRAPH_LINK_PORTS.ACTION_OPTION) return false;
  const options = (node.ports ?? []).filter((candidate) => candidate.ordinal !== null);
  return anchor.ordinal === options.length - 1;
}

// Une prise d'Écran dont la touche est éteinte reste tirable : le raccord
// allume le bouton. L'infobulle le dit avant le geste.
function portHint(port) {
  if (!port.activateControl) return port.label;
  return `${port.label} — allume aussi le bouton ${port.slot === 'home' ? 'Accueil' : 'OK'}`;
}

function groupTone(id) {
  let hash = 0;
  for (const character of String(id)) hash = ((hash * 31) + character.codePointAt(0)) | 0;
  return Math.abs(hash) % 6;
}

export function GraphGroupOverlays({ overlay }) {
  // Sous 3 %, les zones colorées disparaissent : à ce régime la surface doit
  // porter les repères, pas des aplats qui les noient.
  if (overlay?.detailLevel === 'simplified') return null;
  return (
    <div className="advanced-group-overlays" aria-hidden="true">
      {(overlay?.groups ?? []).map((group) => (
        <div
          key={group.id}
          className={`advanced-group-overlay is-tone-${groupTone(group.id)}`}
          style={{
            width: `${group.width}px`, height: `${group.height}px`,
            transform: `translate3d(${group.x}px, ${group.y}px, 0)`,
          }}
        >
          <span>{group.id}</span>
        </div>
      ))}
    </div>
  );
}
