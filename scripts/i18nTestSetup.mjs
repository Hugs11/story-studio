import frExamples from '../src/locales/fr/examples.json' with { type: 'json' };
import enExamples from '../src/locales/en/examples.json' with { type: 'json' };
import itExamples from '../src/locales/it/examples.json' with { type: 'json' };
import frHelp from '../src/locales/fr/help.json' with { type: 'json' };
import enHelp from '../src/locales/en/help.json' with { type: 'json' };
import itHelp from '../src/locales/it/help.json' with { type: 'json' };
import frChecker from "../src/locales/fr/checker.json" with { type: 'json' };
import enChecker from "../src/locales/en/checker.json" with { type: 'json' };
import itChecker from "../src/locales/it/checker.json" with { type: 'json' };
import frProduction from "../src/locales/fr/production.json" with { type: 'json' };
import enProduction from "../src/locales/en/production.json" with { type: 'json' };
import itProduction from "../src/locales/it/production.json" with { type: 'json' };
import itAi from '../src/locales/it/ai.json' with { type: 'json' };
import enAi from '../src/locales/en/ai.json' with { type: 'json' };
import frAi from '../src/locales/fr/ai.json' with { type: 'json' };
import itMedia from '../src/locales/it/media.json' with { type: 'json' };
import enMedia from '../src/locales/en/media.json' with { type: 'json' };
import frMedia from '../src/locales/fr/media.json' with { type: 'json' };
import itImport from '../src/locales/it/import.json' with { type: 'json' };
import itNative from '../src/locales/it/native.json' with { type: 'json' };
import enImport from '../src/locales/en/import.json' with { type: 'json' };
import enNative from '../src/locales/en/native.json' with { type: 'json' };
import frImport from '../src/locales/fr/import.json' with { type: 'json' };
import frNative from '../src/locales/fr/native.json' with { type: 'json' };
import frTree from "../src/locales/fr/tree.json" with { type: 'json' };
import enTree from "../src/locales/en/tree.json" with { type: 'json' };
import itTree from "../src/locales/it/tree.json" with { type: 'json' };
import frCatalogue from '../src/locales/fr/catalogue.json' with { type: 'json' };
import enCatalogue from '../src/locales/en/catalogue.json' with { type: 'json' };
import itCatalogue from '../src/locales/it/catalogue.json' with { type: 'json' };
import itHome from '../src/locales/it/home.json' with { type: 'json' };
import enHome from '../src/locales/en/home.json' with { type: 'json' };
import frHome from '../src/locales/fr/home.json' with { type: 'json' };
import itGraph from '../src/locales/it/graph.json' with { type: 'json' };
import itRust from '../src/locales/it/rust.json' with { type: 'json' };
import enGraph from '../src/locales/en/graph.json' with { type: 'json' };
import enRust from '../src/locales/en/rust.json' with { type: 'json' };
import frGraph from '../src/locales/fr/graph.json' with { type: 'json' };
import frRust from '../src/locales/fr/rust.json' with { type: 'json' };
import { createInstance } from 'i18next';
import frCommon from '../src/locales/fr/common.json' with { type: 'json' };
import frSettings from '../src/locales/fr/settings.json' with { type: 'json' };
import enCommon from '../src/locales/en/common.json' with { type: 'json' };
import enSettings from '../src/locales/en/settings.json' with { type: 'json' };
import itCommon from '../src/locales/it/common.json' with { type: 'json' };
import itSettings from '../src/locales/it/settings.json' with { type: 'json' };

export function createTestI18n() {
  const instance = createInstance();
  instance.init({
    lng: 'fr', fallbackLng: 'fr', defaultNS: 'common', initAsync: false,
    returnNull: false, keySeparator: false, interpolation: { escapeValue: false },
    resources: {
      fr: { examples: frExamples, help: frHelp, checker: frChecker, production: frProduction, ai: frAi, media: frMedia, import: frImport, native: frNative, common: frCommon, settings: frSettings, rust: frRust, graph: frGraph, home: frHome, tree: frTree, catalogue: frCatalogue },
      en: { examples: enExamples, help: enHelp, checker: enChecker, production: enProduction, ai: enAi, media: enMedia, import: enImport, native: enNative, common: enCommon, settings: enSettings, rust: enRust, graph: enGraph, home: enHome, tree: enTree, catalogue: enCatalogue },
      it: { examples: itExamples, help: itHelp, checker: itChecker, production: itProduction, ai: itAi, media: itMedia, import: itImport, native: itNative, common: itCommon, settings: itSettings, rust: itRust, graph: itGraph, home: itHome, tree: itTree, catalogue: itCatalogue },
    },
  });
  return instance;
}
