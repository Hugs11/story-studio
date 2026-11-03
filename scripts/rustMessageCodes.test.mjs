import test from 'node:test';
import assert from 'node:assert/strict';
import registry from '../src/locales/_generated/rust-messages.json' with { type: 'json' };
import frozenRegistry from '../src/locales/_generated/rust-messages-frozen.json' with { type: 'json' };

const frozenCodes = new Set(frozenRegistry.map(({ code }) => code));
function validNewCode(code) {
  if (typeof code !== 'string') return false;
  if (code.length <= 40 && /^[A-Z][A-Z0-9]*(_[A-Z0-9]+){2,4}$/.test(code)) return true;
  if (code.length > 48) return false;
  return [...frozenCodes].some((base) => code.startsWith(`${base}_`)
    && /^[A-Z0-9]+(_[A-Z0-9]+)?$/.test(code.slice(base.length + 1)));
}

test('les codes Rust historiques gardent leur contrat d26cd47', () => {
  const current = new Map(registry.map((message) => [message.code, message]));
  for (const historical of frozenRegistry) {
    const { plural: _plural, ...contract } = current.get(historical.code);
    assert.deepEqual(contract, historical, historical.code);
  }
});

test('les nouveaux codes Rust sont courts, structurés et uniques', () => {
  assert.equal(new Set(registry.map(({ code }) => code)).size, registry.length);
  for (const { code } of registry) {
    if (!frozenCodes.has(code)) assert.ok(validNewCode(code), code);
  }
});

test('la garde refuse phrases longues, hachages longs et nombres de segments invalides', () => {
  for (const code of ['FILES_ERROR', 'FILES_AUDIO_READ_FAILED_WITH_DETAIL', 'FILES_AUDIO_READ_FAILED_UNKNOWN_D5B7F7', 'files_audio_read', 'FILES_AUDIO_READ_FAILED_WITHVERYLONGDETAIL']) {
    assert.equal(validNewCode(code), false, code);
  }
  for (const code of ['FILES_AUDIO_ERROR', 'FILES_AUDIO_READ_FAILED', 'CHECKER_AUDIO_MP3_CODEC_INVALID']) assert.equal(validNewCode(code), true, code);
});

test('les codes dérivés d’une base gelée acceptent un ou deux segments jusqu’à 48 caractères', () => {
  const base = 'OPTION_SELECTION_OUT_OF_BOUNDS';
  assert.ok(frozenCodes.has(base));
  for (const code of [`${base}_TRANSITION`, `${base}_TRANSITION_DETAIL`, `${base}_${'X'.repeat(48 - base.length - 1)}`]) {
    assert.ok(validNewCode(code), code);
  }
});

test('les codes dérivés refusent un suffixe trop long ou mal formé', () => {
  const base = 'OPTION_SELECTION_OUT_OF_BOUNDS';
  for (const code of [`${base}_${'X'.repeat(49 - base.length - 1)}`, `${base}_ONE_TWO_THREE`, `${base}_detail`, `${base}_`, `${base}_ONE__TWO`]) {
    assert.equal(validNewCode(code), false, code);
  }
});

test('une base non gelée ne bénéficie pas de la règle des codes dérivés', () => {
  const base = 'UNFROZEN_SELECTION_OUT_OF_BOUNDS';
  assert.equal(frozenCodes.has(base), false);
  for (const suffix of ['TRANSITION', 'ONE_TWO']) assert.equal(validNewCode(`${base}_${suffix}`), false);
});
