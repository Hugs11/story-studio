// La session d'édition de l'Éditeur avancé : ce qui part, ce qui revient, et ce
// qui est jeté sans bruit.
//
// Elle est **sans framework** — aucun import React — comme la session de vue,
// pour que les règles de fraîcheur soient éprouvables sans monter
// d'interface. Le hook qui l'enveloppe ne fait que la brancher sur un rendu.
//
// Quatre règles portent tout le fichier :
//
// 1. **Un seul geste en vol.** Une seconde commande est empêchée à la source —
//    `run` rend `busy` et n'envoie rien — sauf pour les intentions continues,
//    où `coalesce` remplace la demande en attente au lieu de rejouer tous les
//    états intermédiaires d'un glisser.
// 2. **La file ne capture jamais un payload.** Une intention est une fonction
//    du projet courant, résolue au moment de l'envoi contre la **dernière
//    valeur acceptée**, jamais contre celle qui avait cours quand l'auteur a
//    cliqué.
// 3. **Une réponse périmée est ignorée, sans erreur.** Elle n'est ni installée,
//    ni affichée, ni comptée comme un échec. Un changement de projet et un undo
//    périment de la même façon ; seul le premier est un autre travail.
// 4. **Un verrou d'auteur suspend les mutations, pas la vue**.
//    Pendant un export, le document est celui qu'on est en train d'écrire :
//    aucune mutation ne part, ce qui était déjà en vol est attendu, et
//    panoramique, zoom, sélection et relecture restent libres.

import { createGestureQueue } from '../advancedGraphView/viewTicket.js';

export const GESTURE_APPLIED = 'applied';
export const GESTURE_REFUSED = 'refused';
export const GESTURE_BUSY = 'busy';
export const GESTURE_STALE = 'stale';
export const GESTURE_QUEUED = 'queued';
// Le verrou d'auteur. Il n'est pas un « occupé » de plus : `busy` dit qu'un
// geste est en vol et se lève seul, `held` dit qu'un travail plus large —
// l'export — a pris la main sur le document et ne le rendra qu'à sa fin. Les
// confondre ferait repartir une mutation au milieu d'un export, sur la révision
// même qui est en train d'être écrite.
export const GESTURE_HELD = 'held';

// Vrai quand le geste n'a pas touché au document : refusé, ou tenu par le
// verrou d'auteur. Le canvas qui a déjà peint un glisser doit alors revenir
// aux positions du document, sinon la carte reste où le pointeur l'a lâchée.
export function documentUntouchedBy(outcome) {
  return outcome?.status === GESTURE_REFUSED || outcome?.status === GESTURE_HELD;
}

// Une intention porte **soit** un geste déjà assemblé (`{ gesture }`), **soit**
// une fonction du projet courant (`{ kind, build }`). La seconde forme est ce
// que la règle 2 exige d'une file : un geste de position mis en attente
// derrière un autre doit repartir du projet qui aura été accepté entre-temps,
// pas de celui que l'auteur regardait.
//
// L'enveloppe `{ gesture }` n'est pas une commodité : un geste porte lui-même
// un champ `gesture` — son nom — et accepter aussi le geste nu rendrait les deux
// formes indiscernables. Le nom serait alors envoyé à la place de la demande.
function resolveGesture(intent, project) {
  if (typeof intent?.build === 'function') return intent.build(project);
  return intent?.gesture ?? null;
}

