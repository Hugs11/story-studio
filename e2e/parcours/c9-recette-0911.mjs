// Parcours de vérification 0.9.11 sans Lunii : points vérifiables dans l'app réelle,
// sans appareil ni réseau. Chaque section est isolée : un échec n'arrête pas les suivantes.
// Aucune donnée personnelle ; profil e2e isolé.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { MODALS, goHome, newProject, openPackMetadata, returnHome } from '../lib/actions.mjs';

const active = page => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

async function section(ctx, events, name, body) {
  events.setStep(name);
  try { await body(); } catch (error) { ctx.check(`${name} : parcours interrompu : ${error.message}`, false); }
}

// Catalogue : Ctrl+F (#14), pas de bouton « Notifications » (#23).
async function catalogue(ctx, page) {
  await goHome(page);
  await page.locator('#mode-open-catalogue').click();
  await page.locator('#catalogue-search').waitFor({ timeout: 30_000 });
  // Question de démarrage (titres officiels) : on répond « Non » pour libérer l'écran.
  const question = page.locator('[role="alertdialog"]').filter({ hasText: 'Compléter' });
  if (await question.count()) await question.getByRole('button', { name: 'Non', exact: true }).click();
  await page.waitForTimeout(500);
  ctx.check('catalogue : aucun bouton « Notifications » dans la barre', await page.getByRole('button', { name: /^Notifications/ }).count() === 0);
  await page.locator('.catalogue-scroll, .catalogue-statusbar').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur?.());
  ctx.check('catalogue : la recherche n\'a pas le focus avant Ctrl+F', await active(page) !== 'catalogue-search');
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(300);
  ctx.check('catalogue : Ctrl+F donne le focus à la recherche', await active(page) === 'catalogue-search', { active: await active(page) });
  await page.keyboard.type('conte');
  ctx.check('catalogue : la saisie arrive dans la recherche', await page.locator('#catalogue-search').inputValue() === 'conte');
  ctx.check('catalogue : pas de liste déroulante sous la recherche',
    await page.locator('[role="listbox"]:visible, [role="menu"]:visible').count() === 0);
  await ctx.shot(page, 'catalogue-recherche');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ctx.check('catalogue : Échap vide la recherche', await page.locator('#catalogue-search').inputValue() === '');
  // Ctrl+F alors que le focus est dans la recherche : reste sur la recherche.
  await page.keyboard.press('Control+f');
  ctx.check('catalogue : Ctrl+F dans la recherche garde le focus', await active(page) === 'catalogue-search');
}

// Préférences : avis de version (#21) et suivis des médias (#23).
async function preferences(ctx, page) {
  await goHome(page);
  await page.keyboard.press('Control+,');
  const dialog = page.locator(MODALS).filter({ hasText: 'Préférences' }).first();
  await dialog.waitFor({ timeout: 15_000 });
  const rows = dialog.locator('#interface .opts-row');
  const count = await rows.count();
  const last = rows.nth(count - 1);
  ctx.check('Préférences > Interface : la dernière ligne est « Prévenir des nouvelles versions »',
    (await last.locator('.opts-row-label').innerText()).trim() === 'Prévenir des nouvelles versions', { count });
  const toggle = last.locator('button.tog');
  const before = await toggle.getAttribute('aria-pressed');
  await toggle.click();
  await page.waitForTimeout(300);
  const after = await toggle.getAttribute('aria-pressed');
  ctx.check('Préférences > Interface : l\'interrupteur de l\'avis de version bascule', before !== after, { before, after });
  await toggle.click();
  ctx.check('Préférences > Interface : et revient à son état', await toggle.getAttribute('aria-pressed') === before);
  const subs = dialog.locator('#media-subscriptions');
  await subs.scrollIntoViewIfNeeded();
  ctx.check('Préférences : « Suivis des médias » liste les notifications et les abonnements',
    await subs.getByRole('heading', { name: 'Notifications' }).count() === 1 && await subs.getByRole('heading', { name: 'Abonnements' }).count() === 1
    && await subs.getByRole('button', { name: 'Vérifier maintenant' }).count() === 1);
  await ctx.shot(page, 'preferences-suivis');
  ctx.check('aucun avis de version à l\'écran (hors ligne ou jamais accepté)',
    await page.getByText(/Story Studio \d+\.\d+\.\d+ est disponible/).count() === 0);
  await page.keyboard.press('Escape');
}

// Métadonnées d'un projet vierge (#11) : « Sans titre », titre vide, âge recliqué.
async function metadata(ctx, page, mode, label) {
  await goHome(page);
  await newProject(page, mode);
  const recap = page.locator('.chrome-titlebar-pack-recap');
  const recapText = (await recap.innerText()).trim();
  ctx.check(`${label} : bandeau « Sans titre »`, /Sans titre/.test(recapText), { recapText });
  const sheet = await openPackMetadata(page);
  const title = sheet.locator('.pack-meta-input').first();
  ctx.check(`${label} : titre de la fiche vide`, await title.inputValue() === '');
  const age = sheet.locator('.pack-meta-age-chip').filter({ hasText: /^6\+$/ });
  ctx.check(`${label} : aucune puce d'âge active`, await sheet.locator('.pack-meta-age-chip[aria-pressed="true"]').filter({ hasText: /^\d+\+$/ }).count() === 0);
  await age.click();
  ctx.check(`${label} : « 6+ » devient actif`, await age.getAttribute('aria-pressed') === 'true');
  await age.click();
  ctx.check(`${label} : recliquer « 6+ » vide l'âge`, await age.getAttribute('aria-pressed') === 'false'
    && await sheet.locator('.pack-meta-input[aria-label="Âge minimum personnalisé"], .pack-meta-age-input').first().inputValue().catch(() => '') === '');
  const sheetText = await sheet.innerText();
  ctx.check(`${label} : aucun nom proposé du type « Menu 1 » / « Écran 1 »`, !/Menu 1|Écran 1/.test(await title.inputValue()), { sheetText: sheetText.slice(0, 400) });
  await ctx.shot(page, `fiche-${mode}`);
  await sheet.getByRole('button', { name: 'Annuler', exact: true }).click();
  await returnHome(page);
}

// Le nom de la racine renommée est proposé comme titre (#11), jamais « Menu racine ».
async function renameRoot(ctx, page) {
  await goHome(page);
  await newProject(page, 'pack');
  await page.locator('.root-identity-card .field-input, .field-input').first().fill('Mon conte du soir');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
  const sheet = await openPackMetadata(page);
  const value = await sheet.locator('.pack-meta-input').first().inputValue();
  ctx.check('menus : la racine renommée est proposée comme titre dans la fiche', value === 'Mon conte du soir', { value });
  await sheet.getByRole('button', { name: 'Annuler', exact: true }).click();
  await returnHome(page);
}

export async function run() {
  const ctx = createRun('c9-recette-0911');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
  const { page, events } = app;
  try {
    await section(ctx, events, 'preferences', () => preferences(ctx, page));
    await section(ctx, events, 'metadonnees-menus', () => metadata(ctx, page, 'pack', 'menus'));
    await section(ctx, events, 'metadonnees-graphe', () => metadata(ctx, page, 'advanced', 'graphe'));
    await section(ctx, events, 'racine-renommee', () => renameRoot(ctx, page));
    // Dernier : le Catalogue n'a pas de retour à l'accueil scripté.
    await section(ctx, events, 'catalogue', () => catalogue(ctx, page));
    ctx.check('aucune erreur console ni exception', events.faults().length === 0, { faults: events.faults() });
  } finally {
    const stop = await app.stop();
    ctx.check('rien d\'écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
