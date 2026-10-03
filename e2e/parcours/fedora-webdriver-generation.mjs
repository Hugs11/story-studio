// Jalon 2 du portage : même ouverture menus et mêmes quatre oracles que
// release-ui, isolés pour vérifier la chaîne avant les neuf étapes.
import { launchApp } from '../lib/launch.mjs';
import { importPack, generatePack } from '../lib/actions.mjs';
import { createRun } from '../lib/run-context.mjs';
import { reducedEntries } from '../lib/reduced-corpus.mjs';
import { readbackPack } from '../lib/oracles.mjs';
import { luniiqtVerdict } from '../luniiqt/luniiqt.mjs';

export async function run() {
  if (process.platform !== 'linux') throw new Error('Sonde du pilote Fedora uniquement');
  const ctx = createRun('fedora-webdriver-generation');
  const app = await launchApp({ runDir: ctx.runDir, workspaceDir: ctx.dir('workspace'), fresh: true });
  try {
    const source = reducedEntries().find(e => e.kind === 'pack' && e.expect?.open === 'menus+graphe' && e.checkDeterminism);
    if (!source) throw new Error('Entrée menus avec contrôle de déterminisme absente');
    await importPack(app.page, source.absPath, { editor: 'menus' });
    const gen = await generatePack(app.page, ctx.dir('sortie'), { uuid: 'keep', events: app.events });
    if (!gen.zip) throw new Error(gen.refusal || 'Aucune archive produite');
    const readback = await readbackPack(app.page, gen.zip, ctx.dir('studio'));
    const luniiqt = luniiqtVerdict(gen.zip);
    ctx.check('génération menus relue par quatre oracles', readback.ok && luniiqt.ok, { readback, luniiqt });
    await ctx.shot(app.page, 'generation');
  } catch (error) { ctx.check('génération menus', false, { reason: error.message }); }
  finally { await app.stop(); }
  return ctx.finish();
}