export function createAdvancedAuthoringSession({
  readProject,
  // Le **ticket de document** : l'époque du travail courant et la
  // révision d'auteur — payload **et** chemins de liaisons. Il ne compte pas
  // l'objet projet : l'audit disque des liaisons en remplace l'identité sans
  // toucher au document, et il est explicitement neutre pour cette machine.
  // Juger la fraîcheur sur l'objet ferait donc jeter un geste parfaitement
  // valide chaque fois qu'un relevé de disque tombe pendant son vol.
  //
  // Juger sur le payload seul, à l'inverse, laissait passer une réponse
  // tardive après l'annulation d'un remplacement média : `assetRef` appartient
  // au payload et ne bouge pas, seul le chemin de la liaison change.
  readTicket,
  applyGesture,
  commit,
  onChange = () => {},
} = {}) {
  const queue = createGestureQueue();
  let refusal = null;
  let lastReport = null;
  let busyIntent = null;
  let held = null;
  // Les attentes de repos. `whenIdle` est ce que l'export appelle après avoir
  // posé le verrou : il ne capture le document qu'une fois revenu ce qui était
  // déjà parti.
  let idleWaiters = [];

  function state() {
    return {
      busy: queue.busy,
      busyIntent,
      queuedIntent: queue.pendingIntent,
      refusal,
      lastReport,
      held,
    };
  }

  function releaseIdleWaiters() {
    if (idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
  function emit() {
    onChange(state());
  }

  // Un envoi et un seul retour. La capture de fraîcheur est faite **avant**
  // l'appel et relue **après** : c'est la seule façon de distinguer « ce
  // résultat concerne encore ce travail » de « il concerne un état que l'auteur
  // a déjà quitté », et les deux se produisent pendant les ≈ 190 ms que le lot
  // 04 a mesurées sur le profil extrême.
  async function send(intent) {
    const project = readProject();
    const captured = readTicket();
    const current = () => {
      const now = readTicket();
      return now.projectEpoch === captured.projectEpoch && now.document === captured.document;
    };
    busyIntent = intent;
    refusal = null;
    emit();
    let outcome;
    try {
      outcome = await applyGesture(project, resolveGesture(intent, project));
    } catch (error) {
      if (!current()) return { status: GESTURE_STALE };
      refusal = { intent, error };
      return { status: GESTURE_REFUSED, error };
    }
    // Le refus d'un geste laisse le projet précédent intact : rien n'a été
    // installé au-dessus, et la restauration visuelle n'a donc rien à défaire
    // dans le document.
    if (!current()) return { status: GESTURE_STALE };
    // Le projet rendu voyage avec le rapport : un undo passe par l'historique
    // du store, pas par ici, et l'interface doit pouvoir taire un rapport que
    // le document courant ne reflète plus.
    lastReport = { intent, report: outcome.report, project: outcome.project };
    commit({ project: outcome.project, report: outcome.report, intent });
    return { status: GESTURE_APPLIED, report: outcome.report, project: outcome.project };
  }

  async function drain(intent) {
    let pending = intent;
    let first = null;
    while (pending) {
      const outcome = await send(pending);
      if (first === null) first = outcome;
      busyIntent = null;
      const next = queue.settle();
      pending = next.send;
      if (!pending) break;
    }
    releaseIdleWaiters();
    emit();
    return first;
  }

  return {
    get state() {
      return state();
    },

    // Geste discret : refusé à la source tant qu'un autre est en vol. C'est la
    // première branche de la règle du geste unique — la commande est désactivée
    // dans l'interface, et ce retour est le filet d'un clic parti entre deux rendus.
    async run(intent) {
      if (held !== null) return { status: GESTURE_HELD, reason: held };
      if (queue.busy) return { status: GESTURE_BUSY };
      queue.enqueue(intent);
      return drain(intent);
    },

    // Intention continue — la fin d'un glisser, relancée avant que la
    // précédente soit revenue. La demande en attente est remplacée : l'auteur
    // veut la dernière position, pas la trace de toutes celles qu'il a
    // traversées.
    async coalesce(intent) {
      if (held !== null) return { status: GESTURE_HELD, reason: held };
      const admission = queue.enqueue(intent);
      if (!admission.send) {
        emit();
        return { status: GESTURE_QUEUED };
      }
      return drain(admission.send);
    },

    // Verrou d'auteur : l'export prend le document, la vue reste libre. Le
    // verrou ne jette rien de ce qui est déjà en vol — il empêche seulement ce
    // qui n'est pas encore parti.
    hold(reason = 'export') {
      if (held !== null) return false;
      held = reason;
      emit();
      return true;
    },

    releaseHold() {
      if (held === null) return false;
      held = null;
      emit();
      return true;
    },

    // Résolue quand plus aucun geste n'est en vol ni en attente. Immédiate
    // quand la session est déjà au repos : attendre un tour de boucle pour rien
    // laisserait une fenêtre où un geste pourrait encore partir.
    whenIdle() {
      if (!queue.busy && queue.pendingIntent === null) return Promise.resolve();
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    },

    clearRefusal() {
      if (refusal === null) return;
      refusal = null;
      emit();
    },

    // Changement de projet : ce qui est en vol devient périmé de lui-même par
    // la garde d'époque. La file, elle, doit être vidée — une intention en
    // attente désigne un document qui n'est plus ouvert.
    reset() {
      queue.reset();
      busyIntent = null;
      refusal = null;
      lastReport = null;
      // Le verrou n'est pas levé ici : un changement de projet pendant un
      // export ne rend pas le document au clavier de l'auteur. C'est la fin de
      // l'export, et elle seule, qui relâche.
      releaseIdleWaiters();
      emit();
    },
  };
}
