// Un seul travail de génération native à la fois — Libre ou avancé.
//
// La raison n'est pas une préférence d'interface : côté Rust, `generate_pack`
// et `export_advanced_pack` partagent **le même** canal d'événements
// `generate-log` et **le même** drapeau d'annulation, que `cancel_generate_pack`
// bascule. Un export et une génération Libre ne doivent donc pas être pilotés
// comme deux travaux indépendants partageant ce drapeau. Menés de front, la
// progression de l'un s'écrirait dans le journal de l'autre, et une annulation
// demandée pour l'un arrêterait les deux.
//
// Le verrou vit **hors React** parce qu'il est plus large qu'un composant : le
// panneau de file de rendu se démonte au changement de projet et l'espace de
// travail avancé se monte à sa place, alors que le travail natif, lui,
// continue. Un état porté par un composant aurait disparu au mauvais moment.
//
// Il ne fait qu'une chose : dire qui tient le poste. Il n'envoie aucune
// commande, n'écoute aucun événement et ne connaît ni la file de rendu ni
// l'export ; ce sont eux qui viennent le prendre et le rendre.

export const GENERATION_OWNER_FREE = 'free';
export const GENERATION_OWNER_ADVANCED = 'advanced';

export function createNativeGenerationLock() {
  let holder = null;
  const listeners = new Set();

  function notify() {
    for (const listener of [...listeners]) listener(holder);
  }

  return {
    // Ce que tient le poste, ou `null`. Lu — jamais déduit d'un compteur de
    // jobs : un job « en cours » dans un store peut avoir été abandonné par son
    // exécuteur, le verrou, lui, est rendu dans un `finally`.
    get holder() {
      return holder;
    },

    // Rend une prise, ou `null` si le poste est déjà tenu. L'appelant qui
    // reçoit `null` ne démarre pas : il n'y a pas de file d'attente ici, parce
    // que ce qu'il faut faire d'un refus dépend de l'appelant — la file de
    // rendu laisse son job en attente, l'export le dit à l'auteur.
    acquire({ owner, label = null } = {}) {
      if (holder !== null) return null;
      let released = false;
      holder = { owner, label };
      notify();
      return {
        owner,
        label,
        // Idempotent : un `finally` peut suivre une libération déjà faite, et
        // un second appel ne doit pas relâcher la prise du **suivant**.
        release() {
          if (released) return;
          released = true;
          holder = null;
          notify();
        },
      };
    },

    // Réveil des candidats à la libération. C'est ce qui permet à la file de
    // rendu de reprendre un job laissé en attente sans interroger le verrou en
    // boucle.
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// L'instance du processus. Le poste de travail natif est unique par
// application : deux instances feraient exactement le défaut que ce module
// existe pour empêcher.
export const nativeGenerationLock = createNativeGenerationLock();
