// vérifier les deux colonnes Réglages à leur nouvelle largeur minimale.
// Usage : node e2e/run.mjs c7-s8-reglages-etroits <archive.zip>

import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack, returnHome } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { resizeSettingsToMinimum } from '../lib/settings-panel.mjs';

async function menuLayout(page) {
  return page.locator('.workspace-panel-slot--settings').evaluate((panel) => {
    const body = panel.querySelector('.settings-panel-body');
    const bodyRect = body.getBoundingClientRect();
    const cards = [...body.querySelectorAll('.card')].map((card) => {
      const title = card.querySelector('.card-title')?.textContent?.trim()
        ?? card.querySelector('h2, h3, legend')?.textContent?.trim()
        ?? card.className;
      const overflowingChildren = [...card.querySelectorAll('*')]
        .filter((node) => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 4)
        .slice(0, 5)
        .map((node) => ({
          className: typeof node.className === 'string' ? node.className : node.tagName,
          text: node.innerText?.trim().slice(0, 48) ?? '',
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          minWidth: getComputedStyle(node).minWidth,
        }));
      return {
        title,
        width: Math.round(card.getBoundingClientRect().width),
        contentWidth: card.clientWidth,
        scrollWidth: card.scrollWidth,
        bounds: (() => {
          const rect = card.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        })(),
        overflowingChildren,
      };
    });
    const bodyContentLeft = bodyRect.left + body.clientLeft;
    const bodyContentRight = bodyContentLeft + body.clientWidth;
    return {
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      bodyWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      bodyBounds: { left: bodyRect.left, right: bodyRect.right },
      cards,
      cardsOutsideBody: cards.filter((card) => card.bounds.left < bodyContentLeft - 1
        || card.bounds.right > bodyContentRight + 1).map((card) => card.title),
    };
  });
}

async function inspectAudioPlayers(page, panelSelector) {
  return page.locator(panelSelector).evaluate((panel) => [...panel.querySelectorAll('.audio-bar')].map((bar) => {
    const bounds = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const barBounds = bounds(bar);
    const waveBounds = bounds(bar.querySelector('.audio-wave-tip .wave'));
    const durationBounds = bounds(bar.querySelector('.audio-duration'));
    const actionButtons = [...bar.querySelectorAll('.audio-bar-actions button')];
    const visibleActionButtons = actionButtons.filter((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && rect.left >= barBounds.left - 1 && rect.right <= barBounds.right + 1
        && rect.top >= barBounds.top - 1 && rect.bottom <= barBounds.bottom + 1;
    });
    const overlaps = (left, right) => !!left && !!right
      && Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;
    return {
      width: Math.round(barBounds.width),
      display: getComputedStyle(bar).display,
      durationText: bar.querySelector('.audio-duration')?.textContent?.trim() ?? null,
      durationInside: !!durationBounds && durationBounds.left >= barBounds.left - 1
        && durationBounds.right <= barBounds.right + 1,
      waveDurationOverlap: overlaps(waveBounds, durationBounds),
      actionLabels: actionButtons.map((button) => button.getAttribute('aria-label')),
      actionCount: actionButtons.length,
      visibleActionCount: visibleActionButtons.length,
    };
  }));
}

async function inspectGraphControls(page) {
  return page.locator('.advanced-panel-slot--advanced-inspector').evaluate((panel) => {
    const card = panel.querySelector('.advanced-controls');
    if (!card) return { found: false, rows: [] };
    const rect = card.getBoundingClientRect();
    const cardBounds = { left: rect.left, right: rect.right };
    const rows = [...card.querySelectorAll('.sequence-control')].map((row) => {
      const rowRect = row.getBoundingClientRect();
      const labelRect = row.querySelector(':scope > span')?.getBoundingClientRect();
      const toggleRect = row.querySelector('.tog')?.getBoundingClientRect();
      return {
        label: row.querySelector(':scope > span')?.textContent?.trim() ?? '',
        rowInside: rowRect.left >= cardBounds.left - 1 && rowRect.right <= cardBounds.right + 1,
        labelInside: !labelRect || (labelRect.left >= rowRect.left - 1 && labelRect.right <= rowRect.right + 1),
        toggleInside: !toggleRect || (toggleRect.left >= rowRect.left - 1 && toggleRect.right <= rowRect.right + 1),
      };
    });
    return {
      found: true,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      cardWidth: Math.round(card.getBoundingClientRect().width),
      cardScrollWidth: card.scrollWidth,
      cardClientWidth: card.clientWidth,
      rows,
      allInside: rows.length > 0 && rows.every((row) => row.rowInside && row.labelInside && row.toggleInside),
    };
  });
}

