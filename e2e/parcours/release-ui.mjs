// Test de release, étage 2 : l'interface mène-t-elle au même résultat que
// l'étage 1 ? Quelques entrées du corpus réduit, choisies pour couvrir les
// chemins de l'interface plutôt que l'exhaustivité :
//
//  1. même pack, ouvert par l'éditeur par menus puis généré ;
//  2. passerelle : « Continuer dans l'éditeur graphe… », puis génération ;
//  3. même pack ouvert dans le graphe, généré ;
//  4. gros .7z à longue « Vérification… », généré ;
//  5. pack bloqué (1 à corriger), correction en un clic dans « À corriger », généré ;
//  6. enveloppe de plusieurs packs : l'app propose de choisir ;
//  7. archive illisible : refus avec un message lisible ;
//  8. projet de l'éditeur simplifié, ouvert puis généré ;
//  9. exemple publié (proposé au téléchargement par le README) : geste du README
//     (accueil, « Modifier un pack existant », l'archive), l'app propose les deux
//     éditeurs ; généré par menus, puis passerelle vers le graphe, généré.
//
// Les entrées viennent du manifeste privé par des motifs de nom (`STEPS`) : aucun
// nom de pack réel n'est écrit ici. Chaque archive produite est relue par le
// validateur et le lecteur de l'app, STUdio et Lunii.QT. Après un échec, l'app
// est relancée : l'étape suivante ne doit pas hériter d'un état bloqué.
import { cpSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { clickButton, generatePack, goHome, importPack, MODALS, modalWithText, projectMenuButton, returnHome, waitValidationSettled } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { dropFiles } from '../lib/drop.mjs';
import { openProjectDialog } from '../lib/c2-helpers.mjs';
import { readbackPack } from '../lib/oracles.mjs';
import { reducedEntries } from '../lib/reduced-corpus.mjs';
import { luniiqtVerdict } from '../luniiqt/luniiqt.mjs';

// Les motifs désignent les entrées du manifeste par leur verdict et leur rôle,
// pas par leur nom : `pick` choisit la première entrée qui satisfait le filtre.
const pick = (filter) => reducedEntries().find(filter) ?? null;
const PICKS = {
  small: () => pick((e) => e.kind === 'pack' && e.expect?.open === 'menus+graphe' && e.checkDeterminism),
  longVerification: () => pick((e) => (e.cases ?? []).includes('ui:verification-longue')),
  fixable: () => pick((e) => e.origin === 'synthetique' && e.expect?.afterFix),
  envelope: () => pick((e) => String(e.expect?.open).startsWith('refus:enveloppe')),
  unreadable: () => pick((e) => (e.cases ?? []).includes('enveloppe:zip-lzma')),
  simpleProject: () => pick((e) => e.kind === 'projet' && e.expect?.open === 'simplifie'),
  publishedExample: () => pick((e) => (e.cases ?? []).includes('ui:exemple-publie')),
};

const FIX_LABELS = {
  'disable-home': /Désactiver le bouton Accueil/,
  'clear-home-transition': /Retirer la destination Accueil/,
};

export async function run() {
  const ctx = createRun('release-ui');
  const workspaceDir = ctx.dir('workspace');
  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const relaunch = async () => {
    await app.stop().catch(() => {});
    app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  };

  // Génère, relit par les oracles, et rend un verdict lisible.
  const generateAndRead = async (label) => {
    const outDir = ctx.dir('sortie', label);
    const gen = await generatePack(app.page, outDir, { uuid: 'keep', events: app.events });
    if (!gen.zip) return { ok: false, reason: gen.refusal ?? (gen.timeout ? 'délai de génération dépassé' : 'aucune archive') };
    const readback = await readbackPack(app.page, gen.zip, ctx.dir('studio', label));
    const luniiqt = luniiqtVerdict(gen.zip);
    const ok = readback.ok && luniiqt.ok;
    return { ok, zip: gen.zip, readbackOk: readback.ok, luniiqtOk: luniiqt.ok, reason: ok ? null : JSON.stringify({ readback: readback.reason ?? readback, luniiqt: luniiqt.errors }).slice(0, 400) };
  };

  // Une étape : tout échec relance l'app et reste un échec lisible.
  const step = async (name, body) => {
    app.events.setStep(name);
    let result;
    try {
      result = await body();
    } catch (error) {
      result = { ok: false, reason: String(error?.message ?? error).slice(0, 400) };
    }
    await ctx.shot(app.page, name).catch(() => {});
    ctx.check(name, result.ok, result);
    if (!result.ok) await relaunch();
    else await returnHome(app.page).catch(() => {});
    await goHome(app.page).catch(() => {});
    return result;
  };

  const small = PICKS.small();
  const long = PICKS.longVerification();
  const fixable = PICKS.fixable();
  const envelope = PICKS.envelope();
  const unreadable = PICKS.unreadable();
  const simpleProject = PICKS.simpleProject();
  const publishedExample = PICKS.publishedExample();
  const missing = Object.entries({ small, long, fixable, envelope, unreadable, simpleProject, publishedExample }).filter(([, e]) => !e);
  ctx.check('manifeste : une entrée pour chaque étape', missing.length === 0, { missing: missing.map(([k]) => k) });

  // Passerelle depuis l'éditeur par menus : « Continuer dans l'éditeur graphe… »,
  // enregistrement du projet, copie pour le graphe, qui s'ouvre sur la copie.
  const continueInGraph = async (label) => {
    const projectPath = join(ctx.dir('projets', label), `${label}.mbah`);
    await projectMenuButton(app.page).click();
    await app.page.getByText('Continuer dans l’éditeur graphe…').click();
    const saveFirst = app.page.locator(MODALS).filter({ hasText: 'Enregistre d’abord' });
    await saveFirst.waitFor({ timeout: 15_000 });
    await answerNext(app.page, 'save', projectPath);
    await clickButton(saveFirst, /Enregistrer le projet/);
    const confirm = app.page.locator(MODALS).filter({ hasText: 'créer une copie de ton projet pour l’éditeur graphe' });
    await confirm.waitFor({ timeout: 60_000 });
    await clickButton(confirm, /Créer la copie/);
    // L'éditeur graphe s'ouvre sur la copie : sa pastille et son bouton de génération.
    await app.page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout: 120_000 });
  };

  if (small) {
    await step('1-menus-genere', async () => {
      await importPack(app.page, small.absPath, { editor: 'menus' });
      return generateAndRead('1-menus');
    });

    await step('2-passerelle-genere', async () => {
      await importPack(app.page, small.absPath, { editor: 'menus' });
      await continueInGraph('passerelle');
      return generateAndRead('2-passerelle');
    });

    await step('3-graphe-genere', async () => {
      await importPack(app.page, small.absPath, { editor: 'graphe' });
      return generateAndRead('3-graphe');
    });
  }

  if (long) {
    await step('4-gros-7z-verification-longue', async () => {
      await importPack(app.page, long.absPath, { editor: 'graphe' });
      return generateAndRead('4-gros-7z');
    });
  }

  if (fixable) {
    await step('5-a-corriger-puis-correction', async () => {
      await importPack(app.page, fixable.absPath, { editor: 'graphe' });
      const before = await waitValidationSettled(app.page);
      if (before.count !== fixable.expect.blocking.length) {
        return { ok: false, reason: `à corriger attendu ${fixable.expect.blocking.length}, affiché ${before.count}` };
      }
      // La pastille ouvre son panneau au survol ; un clic de plus le refermerait.
      const pill = app.page.locator('[data-toolbar-id="toggleValidation"]').first();
      const panel = app.page.locator('[aria-label="Éléments à corriger"]');
      await pill.hover();
      if (!(await panel.waitFor({ timeout: 5_000 }).then(() => true, () => false))) await pill.click();
      await panel.waitFor({ timeout: 15_000 });
      await clickButton(panel, FIX_LABELS[fixable.expect.afterFix.resolution], { timeout: 15_000 });
      await app.page.keyboard.press('Escape').catch(() => {});
      const after = await waitValidationSettled(app.page);
      if (after.count !== 0) return { ok: false, reason: `encore ${after.count} à corriger après la correction` };
      return generateAndRead('5-apres-correction');
    });
  }

  // Refus à l'ouverture : on dépose l'archive et on attend la boîte qui porte
  // `pattern` — jamais l'écran d'attente « Examen de l'archive… », dont le texte
  // évoque aussi « plusieurs packs ». La boîte est refermée ensuite, pour que
  // l'étape suivante trouve l'accueil libre.
  const dropAndReadModal = async (archive, pattern) => {
    await app.page.getByText('Modifier un pack existant').click();
    await dropFiles(app.page, '[data-funnel-drop]', [archive]);
    const modal = app.page.locator(MODALS).filter({ hasText: pattern });
    await modal.first().waitFor({ timeout: 180_000 });
    const text = (await modal.first().innerText()).trim();
    for (let attempt = 0; attempt < 3 && await app.page.locator(MODALS).count(); attempt += 1) {
      await app.page.keyboard.press('Escape').catch(() => {});
      await app.page.waitForTimeout(500);
    }
    return text;
  };

  if (envelope) {
    await step('6-enveloppe-propose-de-choisir', async () => {
      const text = await dropAndReadModal(envelope.absPath, 'Cette archive contient plusieurs packs');
      const ok = text.includes('Cette archive contient plusieurs packs');
      return { ok, reason: ok ? null : `boîte inattendue : ${text.slice(0, 300)}`, text: text.slice(0, 300) };
    });
  }

  if (unreadable) {
    await step('7-archive-illisible-message-lisible', async () => {
      // L'auteur lit la phrase de `importErrorPresentation.js`, le détail
      // technique en second : ni l'un ni l'autre ne montre de chemin temporaire.
      const shown = 'méthode de compression que Story Studio ne sait pas lire';
      const text = await dropAndReadModal(unreadable.absPath, shown);
      const ok = text.includes(shown) && !/AppData|\\Temp\\/i.test(text);
      return { ok, reason: ok ? null : `message : ${text.slice(0, 300)}`, text: text.slice(0, 300) };
    });
  }

  if (simpleProject) {
    await step('8-editeur-simplifie-genere', async () => {
      // Copie du dossier consolidé (projet + médias), jamais l'original.
      const copyDir = ctx.dir('projets', 'simplifie');
      cpSync(dirname(simpleProject.absPath), copyDir, { recursive: true });
      const opened = await openProjectDialog(app.page, join(copyDir, basename(simpleProject.absPath)), { timeout: 120_000 });
      if (!opened) return { ok: false, reason: 'projet non ouvert' };
      return generateAndRead('8-simplifie');
    });
  }

  if (publishedExample) {
    await step('9-exemple-publie-menus-puis-graphe', async () => {
      // Geste du README : accueil, « Modifier un pack existant », l'archive.
      // L'app doit proposer les deux éditeurs ; `importPack` choisirait sans
      // rien dire l'éditeur graphe seul, d'où ce relevé préalable.
      await app.page.getByText('Modifier un pack existant').click();
      await dropFiles(app.page, '[data-funnel-drop]', [publishedExample.absPath]);
      const chooser = modalWithText(app.page, 'Choisir l’éditeur');
      const offered = await chooser.first().waitFor({ timeout: 180_000 }).then(() => true, () => false);
      const editors = offered ? {
        menus: await chooser.getByRole('button', { name: 'Éditeur par menus', exact: true }).count() > 0,
        graphe: await chooser.getByRole('button', { name: 'Éditeur graphe', exact: true }).count() > 0,
      } : null;
      if (!editors?.menus || !editors?.graphe) {
        return { ok: false, reason: `les deux éditeurs ne sont pas proposés : ${JSON.stringify(editors)}` };
      }
      await ctx.shot(app.page, '9-choix-editeur').catch(() => {});
      await chooser.getByRole('button', { name: 'Éditeur par menus', exact: true }).click();
      await app.page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout: 180_000 });
      await modalWithText(app.page, 'Modifier un pack').first().waitFor({ state: 'hidden', timeout: 180_000 }).catch(() => {});
      const menus = await generateAndRead('9-exemple-menus');
      if (!menus.ok) return { ...menus, phase: 'menus' };
      await ctx.shot(app.page, '9-menus-genere').catch(() => {});
      await continueInGraph('exemple-publie');
      const graph = await generateAndRead('9-exemple-graphe');
      return { ok: graph.ok, reason: graph.ok ? null : graph.reason, phase: graph.ok ? null : 'graphe', menus, graph };
    });
  }

  await app.stop().catch(() => {});
  mkdirSync(ctx.runDir, { recursive: true });
  return ctx.finish();
}
