import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importPack, returnHome, generatePack, modalWithText } from './actions.mjs';
import { openProjectDialog } from './c2-helpers.mjs';
import { save, until } from './c10-helpers.mjs';
import { synthTone, synthImage } from './fixtures.mjs';
import { openCatalogue, preferences, addSource, settledScans, closePreferences } from './c11-helpers.mjs';

export async function reopenRecipePack(page, ctx, events, projectType, { catalogue = false } = {}) {
  const fixtureDir = ctx.dir(`recette-${projectType}`);
  const audio = synthTone(fixtureDir, 'histoire.wav');
  const image = synthImage(fixtureDir, 'couverture.png');
  const input = join(fixtureDir, 'Source.mbah');
  const title = `Recette ${projectType}`;
  const story = { id: 'story', type: 'story', name: 'Nom auteur', audio,
    itemAudio: projectType === 'pack' ? audio : null,
    itemImage: projectType === 'pack' ? image : null,
    controlSettings: { autoplay: false, wheel: false, pause: true, ok: false, home: true },
    treeColor: '#123456' };
  writeFileSync(input, JSON.stringify({
    projectName: title, projectType, rootName: 'Racine auteur', endNodeName: 'Fin auteur',
    treeColor: '#abcdef', rootAudio: audio, rootImage: image, thumbnailImage: image,
    nightModeAudio: audio,
    packMetadata: { title, uuid: projectType === 'simple' ? '11111111-2222-4333-8444-555566667777' : 'aaaaaaaa-2222-4333-8444-555566667777' },
    globalOptions: { autoNext: false, nightMode: false, endNode: true, silenceMode: 'off', harmonizeLoudness: false },
    rootEntries: [story, ...(projectType === 'pack' ? [{
      id: 'folder', type: 'menu', name: 'Dossier auteur', audio, image,
      children: [{ ...story, id: 'nested-story', name: 'Histoire du dossier' }],
    }] : [])],
  }));
  ctx.check(`recette ${projectType} : projet source ouvert`, await openProjectDialog(page, input));
  await until(page, 'titre du projet source', async () => (await page.locator('.chrome-titlebar-project').innerText()) === title);
  const generated = await generatePack(page, ctx.dir(`recette-sortie-${projectType}`), { events });
  ctx.check(`recette ${projectType} : archive générée`, !!generated.zip, generated);
  if (!generated.zip) return;
  await returnHome(page);
  if (catalogue) {
    const source = ctx.dir(`recette-catalogue-${projectType}`);
    copyFileSync(generated.zip, join(source, `${title}.zip`));
    await openCatalogue(page);
    await preferences(page);
    await addSource(page, source);
    await settledScans(page);
    await closePreferences(page);
    await page.locator('[data-card-id]').filter({ hasText: new RegExp(`Recette[ _]${projectType}`) }).first().click();
    await page.locator('#catalogue-fiche-panel').getByRole('button', { name: 'Ouvrir dans l’éditeur', exact: true }).click();
    const chooser = page.getByRole('button', { name: projectType === 'simple' ? 'Éditeur simplifié' : 'Éditeur par menus', exact: true });
    if (await chooser.waitFor({ timeout: 15_000 }).then(() => true, () => false)) await chooser.click();
    await page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout: 120_000 });
    await modalWithText(page, 'Modifier un pack').first().waitFor({ state: 'hidden', timeout: 120_000 });
  } else {
    await importPack(page, generated.zip, { editor: 'menus' });
  }
  const reopened = await save(page, join(ctx.dir(`recette-ouverte-${projectType}`), 'Reouvert.mbah'), { first: true });
  ctx.check(`recette ${projectType} : bon éditeur, intention conservée, aucun oracle actif`,
    reopened.projectType === projectType && !reopened.nativeGraph
      && reopened.rootName === 'Racine auteur' && reopened.endNodeName === 'Fin auteur'
      && reopened.treeColor === '#abcdef' && reopened.globalOptions.endNode
      && reopened.rootEntries[0].name === 'Nom auteur'
      && reopened.rootEntries[0].treeColor === '#123456', { reopened });
  ctx.check(`recette ${projectType} : histoire rouverte jouable`,
    reopened.rootEntries[0].type === 'story', { entry: reopened.rootEntries[0] });
  if (projectType === 'pack') {
    ctx.check('recette pack : dossier et histoire conservés',
      reopened.rootEntries[1].type === 'menu'
        && reopened.rootEntries[1].children[0].type === 'story', { entry: reopened.rootEntries[1] });
  }
  const regenerated = await generatePack(page, ctx.dir(`recette-regeneree-${projectType}`), { events });
  ctx.check(`recette ${projectType} : projet rouvert régénéré sans blocage`, !!regenerated.zip, regenerated);
  await returnHome(page);
}

