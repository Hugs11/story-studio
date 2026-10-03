// Jalon Linux : chaîne réelle, dialogue scripté, import synthétique, collecte
// dès le démarrage, capture, arrêt et relance immédiate. Aucun oracle simulé.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { reducedEntries } from '../lib/reduced-corpus.mjs';
import { dropFiles } from '../lib/drop.mjs';

export async function run() {
  if (process.platform !== 'linux') throw new Error('Sonde du pilote Fedora uniquement');
  const ctx = createRun('fedora-webdriver-smoke');
  const options = { runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') };
  let app;
  try {
    app = await launchApp(options);
    await app.page.getByText('Modifier un pack existant').waitFor();
    assert.ok(app.events.ipc().some(e => e.cmd === 'plugin:app|version'));
    ctx.check('IPC de démarrage collecté', true);
    // Éprouve les sélecteurs sur le vrai DOM WebKit, indépendamment de l'app.
    await app.page.evaluate(() => {
      const probe = document.createElement('div'); probe.id = 'e2e-selector-probe';
      probe.style.cssText = 'position:fixed;left:-10000px;top:0';
      probe.innerHTML = '<section class="group"><button aria-label="Bouton de test">Ignoré</button><span class="marker">Texte é</span><button aria-hidden="true">Caché</button></section><section class="group"><button role="menuitem">Autre</button><span>Différent</span></section>';
      document.body.append(probe);
    });
    try {
      const scope = app.page.locator('#e2e-selector-probe');
      assert.equal(await scope.getByRole('button').count(), 1);
      assert.equal(await scope.getByRole('button', { name: /de test$/, exact: true }).count(), 1);
      assert.equal(await scope.getByRole('menuitem', { name: 'Autre', exact: true }).count(), 1);
      assert.equal(await scope.locator('.group').filter({ has: app.page.locator('.marker') }).count(), 1);
      assert.equal(await scope.locator('.group').filter({ hasText: /Texte é/ }).count(), 1);
      assert.equal(await scope.getByText('Texte é', { exact: true }).innerText(), 'Texte é');
      assert.equal(await scope.locator('.group').nth(1).getByRole('menuitem').count(), 1);
    } finally { await app.page.evaluate(() => document.getElementById('e2e-selector-probe').remove()); }
    ctx.check('sélecteurs relatifs, rôles, noms et RegExp', true);

    await answerNext(app.page, 'message', null);
    await app.page.evaluate(async () => {
      const dialog = await import('/e2e/shim/dialog.js');
      await dialog.message('Sonde du dialogue scripté');
    });
    assert.equal((await dialogLog(app.page)).at(-1).kind, 'message');
    ctx.check('answerNext consommé par le shim', true);
    await app.page.getByText('Modifier un pack existant').click();
    const synthetic = reducedEntries().find(e => e.origin === 'synthetique' && e.expect?.open === 'graphe' && !e.expect?.afterFix);
    assert.ok(synthetic);
    await dropFiles(app.page, '[data-funnel-drop]', [synthetic.absPath]);
    await app.page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout: 180_000 });
    await app.page.getByText(/Ouverture de l['’]Éditeur graphe/).first().waitFor({ state: 'hidden', timeout: 300_000 });
    await app.page.getByText('Lecture du graphe…').first().waitFor({ state: 'hidden', timeout: 300_000 });
    assert.ok(app.events.ipc().some(e => e.cmd === 'inspect_pack_archive'));
    ctx.check('import synthétique et trace IPC', true);
    await ctx.shot(app.page, 'import-synthetique');
    await app.stop(); app = null;
    app = await launchApp({ ...options, runDir: join(ctx.runDir, 'relance') });
    await app.page.getByText('Modifier un pack existant').waitFor();
    ctx.check('arrêt et relance immédiate', true);
  } catch (error) { ctx.check('chaîne Fedora', false, { reason: error.message }); }
  finally { if (app) await app.stop(); }
  return ctx.finish();
}
