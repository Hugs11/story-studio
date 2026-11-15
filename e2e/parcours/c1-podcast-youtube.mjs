// Podcast puis YouTube : annulation et import réel depuis l'accueil.
// Les c5-* couvrent séparément l'import depuis un éditeur déjà ouvert.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { MODALS, closeFunnel, goHome, returnHome } from '../lib/actions.mjs';
import { inventory, inventoryDiff } from '../lib/oracles.mjs';

const ENTRIES = [
  { tile: 'Créer un pack depuis un podcast', label: 'Podcast', source: 'podcast', url: 'http://rss.sciam.com/sciam/60secsciencepodcast/' },
  { tile: 'Créer un pack depuis YouTube', label: 'YouTube', source: 'youtube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
];

// Les noms d'histoires nettoient les caractères de nom de fichier (dont « : »
// et « - »). Comparer tous les mots du titre, sans dépendre de sa ponctuation.
const titleWords = text => text.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Attendre soit la liste/la fermeture, soit l'erreur affichée. Un timeout
// sans preuve d'échec réseau reste un KO : il peut être un blocage applicatif.
async function waitForFunnel(modal, row, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await modal.isVisible()) return { outcome: 'closed' };
    const error = modal.locator('.funnel-error, .funnel-done-badge--error').first();
    if (await error.isVisible()) return { outcome: 'error', text: await modal.innerText() };
    if (row && await row.isVisible()) return { outcome: 'listed' };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { outcome: 'timeout', text: await modal.innerText().catch(() => '') };
}