async function inspectActionArrivals(page) {
  return page.locator('.advanced-panel-slot--advanced-inspector').evaluate((panel) => {
    const sections = [...panel.querySelectorAll('.advanced-editor__section')];
    const choices = sections.find((section) => section.querySelector('.card-title')?.textContent?.includes('Ordre des choix'));
    const access = sections.find((section) => section.querySelector('.card-title')?.textContent?.includes('Comment on arrive sur cette liste'));
    // Chaque Écran qui ouvre la liste porte son « commence sur [choix] ».
    const arrivalRows = [...(access?.querySelectorAll('.advanced-exit__landing') ?? [])];
    const phraseLines = (phrase) => {
      if (!phrase) return 0;
      const range = document.createRange();
      range.selectNodeContents(phrase);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    };
    return {
      found: !!access,
      choiceCount: choices?.querySelectorAll('.advanced-options > .advanced-options__row').length ?? 0,
      arrivalCount: arrivalRows.length,
      arrivals: arrivalRows.map((row) => {
        const phrase = row.querySelector('.advanced-options__verb') ?? row.querySelector('select');
        const phraseRect = phrase?.getBoundingClientRect();
        const cardRect = access.getBoundingClientRect();
        return {
          phrase: phrase?.textContent?.trim() ?? '',
          lineCount: phraseLines(phrase),
          phraseWidth: phraseRect ? Math.round(phraseRect.width) : 0,
          insideCard: !phraseRect || (phraseRect.left >= cardRect.left - 1 && phraseRect.right <= cardRect.right + 1),
          overflowWrap: phrase ? getComputedStyle(phrase).overflowWrap : null,
        };
      }),
    };
  });
}

async function findActionWithMostArrivals(page) {
  const actions = page.locator('li[role="option"][data-kind="action"]');
  const count = await actions.count();
  let best = { index: -1, name: null, score: -1, layout: { found: false } };
  for (let index = 0; index < count; index += 1) {
    const action = actions.nth(index);
    const name = (await action.innerText()).trim().split('\n')[0];
    await action.click();
    await page.waitForTimeout(100);
    const layout = await inspectActionArrivals(page);
    const score = layout.arrivalCount * 100 + layout.choiceCount;
    if (score > best.score) best = { index, name, score, layout };
  }
  if (best.index >= 0) {
    await actions.nth(best.index).click();
    await page.waitForTimeout(150);
    best.layout = await inspectActionArrivals(page);
  }
  return { actionCount: count, ...best };
}

async function captureSettingsSection(page, selector, name, ctx) {
  const section = page.locator(selector).first();
  if (!await section.count()) return false;
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  await ctx.shot(page, name);
  return true;
}

async function captureCardSections(page, selector, prefix, ctx) {
  const cards = page.locator(selector);
  const count = await cards.count();
  const captured = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const title = await card.evaluate((node) => (
      node.querySelector('.card-title, h2, h3, .card-danger-title')?.textContent?.trim()
        || node.className
        || 'réglages'
    ));
    const slug = title.normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'reglages';
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(90);
    await ctx.shot(page, `${prefix}-${String(index + 1).padStart(2, '0')}-${slug}`);
    captured.push(title);
  }
  return captured;
}

