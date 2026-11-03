// Cycle de vie d'une simulation lancée depuis le catalogue (consultation).
//
// `idle → preparing → ready → closing → closed`, ou `failed`. Chaque lancement
// porte un jeton (l'identifiant de consultation) : un résultat qui n'est pas
// celui du lancement courant est ignoré, et l'appelant le referme côté moteur.
// Une consultation expirée (fichier changé pendant l'écoute) propose une
// relance, jamais un mélange de l'ancien graphe et de nouveaux médias. Une
// cible périmée propose de choisir à nouveau, jamais un autre fichier.
//
// Aucun état de projet, de session ou de reprise : la consultation n'en a pas.

export const CONSULTATION_EXPIRED = 'CATALOG_CONSULTATION_EXPIRED';
const TARGET_CHANGED = new Set(['CATALOG_TARGET_REVISION_CHANGED', 'CATALOG_TARGET_REVISION_STALE']);

export const IDLE_CONSULTATION = Object.freeze({
  status: 'idle',
  token: null,
  target: null,
  origin: null,
  handle: null,
  error: null,
  retry: null,
});

/** Suite proposée après un échec : relancer, choisir à nouveau, ou rien. */
export function retryKind(error) {
  const code = error?.code ?? null;
  if (code === CONSULTATION_EXPIRED) return 'relaunch';
  if (TARGET_CHANGED.has(code)) return 'choose';
  return null;
}

const ACTIVE = new Set(['preparing', 'ready', 'failed']);

/**
 * @param {typeof IDLE_CONSULTATION} state
 * @param {{type: 'launch', token: string, target: object, origin?: object}
 *   | {type: 'prepared', token: string, handle: object}
 *   | {type: 'failed', token: string, error: object}
 *   | {type: 'expired', token: string}
 *   | {type: 'close'} | {type: 'closed', token: string}} action
 */
export function consultationReducer(state = IDLE_CONSULTATION, action) {
  switch (action.type) {
    case 'launch':
      return {
        ...IDLE_CONSULTATION,
        status: 'preparing',
        token: action.token,
        target: action.target,
        // Une relance garde l'origine (fiche ou carte) du premier lancement.
        origin: action.origin ?? (ACTIVE.has(state.status) ? state.origin : null),
      };
    case 'prepared':
      if (action.token !== state.token || state.status !== 'preparing') return state;
      return { ...state, status: 'ready', handle: action.handle };
    case 'failed':
      if (action.token !== state.token || (state.status !== 'preparing' && state.status !== 'ready')) return state;
      return { ...state, status: 'failed', handle: null, error: action.error, retry: retryKind(action.error) };
    case 'expired':
      if (action.token !== state.token || state.status !== 'ready') return state;
      return { ...state, status: 'failed', handle: null, error: { code: CONSULTATION_EXPIRED, params: {} }, retry: 'relaunch' };
    case 'close':
      if (!ACTIVE.has(state.status)) return state;
      return { ...state, status: 'closing', handle: null };
    case 'closed':
      if (action.token !== state.token || state.status !== 'closing') return state;
      return { ...IDLE_CONSULTATION, status: 'closed', origin: state.origin };
    default:
      return state;
  }
}

/** Un résultat de `token` n'est plus attendu : il doit être refermé. */
export function isLateResult(state, token) {
  return token !== state.token || state.status !== 'preparing';
}

/** Jeton de la consultation à refermer avant un nouveau lancement, ou `null`. */
export function tokenToClose(state) {
  return ACTIVE.has(state.status) || state.status === 'closing' ? state.token : null;
}

/** La consultation occupe l'écran (préparation, écoute, erreur). */
export function consultationVisible(state) {
  return ACTIVE.has(state.status);
}
