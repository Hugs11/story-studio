// Machine de fraîcheur de l'éditeur avancé.
//
// Trois compteurs, et un seul d'entre eux gouverne la lecture :
//
// - `projectEpoch` compte les **remplacements** du travail courant. Il existe
//   déjà dans le store (`workEpochRef`) ; ce module en reprend la valeur, il
//   n'en tient pas une seconde.
// - `documentRevision` compte les changements de **valeur** du travail courant.
// - `viewRevision` compte la caméra, la sélection, le focus et la
//   prévisualisation d'un glisser. Il vit hors du projet et hors de
//   l'historique.
//
// La règle qui porte tout le reste : **la lecture est déclenchée par le ticket
// de document, jamais par la vue**. Un panoramique ou un zoom ne provoquent ni
// redécodage, ni readiness, ni revalidation. C'est aussi la première condition
// de tenue sur les très gros packs.

// Les événements qui font avancer la **valeur** du travail : ils périment les
// réponses en vol et déclenchent une relecture.
export const DOCUMENT_EVENTS = Object.freeze({
  AUTHOR_GESTURE: 'author-gesture',
  UNDO: 'undo',
  REDO: 'redo',
  DRAG_COMMITTED: 'drag-committed',
  REINSTALLED: 'reinstalled',
});

// Les événements qui ne font avancer que la **vue** : aucun ne rend le projet
// modifié, aucun n'entre dans l'historique.
export const VIEW_EVENTS = Object.freeze({
  PAN: 'pan',
  ZOOM: 'zoom',
  SELECTION: 'selection',
  FOCUS: 'focus',
  DRAG_PREVIEW: 'drag-preview',
});

// Les événements qui ne font avancer aucun compteur. Les nommer évite qu'un
// appelant en déduise « alors c'est une mutation » et fasse avancer une
// révision pour un relevé de disque ou une sauvegarde sans changement.
export const NEUTRAL_EVENTS = Object.freeze({
  BINDING_AUDIT: 'binding-audit',
  SAVE: 'save',
  SAVE_AS: 'save-as',
  AUTOSAVE: 'autosave',
  EXPORT: 'export',
});

const DOCUMENT_EVENT_VALUES = new Set(Object.values(DOCUMENT_EVENTS));
const VIEW_EVENT_VALUES = new Set(Object.values(VIEW_EVENTS));
const NEUTRAL_EVENT_VALUES = new Set(Object.values(NEUTRAL_EVENTS));

export function createTicket(projectEpoch = 0) {
  return Object.freeze({ projectEpoch, documentRevision: 0, viewRevision: 0 });
}

// Ouverture, reprise, réinitialisation : l'époque avance et les deux autres
// compteurs repartent de zéro. Un changement de projet périme donc **tout** ce
// qui est en vol, sans qu'aucun appelant ait à s'en souvenir.
export function replacedTicket(projectEpoch) {
  return createTicket(projectEpoch);
}

export function advanceTicket(ticket, event) {
  if (NEUTRAL_EVENT_VALUES.has(event)) return ticket;
  if (DOCUMENT_EVENT_VALUES.has(event)) {
    return Object.freeze({ ...ticket, documentRevision: ticket.documentRevision + 1 });
  }
  if (VIEW_EVENT_VALUES.has(event)) {
    return Object.freeze({ ...ticket, viewRevision: ticket.viewRevision + 1 });
  }
  // Un événement inconnu ne fait rien avancer : inventer une révision ferait
  // relire le graphe pour une cause que personne n'a écrite.
  return ticket;
}

// Le **ticket de document** : la paire qui gouverne la lecture, la readiness et
// les gestes. La révision de vue n'en fait pas partie, et c'est tout l'objet du
// ticket : la caméra ne déclenche aucun travail sur le document.
export function documentTicket(ticket) {
  return Object.freeze({
    projectEpoch: ticket.projectEpoch,
    documentRevision: ticket.documentRevision,
  });
}

// Une réponse périmée est ignorée, **sans erreur** : elle n'est ni installée,
// ni affichée, ni comptée comme un échec.
export function isDocumentTicketCurrent(captured, current) {
  if (!captured || !current) return false;
  return captured.projectEpoch === current.projectEpoch
    && captured.documentRevision === current.documentRevision;
}

// Vrai quand la réponse concerne un **autre projet**, et non simplement un état
// plus récent du même. Les deux sont ignorés, mais seul le second mérite une
// nouvelle lecture immédiate : après un changement de projet, la vue est
// démontée et reconstruite de toute façon.
export function isForeignProject(captured, current) {
  if (!captured || !current) return true;
  return captured.projectEpoch !== current.projectEpoch;
}

// Un seul geste en vol.
//
// La file ne capture **jamais** un payload : au moment de l'envoi, le geste
// relit le payload de la dernière valeur acceptée. C'est la seule façon
// d'éviter qu'un geste parte avec un payload antérieur à une réponse qui n'a
// pas encore été appliquée.
export function createGestureQueue() {
  let inFlight = false;
  let pending = null;

  return {
    get busy() {
      return inFlight;
    },
    get pendingIntent() {
      return pending;
    },
    // `intent` est une **intention** : une description de ce que l'auteur
    // demande, résolue contre le payload courant au moment de l'envoi.
    enqueue(intent) {
      if (!inFlight) {
        inFlight = true;
        return { send: intent };
      }
      // Une seconde demande remplace la précédente en attente plutôt que de
      // s'empiler : l'auteur veut le dernier état demandé, pas une rediffusion
      // de tous les états intermédiaires.
      pending = intent;
      return { send: null, queued: true };
    },
    settle() {
      inFlight = false;
      if (pending === null) return { send: null };
      const next = pending;
      pending = null;
      inFlight = true;
      return { send: next };
    },
    reset() {
      inFlight = false;
      pending = null;
    },
  };
}