async function graphDestinationLayout(page) {
  return page.locator('.advanced-panel-slot--advanced-inspector').evaluate((panel) => {
    // La destination de la suite du parcours : la première ligne de sortie
    // qui ouvre une liste (elle porte le compteur de choix).
    const row = [...panel.querySelectorAll('.advanced-exit__row')]
      .find((candidate) => candidate.querySelector('.advanced-count'));
    if (!row) return { found: false };
    const rowRect = row.getBoundingClientRect();
    const pill = row.querySelector('.advanced-count');
    const pillStyle = pill ? getComputedStyle(pill) : null;
    const pillRect = pill?.getBoundingClientRect();
    const edit = row.querySelector('.advanced-options__edit');
    const editRect = edit?.getBoundingClientRect();
    const insideRow = (rect) => !rect || (
      rect.left >= rowRect.left - 1 && rect.right <= rowRect.right + 1
      && rect.top >= rowRect.top - 1 && rect.bottom <= rowRect.bottom + 1
    );
    return {
      found: true,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      rowWidth: row.clientWidth,
      rowScrollWidth: row.scrollWidth,
      pillText: pill?.textContent?.trim() ?? null,
      pillWhiteSpace: pillStyle?.whiteSpace ?? null,
      pillHeight: pillRect ? Math.round(pillRect.height) : null,
      pillInsideRow: insideRow(pillRect),
      editInsideRow: insideRow(editRect),
      destinationText: row.querySelector('.advanced-options__target')?.textContent?.trim() ?? null,
    };
  });
}

async function findStageWithMostChoices(page) {
  const stages = page.locator('li[role="option"][data-kind="stage"]');
  const count = await stages.count();
  let best = { index: -1, name: null, choiceCount: -1, layout: { found: false } };
  for (let index = 0; index < count; index += 1) {
    const stage = stages.nth(index);
    const name = (await stage.innerText()).trim().split('\n')[0];
    await stage.click();
    await page.waitForTimeout(100);
    const layout = await graphDestinationLayout(page);
    const choiceCount = Number(layout.pillText?.match(/\d+/)?.[0] ?? 0);
    if (choiceCount > best.choiceCount) best = { index, name, choiceCount, layout };
  }
  if (best.index >= 0) {
    await stages.nth(best.index).click();
    await page.waitForTimeout(150);
    best.layout = await graphDestinationLayout(page);
  }
  return { stageCount: count, ...best };
}

