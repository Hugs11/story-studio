// La frontière IPC de la vue avancée, et le seul fichier du modèle qui parle à
// Tauri.
//
// La session de vue ne l'importe pas : elle reçoit ses fonctions en paramètre.
// C'est ce qui permet de l'éprouver entièrement sans Tauri, et donc de prouver
// ses règles en tests purs.
//
// Trois règles tiennent ce fichier :
//
// 1. **JavaScript n'ouvre jamais le payload.** Il le transmet comme une chaîne
//    opaque à `read_advanced_graph_view`, et reçoit une vue dérivée.
// 2. **La clé du cache n'est jamais fabriquée ici.** Le descripteur de projet
//    part tel quel ; Rust en calcule la clé, avec sa propre normalisation de
//    chemin.
// 3. **L'empreinte du document est un jeton opaque.** Elle vient de la lecture
//    du graphe et repart telle quelle vers le cache : le payload ne retraverse
//    pas l'IPC à chaque écriture de vue.

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

export function createAdvancedViewBridge({ invokeCommand = invokeTauri } = {}) {
  return {
    // Lecture dérivée du payload courant. Les refus du codec ressortent tels
    // quels : cette fonction ne les réécrit pas en codes de vue.
    readGraphView: (payload) => invokeCommand('read_advanced_graph_view', { payload }),

    // Une panne de cache n'est jamais une panne d'ouverture : l'appelant
    // reconstruit la vue et continue.
    readViewCache: ({ project, fingerprint }) => invokeCommand('read_advanced_view_state', {
      project,
      fingerprint,
    }),

    writeViewCache: ({ project, fingerprint, view }) => invokeCommand('write_advanced_view_state', {
      project,
      fingerprint,
      view,
    }),

    // Promotion d'une session éphémère : appelée **après** la publication de la
    // sauvegarde et **avant** la suppression du dossier de session. Un échec
    // fait abandonner l'entrée, pas la sauvegarde.
    renameViewCache: ({ from, to }) => invokeCommand('rename_advanced_view_state', { from, to }),
  };
}
