// Le panneau Réglages (menus) ou l'Inspecteur (graphe) : l'amener à sa
// largeur minimale par son séparateur, au clavier, comme un auteur.

export async function resizeSettingsToMinimum(page) {
  const separator = page.getByRole('separator', { name: 'Redimensionner les réglages' });
  await separator.waitFor({ timeout: 15_000 });
  const minimum = Number(await separator.getAttribute('aria-valuemin'));
  const current = Number(await separator.getAttribute('aria-valuenow'));
  if (current > minimum) {
    await separator.focus();
    await page.keyboard.press('ArrowLeft');
    const afterLeft = Number(await separator.getAttribute('aria-valuenow'));
    const reducingKey = afterLeft < current ? 'ArrowLeft' : 'ArrowRight';
    if (afterLeft > current) await page.keyboard.press('ArrowRight');
    let value = Number(await separator.getAttribute('aria-valuenow'));
    for (let step = 0; value > minimum && step < 100; step += 1) {
      await page.keyboard.press(reducingKey);
      value = Number(await separator.getAttribute('aria-valuenow'));
    }
  }
  await page.waitForTimeout(300);
  return {
    minimum,
    value: Number(await separator.getAttribute('aria-valuenow')),
    width: await page.locator('.workspace-panel-slot--settings, .advanced-panel-slot--advanced-inspector')
      .last().evaluate((node) => node.getBoundingClientRect().width),
  };
}
