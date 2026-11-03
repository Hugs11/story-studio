// Gestes publics des diagnostics, sans mutation directe du document.
import { clickButton, waitValidationSettled } from './actions.mjs';
import { saveProjectAs } from './c2-helpers.mjs';
import { readGraphView } from './c4-helpers.mjs';

const LABELS = {
  'disable-home': /Désactiver le bouton Accueil/,
  'clear-home-transition': /Retirer la destination Accueil/,
};
const MESSAGES = {
  HOME_LOOPS_TO_SELF: 'Le bouton Accueil ramène cet Écran sur lui-même.',
  ENTRY_STAGE_AS_OPTION: 'Un choix de cette liste mène à l’Écran d’entrée.',
};

export async function openDiagnostics(page) {
  const panel = page.locator('[aria-label="Éléments à corriger"]');
  const pill = page.locator('[data-toolbar-id="toggleValidation"]').first();
  await pill.hover();
  if (!await panel.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) await pill.click();
  await panel.waitFor({ timeout: 15_000 });
  return panel;
}

export async function correctDiagnostic(page, resolution) {
  const label = LABELS[resolution];
  if (!label) throw new Error(`Correction non prise en charge : ${resolution}`);
  const panel = await openDiagnostics(page);
  const issue = panel.locator('details.validation-pill-details').filter({
    has: page.locator('button').filter({ hasText: label }),
  }).first();
  await issue.waitFor({ state: 'attached', timeout: 15_000 });
  if (await issue.getAttribute('open') === null) await issue.locator('summary').click();
  await clickButton(issue, label, { timeout: 15_000 });
  await page.keyboard.press('Escape');
}

export async function observeBlocking(page, expectedCodes, savedPath, outDir) {
  const validation = await waitValidationSettled(page);
  const disabled = await page.getByRole('button', { name: /Générer le pack/ }).first().isDisabled();
  const panel = await openDiagnostics(page);
  const items = panel.locator('.validation-pill-item-label');
  const messages = [];
  for (let i = 0, count = await items.count(); i < count; i += 1) messages.push(await items.nth(i).innerText());
  await page.keyboard.press('Escape');
  // Le code exact est fourni par la projection Rust du document enregistré,
  // et corrélé au message visible et au refus UI, pas déduit du manifeste.
  await saveProjectAs(page, savedPath);
  const { view } = await readGraphView(page, savedPath);
  const codes = (view?.diagnostics ?? []).map(diagnostic => diagnostic.code);
  const { readdirSync } = await import('node:fs');
  const outputs = readdirSync(outDir);
  return {
    ok: validation.settled && validation.count === expectedCodes.length && disabled
      && expectedCodes.every(code => codes.includes(code) && MESSAGES[code]
        && messages.some(message => message.trim() === MESSAGES[code]))
      && outputs.length === 0,
    validation, disabled, codes, messages, outputs,
  };
}
