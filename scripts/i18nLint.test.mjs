import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const filePath = 'src/tabs/OptionsTab/InterfaceSection.jsx';
async function literalErrors(source, path = filePath) {
  const [result] = await eslint.lintText(source, { filePath: path });
  return result.messages.filter((message) => message.ruleId === 'i18next/no-literal-string');
}

test('la règle i18n refuse la prose, les titres et les textes accessibles sur la surface pilote', async () => {
  const errors = await literalErrors(`export function Fixture() {
    const error = 'Une erreur visible';
    return <div title="Un titre" aria-label="Une description">Texte visible{error}<Toggle ariaLabel="Une bascule" /></div>;
  }`);
  assert.equal(errors.length, 5);
  assert.ok(errors.every((message) => message.severity === 2));
});

test('les identifiants techniques et appels t sont exclus, sans exempter les composants', async () => {
  assert.deepEqual(await literalErrors(`export function Fixture() {
    return <section id="interface" className="opts-row" data-testid="fixture">
      <label htmlFor="ui-language">{t('settings:interface.language.label')}</label>
      <option value="fr">{t('settings:interface.language.french')}</option>
    </section>;
  }`), []);
});

test('la règle i18n couvre désormais la section avancée des réglages', async () => {
  const errors = await literalErrors('export function Fixture() { return <div>Texte existant</div>; }', 'src/tabs/OptionsTab/AdvancedSection.jsx');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].severity, 2);
});