async function importFromHome(ctx, page, events, expectedNetworkFaults, { tile, label, source, url }) {
  const step = `import-accueil-${label}`;
  events.setStep(step);
  await goHome(page);
  await page.getByText(tile, { exact: true }).click();
  const modal = page.locator(`[role="dialog"][aria-label="${tile}"]`).first();
  await modal.waitFor({ timeout: 30_000 });
  if (source === 'youtube') {
    const consent = modal.getByRole('button', { name: /J['’]ai compris, continuer/ });
    if (await consent.count()) await consent.click();
  }
  await modal.locator(`#${source}-funnel-url`).fill(url);
  await modal.getByRole('button', { name: source === 'podcast' ? 'Charger les épisodes' : 'Charger les vidéos', exact: true }).click();
  const row = modal.locator(`.${source}-funnel-row`).first();
  let result = await waitForFunnel(modal, row, 180_000);
  let sourceTitle = '';
  let itemTitle = '';
  if (result.outcome === 'listed') {
    sourceTitle = (await modal.locator('.funnel-section-title').innerText()).trim();
    itemTitle = (await row.locator(`.${source}-funnel-row-name`).innerText()).trim();
    await row.click();
    await ctx.shot(page, `${source}-selection-import`);
    await modal.getByRole('button', { name: /^Importer/ }).click();
    result = await waitForFunnel(modal, null, 600_000);
  }
  await ctx.shot(page, `${source}-resultat-import`);
  if (result.outcome !== 'closed' || !itemTitle) {
    // Les codes du moteur distinguent un refus du service externe d'un défaut
    // local (copie/session). Ne jamais neutraliser l'oracle d'un éditeur vide
    // après fermeture réussie, même si la couverture a échoué sur le réseau.
    const ipcErrors = events.all().filter(event => event.step === step && event.kind === 'ipc.error');
    const lastError = ipcErrors.at(-1);
    const network = result.outcome === 'error' && /PODCAST_(?:FEED_FETCH_FAILED|FEED_HTTP_ERROR|DOWNLOAD_IMPOSSIBLE|DOWNLOAD_HTTP_ERROR|CONTENT_READ_FAILED)|"code"\s*:\s*"(?:network|blocked|geo_blocked|unavailable)"|HTTP Error (?:403|429|5\d\d)/i.test(lastError?.text ?? '');
    ctx.check(`${label} : import depuis l’Accueil${network ? ' non concluant (réseau/service externe)' : ' aboutit'}`, network ? null : false, { ...result, ipcErrors });
    if (network) {
      // En mode dev, ces deux journaux reprennent l'échec réseau rattrapé.
      // Les autres erreurs console et toutes les exceptions restent des KO.
      for (const fault of events.faults()) {
        if (fault.step === step && fault.kind === 'console.error'
          && /^(?:import-media:item-error|podcast-funnel:import-error|youtube-funnel:import-error)\b/.test(fault.text)) expectedNetworkFaults.add(fault);
      }
    }
    if (result.outcome === 'error') {
      const home = modal.getByRole('button', { name: 'Retour à l’accueil', exact: true });
      if (await home.count()) await home.click();
      else await closeFunnel(page);
    }
  } else {
    const tree = page.locator('.tree-item--root').first();
    await tree.waitFor({ timeout: 30_000 });
    ctx.check(`${label} : arrivée dans l’éditeur par menus`, await tree.isVisible() && await page.locator('.react-flow').count() === 0);
    const titles = (await page.locator('.tree-item--story .ti-label').allInnerTexts()).map(text => text.trim());
    ctx.check(`${label} : une histoire porte le titre importé`, titles.some(title => titleWords(title) === titleWords(itemTitle)), { itemTitle, titles });
    const projectTitle = (await page.locator('.chrome-titlebar-pack-title').innerText()).trim();
    ctx.check(`${label} : titre du projet égal au titre de la source`, !!sourceTitle && projectTitle === sourceTitle, { sourceTitle, projectTitle });
  }
  const faults = events.faults().filter(fault => !expectedNetworkFaults.has(fault));
  const networkFaults = [...expectedNetworkFaults].filter(fault => fault.step === step);
  ctx.check(`${label} : aucune erreur console après l’import depuis l’Accueil`, faults.length ? false : networkFaults.length ? null : true, { faults, networkFaults });
  if (await page.locator('.tree-item--root').first().isVisible() && !await modal.isVisible()) await returnHome(page);
}

export async function run() {
  const ctx = createRun('c1-podcast-youtube');
  const workspaceDir = ctx.dir('workspace');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const allFaults = [];
  const expectedNetworkFaults = new Set();
  try {
    for (const entry of ENTRIES) {
      const { tile, label } = entry;
      events.setStep(`ouverture-${label}`);
      await goHome(page);
      const before = inventory(workspaceDir);
      await page.getByText(tile, { exact: true }).click();
      const opened = await page.locator(MODALS).first()
        .waitFor({ timeout: 30_000 }).then(() => true, () => false);
      await ctx.shot(page, `${label.toLowerCase()}-ouvert`);
      ctx.check(`« ${tile} » ouvre le funnel`, opened);

      events.setStep(`annulation-${label}`);
      const closed = await closeFunnel(page);
      await goHome(page);
      await ctx.shot(page, `${label.toLowerCase()}-annule`);
      const after = inventory(workspaceDir);
      ctx.check(`« ${label} » : annuler ferme le funnel`, closed);
      ctx.check(`« ${label} » : annuler ne laisse rien dans le workspace`, inventoryDiff(before, after).added.length === 0, {
        diff: inventoryDiff(before, after),
      });
      ctx.check(`« ${label} » : l'accueil reste utilisable après annulation`, await page.locator('.mode-selector').isVisible().catch(() => false));
      const faults = events.faults().filter(fault => !expectedNetworkFaults.has(fault));
      ctx.check(`« ${label} » : aucune erreur console`, faults.length === 0, { faults });
      await importFromHome(ctx, page, events, expectedNetworkFaults, entry);
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false);
  } finally {
    allFaults.push(...events.faults().filter(fault => !expectedNetworkFaults.has(fault)));
    ctx.check('aucune erreur console ni exception sur tout le parcours', allFaults.length ? false : expectedNetworkFaults.size ? null : true, { faults: allFaults, networkFaults: [...expectedNetworkFaults] });
    const stop = await app.stop();
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
