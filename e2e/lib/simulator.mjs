// trace d'une simulation, quelle que soit sa provenance.
//
// Le DOM du simulateur (`LuniiShell.jsx`) est strictement le même que la
// source soit le document en cours (`DocumentSimulationPanel`), une archive
// produite (`ZipReviewPanel`) ou un pack posé dans l'arbre (« Simuler ce
// pack… »/« Simuler depuis ici »). Ce module ne sait pas d'où vient l'écoute :
// il lit `.lunii-sim` et pilote ses boutons, ce qui rend la trace comparable
// entre le projet et l'archive qu'il produit — c'est tout l'enjeu du lot.
//
// Aucune sonde applicative : titre, sous-titre, présence d'image et barre de
// lecture (durée) viennent du DOM ; le journal IPC (`events.ipc()`) est lu à
// côté par les parcours pour corroborer (get_pack_asset vs plugin:fs|read_file),
// jamais comme seule source.

const SIM = '.lunii-sim';

export async function waitForSimulator(page, { timeout = 30_000 } = {}) {
  await page.locator(SIM).first().waitFor({ timeout });
}

export async function simulatorClosed(page, { timeout = 5_000 } = {}) {
  return page.locator(SIM).first().waitFor({ state: 'hidden', timeout }).then(() => true, () => false);
}

// Ferme par le bandeau de relecture d'archive s'il est là, sinon par la
// commande commune du simulateur flottant. Le document avancé n'a plus de
// bandeau propre.
export async function closeSimulator(page) {
  const bannerClose = page.locator('.advanced-review-banner').getByRole('button', { name: /Fermer/ }).first();
  if (await bannerClose.count()) {
    await bannerClose.click();
    return;
  }
  const cross = page.locator('.lunii-close-btn').first();
  if (await cross.count()) await cross.click();
}

// Un message d'erreur/refus affiché à la place du simulateur (pack sans Écran
// de départ, projection refusée…) — jamais une exception : `SimulatorNotice`
// et le message « Ce pack n'a pas d'Écran de départ » de `FlatSimulator`.
export async function simulatorNotice(page) {
  const notice = page.locator('.floating-simulator-notice, .floating-simulator').filter({ hasText: /Écoute impossible|n.a pas d.Écran de départ|Aucun Écran de départ/ }).first();
  if (await notice.count()) return (await notice.innerText()).trim();
  return null;
}

async function stableImagePresence(page, { timeout = 3_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const img = page.locator(`${SIM} .lunii-story-img`).first();
    if (await img.count()) {
      const tag = await img.evaluate((el) => el.tagName).catch(() => null);
      if (tag === 'IMG') {
        const hasSrc = await img.evaluate((el) => Boolean(el.getAttribute('src'))).catch(() => false);
        if (hasSrc) return true;
      } else if (tag === 'DIV') {
        return false;
      }
    }
    await page.waitForTimeout(150);
  }
  return false;
}

// Attend que la présence ET la durée audio se stabilisent avant de conclure.
// Deux pièges distincts, tous deux observés en pratique (sur un pack
// du corpus) :
//  - la barre de lecture apparaît dès que le lecteur existe
//    (`useAudioTimeline`), la durée seulement une fois les métadonnées
//    chargées — un relevé pris trop tôt capte une durée encore à 0 ;
//  - la source archive (`get_pack_asset`, IPC + lecture du zip) est
//    structurellement plus lente à attacher son lecteur que la source projet
//    (`plugin:fs|read_file` sur un fichier local) : juste après une
//    transition, `playbackVisible` peut valoir `false` un instant côté
//    archive alors que l'Écran a bel et bien un audio qui va démarrer — pris
//    à cet instant précis, on le confondrait avec un Écran muet.
// On attend donc que `playbackVisible` ET `duration` (si présente) soient
// stables sur deux lectures consécutives avant de rendre l'état final.
async function waitAudioSettled(page, { timeout = 20_000 } = {}) {
  const root = page.locator(SIM).first();
  let lastVisible = null;
  let lastDuration = null;
  let stableStreak = 0;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const bar = root.locator('.lunii-playback-bar').first();
    const visible = await bar.count() > 0;
    let duration = null;
    if (visible) {
      const times = await bar.locator('.lunii-playback-time').allInnerTexts().catch(() => []);
      duration = times[1] ?? null;
    }
    const durationReady = !visible || (Boolean(duration) && duration !== '0:00');
    if (visible === lastVisible && durationReady && duration === lastDuration) {
      stableStreak += 1;
      if (stableStreak >= 2) return;
    } else {
      stableStreak = 0;
    }
    lastVisible = visible;
    lastDuration = duration;
    await page.waitForTimeout(250);
  }
}

/**
 * L'état affiché à l'instant T : ce qu'un utilisateur qui regarde l'écran
 * peut constater, rien de plus. `duration` est le texte affiché
 * (`formatPlaybackTime`), arrondi à la seconde par le composant lui-même.
 *
 * `settleAudio` : voir `waitAudioSettled` — à réserver au relevé final d'une
 * étape de script (coûteux), pas au relevé « before » qui ne sert qu'à lire
 * l'état des boutons.
 */
