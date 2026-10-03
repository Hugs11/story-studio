// Accueil : nouveau projet dans les 3 modes, retour à l'accueil par
// l'interface (menu Projet… → Retour à l'accueil). Aucune donnée personnelle :
// projets vierges, aucun import.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { goHome, newProject, returnHome } from '../lib/actions.mjs';

const MODES = [
  { mode: 'simple', label: 'Éditeur simplifié' },
  { mode: 'pack', label: 'Éditeur par menus' },
  { mode: 'advanced', label: 'Éditeur graphe' },
];

export async function run() {
  const ctx = createRun('c1-accueil');
  const workspaceDir = ctx.dir('workspace');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  try {
    events.setStep('accueil');
    await goHome(page);
    await ctx.shot(page, 'accueil');
    ctx.check('accueil affiché sans erreur', events.faults().length === 0);

    for (const { mode, label } of MODES) {
      events.setStep(`nouveau-projet-${mode}`);
      await newProject(page, mode);
      await ctx.shot(page, `editeur-${mode}`);
      ctx.check(`« ${label} » : nouveau projet ouvre l'éditeur sans erreur`, events.faults().length === 0, {
        faults: events.faults(),
      });

      events.setStep(`retour-accueil-${mode}`);
      await returnHome(page);
      await ctx.shot(page, `accueil-apres-${mode}`);
      const homeVisible = await page.locator('.mode-selector').isVisible().catch(() => false);
      ctx.check(`« ${label} » : retour à l'accueil par l'interface aboutit`, homeVisible);
      ctx.check(`« ${label} » : aucune erreur console après l'aller-retour`, events.faults().length === 0, {
        faults: events.faults(),
      });
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false);
  } finally {
    const stop = await app.stop();
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