export async function run(args = []) {
  const [archive] = args;
  const ctx = createRun('c7-s8-reglages-etroits');
  if (!archive) {
    ctx.check('archive fournie en argument', false, { usage: 'node e2e/run.mjs c7-s8-reglages-etroits <archive.zip>' });
    return ctx.finish();
  }

  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
  const menus = [];
  let graph = null;
  const graphCardScreenshots = { root: [], stage: [], action: [] };
  try {
    const { page, events } = app;

    await importPack(page, archive, { editor: 'menus' });
    await ctx.shot(page, 'menus-sans-diagramme');
    const diagramToggle = page.locator('[data-toolbar-id="toggle-diagram"]');
    const diagramIsVisible = await diagramToggle.getAttribute('aria-pressed') === 'true';
    if (!diagramIsVisible) await diagramToggle.click();
    await page.locator('.workspace--with-diagram').waitFor({ timeout: 15_000 });
    await ctx.shot(page, 'menus-avec-diagramme');
    const separators = await page.locator('[role="separator"]').evaluateAll((nodes) => nodes.map((node) => ({
      label: node.getAttribute('aria-label'),
      minimum: node.getAttribute('aria-valuemin'),
      value: node.getAttribute('aria-valuenow'),
      bounds: (() => {
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.x), width: Math.round(rect.width), visible: rect.width > 0 && rect.height > 0 };
      })(),
    })));
    ctx.check('menus : le diagramme ouvert rend la colonne Réglages redimensionnable',
      separators.some((separator) => separator.label === 'Redimensionner les réglages' && separator.bounds.visible),
      { viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), separators });
    const menuWidth = await resizeSettingsToMinimum(page);
    ctx.check('menus : le séparateur atteint 200 px', menuWidth.minimum === 200
      && menuWidth.value === 200 && Math.abs(menuWidth.width - 200) <= 2, menuWidth);

    const menuNodeTypes = [
      { name: 'racine', selector: '.tree-item--root' },
      { name: 'histoire', selector: '.tree-item--story' },
      { name: 'dossier', selector: '.tree-item--menu' },
      { name: 'nœud de fin', selector: '.tree-item--end-node' },
    ];
    const availableTypes = [];
    for (const type of menuNodeTypes) {
      const node = page.locator(type.selector).first();
      if (!await node.count()) continue;
      availableTypes.push(type.name);
      await node.click();
      await page.waitForTimeout(150);
      const metrics = await menuLayout(page);
      const audioPlayers = await inspectAudioPlayers(page, '.workspace-panel-slot--settings');
      menus.push({ type: type.name, ...metrics, audioPlayers });
      ctx.check(`menus à 200 px / ${type.name} : les cartes restent dans les réglages`,
        metrics.panelWidth === 200 && metrics.cardsOutsideBody.length === 0
          && metrics.bodyScrollWidth <= metrics.bodyWidth + 2,
        metrics);
      ctx.check(`menus à 200 px / ${type.name} : durée et actions audio restent visibles`,
        audioPlayers.length > 0 && audioPlayers.every((player) => player.durationInside
          && !player.waveDurationOverlap && player.actionCount >= 2
          && player.visibleActionCount === player.actionCount),
        { audioPlayers });
      await ctx.shot(page, `menus-200-${type.name.replaceAll(' ', '-')}`);
      const cardScreenshots = await captureCardSections(
        page,
        '.workspace-panel-slot--settings .settings-panel-body .card',
        `menus-${type.name.replaceAll(' ', '-')}-option`,
        ctx,
      );
      menus[menus.length - 1].cardScreenshots = cardScreenshots;
      if (type.name === 'histoire') {
        await captureSettingsSection(page, '.during-play-card', 'menus-200-histoire-commandes', ctx);
      } else if (type.name === 'dossier') {
        await captureSettingsSection(page, '.menu-behavior-card', 'menus-200-dossier-commandes', ctx);
      } else if (type.name === 'nœud de fin') {
        await captureSettingsSection(page, '.end-message-playback-choice', 'menus-200-fin-lecture', ctx);
      }
    }
    ctx.check('menus : les quatre types de réglages sont présents',
      menuNodeTypes.every((type) => availableTypes.includes(type.name)), { availableTypes });
    await returnHome(page);

    await importPack(page, archive, { editor: 'graphe' });
    const graphWidth = await resizeSettingsToMinimum(page);
    ctx.check('graphe : le séparateur atteint 200 px', graphWidth.minimum === 200
      && graphWidth.value === 200 && Math.abs(graphWidth.width - 200) <= 2, graphWidth);

    const stageItems = page.locator('li[role="option"][data-kind="stage"]');
    const rootIndex = await stageItems.evaluateAll((items) => items.findIndex(
      (item) => item.querySelector('.advanced-search__root-badge'),
    ));
    if (rootIndex >= 0) {
      await stageItems.nth(rootIndex).click();
      await page.waitForTimeout(150);
      await page.locator('.advanced-inspector--editor').evaluate((panel) => { panel.scrollTop = 0; });
      ctx.check('graphe : l’Écran racine est présent', true, { rootIndex });
      await ctx.shot(page, 'graphe-ecran-racine-200');
      graphCardScreenshots.root = await captureCardSections(
        page,
        '.advanced-inspector--editor .advanced-editor > .card, .advanced-inspector--editor .advanced-editor > .advanced-editor__section',
        'graphe-racine-option',
        ctx,
      );
    } else {
      ctx.check('graphe : l’Écran racine est présent', false, { stageCount: await stageItems.count() });
    }

    const stageScan = await findStageWithMostChoices(page);
    graph = stageScan.layout;
    const graphAudioPlayers = await inspectAudioPlayers(page, '.advanced-panel-slot--advanced-inspector');
    const controlsLayout = await inspectGraphControls(page);
    ctx.check('graphe : un Écran avec le plus grand nombre de choix est sélectionné',
      stageScan.stageCount > 0 && stageScan.index >= 0 && graph.found,
      { stageCount: stageScan.stageCount, selected: stageScan.name, choiceCount: stageScan.choiceCount });
    ctx.check('graphe à 200 px : pastille de choix sur une ligne, sans déborder', graph.found
      && graph.pillWhiteSpace === 'nowrap'
      && graph.pillHeight <= 20
      && graph.pillInsideRow
      && graph.editInsideRow
      && graph.rowScrollWidth <= graph.rowWidth + 2, graph);
    ctx.check('graphe à 200 px : les interrupteurs restent dans leur carte', controlsLayout.found
      && controlsLayout.panelWidth === 200
      && controlsLayout.cardScrollWidth <= controlsLayout.cardClientWidth + 2
      && controlsLayout.allInside, controlsLayout);
    ctx.check('graphe à 200 px : durée et actions audio restent visibles',
      graphAudioPlayers.length > 0 && graphAudioPlayers.every((player) => player.durationInside
        && !player.waveDurationOverlap && player.actionCount >= 2
        && player.visibleActionCount === player.actionCount),
      { audioPlayers: graphAudioPlayers });

    await page.locator('.advanced-inspector--editor').evaluate((panel) => { panel.scrollTop = 0; });
    await ctx.shot(page, 'graphe-ecran-controles-et-choix-200');
    await captureSettingsSection(page, '.advanced-controls', 'graphe-ecran-boutons-et-lecture-200', ctx);
    await page.locator('.advanced-inspector--editor').evaluate((panel) => { panel.scrollTop = 0; });
    graphCardScreenshots.stage = await captureCardSections(
      page,
      '.advanced-inspector--editor .advanced-editor > .card, .advanced-inspector--editor .advanced-editor > .advanced-editor__section',
      'graphe-ecran-option',
      ctx,
    );

    const actionScan = await findActionWithMostArrivals(page);
    const actionLayout = actionScan.layout;
    ctx.check('graphe : une Liste de choix avec des arrivées est sélectionnée',
      actionScan.actionCount > 0 && actionScan.index >= 0 && actionLayout.found
        && actionLayout.arrivalCount > 0,
      { actionCount: actionScan.actionCount, selected: actionScan.name, choiceCount: actionLayout.choiceCount, arrivalCount: actionLayout.arrivalCount });
    ctx.check('graphe à 200 px : les textes d’arrivée restent horizontaux et dans la carte',
      actionLayout.arrivalCount > 0 && actionLayout.arrivals.every((arrival) => arrival.lineCount <= 4
        && arrival.phraseWidth > 40 && arrival.insideCard && arrival.overflowWrap === 'normal'),
      actionLayout);
    await page.locator('.advanced-inspector--editor').evaluate((panel) => { panel.scrollTop = 0; });
    await ctx.shot(page, 'graphe-liste-de-choix-200');
    graphCardScreenshots.action = await captureCardSections(
      page,
      '.advanced-inspector--editor .advanced-editor > .card, .advanced-inspector--editor .advanced-editor > .advanced-editor__section',
      'graphe-liste-option',
      ctx,
    );
    const accessTitle = page.getByText('Comment on arrive sur cette liste', { exact: true });
    if (await accessTitle.count()) {
      await accessTitle.first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(120);
      await ctx.shot(page, 'graphe-liste-acces-200');
      const arrivalRows = page.locator('.advanced-exit__landing');
      if (await arrivalRows.count() > 2) {
        await arrivalRows.last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(120);
        await ctx.shot(page, 'graphe-liste-acces-suite-200');
      }
    }
    ctx.check('parcours sans erreur console ou IPC', events.faults().length === 0, { faults: events.faults() });
    await returnHome(page);
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    await returnHome(app.page).catch(() => {});
    await answerNext(app.page, 'ask', false);
    const stop = await app.stop({ graceful: true });
    ctx.check('fermeture propre et workspace réel intact', stop.closedGracefully && stop.polluted.length === 0, stop);
  }
  return ctx.finish({ menus, graph: { ...(graph ?? {}), cardScreenshots: graphCardScreenshots } });
}