export async function readStageState(page, { settleAudio = false } = {}) {
  if (settleAudio) await waitAudioSettled(page);
  const root = page.locator(SIM).first();
  const title = await root.locator('.lunii-screen-title').innerText().catch(() => null);
  const sub = await root.locator('.lunii-screen-sub').innerText().catch(() => null);
  const hasImage = await stableImagePresence(page);
  const okBtn = root.locator('.lunii-btn-ok').first();
  const okDisabled = await okBtn.isDisabled().catch(() => null);
  const homeBtn = root.locator('.lunii-buttons button').filter({ hasText: '⌂' }).first();
  const homeDisabled = await homeBtn.isDisabled().catch(() => null);
  const playbackBar = root.locator('.lunii-playback-bar').first();
  const playbackVisible = await playbackBar.count() > 0;
  let duration = null;
  let currentTime = null;
  if (playbackVisible) {
    const times = await playbackBar.locator('.lunii-playback-time').allInnerTexts().catch(() => []);
    currentTime = times[0] ?? null;
    duration = times[1] ?? null;
  }
  return { title, sub, hasImage, okDisabled, homeDisabled, playbackVisible, duration, currentTime };
}

function stateKey(state) {
  return `${state.title}|${state.sub}`;
}

async function clickAction(page, action) {
  const root = page.locator(SIM).first();
  if (action === 'ok') await root.locator('.lunii-btn-ok').first().click();
  else if (action === 'left') await root.locator('.lunii-wheel-left').first().click();
  else if (action === 'right') await root.locator('.lunii-wheel-right').first().click();
  else if (action === 'home') await root.locator('.lunii-buttons button').filter({ hasText: '⌂' }).first().click();
  else throw new Error(`Action de script inconnue : ${action}`);
}

// Script fixe, partagé par toutes les traces d'une même comparaison : c'est la
// comparabilité A/B qui compte, pas la richesse du parcours. Biaisé vers OK
// (avance), avec quelques molettes et deux retours Maison (dont un profond).
export const DEFAULT_SCRIPT = [
  'ok', 'ok', 'right', 'ok', 'ok', 'left', 'ok', 'ok', 'ok', 'right',
  'right', 'ok', 'ok', 'home', 'ok', 'right', 'ok', 'ok', 'left', 'ok',
  'ok', 'ok', 'right', 'right', 'right', 'ok', 'ok', 'left', 'left', 'ok',
  'ok', 'ok', 'home', 'ok', 'ok', 'right', 'ok', 'ok', 'ok', 'ok',
  'left', 'ok', 'ok', 'right', 'ok', 'ok', 'ok', 'home', 'ok', 'ok',
];

/**
 * Rejoue `script` sur le simulateur déjà ouvert (`.lunii-sim` visible) et
 * renvoie la trace : un enregistrement par étape, l'action demandée, celle
 * réellement exécutée (une avance automatique remplace un OK sur un Écran en
 * lecture automatique dont le bouton est désactivé — documenté ici plutôt que
 * deviné : `cs.ok` peut être faux tant que `autoplay` fait seul avancer
 * l'Écran, cf. invariant « ok_transition existe seulement si ok || autoplay »)
 * et l'état affiché après.
 *
 * Choix documenté (histoires longues) : une histoire réelle peut durer
 * plusieurs minutes ; ni le banc e2e ni cette trace ne peuvent se permettre
 * d'attendre chaque fin réelle. `autoWaitMs` borne l'attente d'une avance
 * automatique ; si elle n'est pas venue et que Maison est disponible
 * (`homeDisabled === false` — observé y compris pendant une lecture en
 * cours), on **presse Maison** pour continuer le script au lieu d'abandonner
 * la trace : c'est la même règle des deux côtés (projet et archive), donc
 * comparable, et c'est ce qu'un auteur pressé ferait réellement. Seul un
 * Écran qui n'avance ni tout seul ni par Maison est un vrai blocage
 * (`stuckAt`).
 */
