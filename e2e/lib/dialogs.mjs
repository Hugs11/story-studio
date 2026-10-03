// Réponses scriptées aux boîtes de dialogue (voir `e2e/shim/dialog.js`).
//
// `answerNext(page, 'open', 'C:\\…\\pack.zip')` pose la réponse que recevra le
// prochain `open()` de l'application. Le journal des appels dit ce que
// l'application a demandé (titre, `defaultPath`, filtres) : c'est un fait
// utile aux oracles de chemins.
export async function answerNext(page, kind, value) {
  await page.evaluate(([dialogKind, dialogValue]) => {
    if (!Array.isArray(window.__E2E_DIALOGS__)) window.__E2E_DIALOGS__ = [];
    window.__E2E_DIALOGS__.push({ kind: dialogKind, value: dialogValue });
  }, [kind, value]);
}

export async function dialogLog(page) {
  return page.evaluate(() => window.__E2E_DIALOG_LOG__ ?? []);
}

// Retire uniquement la réponse devenue inutile quand l'app refuse l'opération
// avant d'ouvrir sa boîte native ; les autres réponses restent disponibles.
export async function discardPendingAnswer(page, kind, value) {
  await page.evaluate(([dialogKind, dialogValue]) => {
    const pending = window.__E2E_DIALOGS__ ?? [];
    const index = pending.findIndex(entry => entry.kind === dialogKind && entry.value === dialogValue);
    if (index >= 0) pending.splice(index, 1);
  }, [kind, value]);
}

// Vrai seulement si le shim est chargé : le module réel ne journalise rien.
export async function shimActive(page) {
  return page.evaluate(async () => {
    const before = (window.__E2E_DIALOG_LOG__ ?? []).length;
    window.__E2E_DIALOGS__ = [...(window.__E2E_DIALOGS__ ?? []), { kind: 'message', value: undefined }];
    const mod = await import('/@id/@tauri-apps/plugin-dialog').catch(() => null);
    if (!mod) return false;
    await mod.message('sonde e2e');
    return (window.__E2E_DIALOG_LOG__ ?? []).length === before + 1;
  });
}