export async function runTrace(page, script = DEFAULT_SCRIPT, { autoWaitMs = 7_000, settleMs = 200 } = {}) {
  await waitForSimulator(page);
  const steps = [];
  let stuckAt = null;
  for (let i = 0; i < script.length; i += 1) {
    const requested = script[i];
    const before = await readStageState(page);
    let executed = requested;
    if (requested === 'ok' && before.okDisabled) {
      // Écran autoplay (ou fin d'Action sans suite) : on attend l'avance
      // automatique plutôt que de cliquer un bouton désactivé (Playwright
      // refuserait le clic de toute façon). On documente l'attente dans la
      // trace : c'est un fait, pas une action jouée.
      const key = stateKey(before);
      const started = Date.now();
      let changed = false;
      while (Date.now() - started < autoWaitMs) {
        await page.waitForTimeout(300);
        const now = await readStageState(page);
        if (stateKey(now) !== key) { changed = true; break; }
      }
      if (changed) {
        executed = 'ok→attente auto-avance';
      } else if (!before.homeDisabled) {
        await clickAction(page, 'home');
        await page.waitForTimeout(settleMs);
        executed = 'ok→bloqué, Maison de secours (histoire longue présumée)';
      } else {
        executed = 'ok→bloqué (ni bouton, ni avance, ni Maison)';
        stuckAt = i;
      }
    } else if (requested === 'home' && before.homeDisabled) {
      executed = 'home→désactivé (ignoré)';
    } else {
      await clickAction(page, requested);
      await page.waitForTimeout(settleMs);
    }
    const after = await readStageState(page, { settleAudio: true });
    steps.push({ i, requested, executed, before, after });
    if (stuckAt !== null) break;
  }
  return { steps, stuckAt };
}

// Compare deux traces étape par étape sur ce qu'un auteur peut constater :
// titre, sous-titre, présence d'image, boutons actifs, présence audio. C'est
// l'oracle principal (l'enchaînement d'écrans et la présence audio/image) :
// `identical`/`firstDivergence` ne portent que sur ces champs.
//
// La durée audio est vérifiée **séparément**, en bonus : `durationGaps` liste
// chaque écart au-delà de `durationToleranceSec`, **sans influencer
// `identical`**. Ce n'est pas de la complaisance — une vérification
// indépendante (ffprobe, hors DOM) a montré qu'un écart de durée peut être
// **réel et systématique** (silence trimming/normalisation appliqués à
// l'export, que `project_pack_for_simulation` n'applique pas lui-même par
// construction) sans que la navigation elle-même diverge d'un seul écran. Faire
// dépendre l'oracle principal de ce champ aurait noyé la vraie question (la
// séquence est-elle la même ?) dans un signal qui, lui, est structurellement
// toujours différent dès qu'une histoire a du son.
export function compareTraces(traceA, traceB, { durationToleranceSec = 1 } = {}) {
  const a = traceA.steps;
  const b = traceB.steps;
  const len = Math.max(a.length, b.length);
  const durationGaps = [];
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length || i >= b.length) {
      return { identical: false, firstDivergence: { index: i, field: 'longueur', a: a[i]?.after ?? null, b: b[i]?.after ?? null }, durationGaps };
    }
    const sa = a[i].after;
    const sb = b[i].after;
    const fields = ['title', 'sub', 'hasImage', 'okDisabled', 'homeDisabled', 'playbackVisible'];
    for (const field of fields) {
      if (sa[field] !== sb[field]) {
        return { identical: false, firstDivergence: { index: i, field, a: sa[field], b: sb[field] }, durationGaps };
      }
    }
    if (sa.playbackVisible && sb.playbackVisible) {
      const da = parsePlaybackSeconds(sa.duration);
      const db = parsePlaybackSeconds(sb.duration);
      if (da !== null && db !== null && Math.abs(da - db) > durationToleranceSec) {
        durationGaps.push({ index: i, title: sa.title, a: sa.duration, b: sb.duration });
      }
    }
  }
  return { identical: true, firstDivergence: null, durationGaps };
}

function parsePlaybackSeconds(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d+):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Déclenche « Lancer le simulateur » (StructureActionsBar / GraphSurfaceControls,
// `data-media-tool="simulator"`) — le même bouton dans l'arbre, le diagramme
// et le canvas graphe. Ouvre l'overflow (« Plus d'actions ») s'il est là.
export async function launchSimulatorFromToolbar(page, { timeout = 15_000 } = {}) {
  let btn = page.locator('[data-media-tool="simulator"]').first();
  if (await btn.count() === 0) {
    const overflow = page.locator('.structure-actions-overflow-trigger').first();
    if (await overflow.count()) {
      await overflow.click();
      btn = page.locator('[data-media-tool="simulator"]').first();
    }
  }
  await btn.waitFor({ timeout });
  await btn.click();
}

// Le menu contextuel partagé (arbre, diagramme, graphe : `ContextMenu.jsx`,
// `.ctx-menu`/`.ctx-item`, role="menu"/"menuitem").
export async function openTreeContextMenu(page, labelSubstring, { timeout = 15_000 } = {}) {
  const row = page.locator('.tree-item').filter({ hasText: labelSubstring }).first();
  await row.waitFor({ timeout });
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  const menu = page.locator('.ctx-menu');
  await menu.waitFor({ timeout: 5_000 });
  return menu;
}

export async function clickContextMenuItem(page, labelPattern) {
  const menu = page.locator('.ctx-menu');
  const item = menu.getByRole('menuitem', { name: labelPattern }).first();
  await item.waitFor({ timeout: 5_000 });
  await item.click();
}

export async function closeContextMenuIfOpen(page) {
  const menu = page.locator('.ctx-menu').first();
  if (await menu.count()) await page.keyboard.press('Escape');
}
