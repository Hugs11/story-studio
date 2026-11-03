import frExamples from '../locales/fr/examples.json';
import enExamples from '../locales/en/examples.json';
import itExamples from '../locales/it/examples.json';
import frHelp from '../locales/fr/help.json';
import enHelp from '../locales/en/help.json';
import itHelp from '../locales/it/help.json';
import frChecker from "../locales/fr/checker.json";
import enChecker from "../locales/en/checker.json";
import itChecker from "../locales/it/checker.json";
import frProduction from "../locales/fr/production.json";
import enProduction from "../locales/en/production.json";
import itProduction from "../locales/it/production.json";
import itAi from '../locales/it/ai.json';
import enAi from '../locales/en/ai.json';
import frAi from '../locales/fr/ai.json';
import itMedia from '../locales/it/media.json';
import enMedia from '../locales/en/media.json';
import frMedia from '../locales/fr/media.json';
import itImport from '../locales/it/import.json';
import itNative from '../locales/it/native.json';
import enImport from '../locales/en/import.json';
import enNative from '../locales/en/native.json';
import frImport from '../locales/fr/import.json';
import frNative from '../locales/fr/native.json';
import frTree from "../locales/fr/tree.json";
import enTree from "../locales/en/tree.json";
import itTree from "../locales/it/tree.json";
import frCatalogue from '../locales/fr/catalogue.json';
import enCatalogue from '../locales/en/catalogue.json';
import itCatalogue from '../locales/it/catalogue.json';
import itHome from '../locales/it/home.json';
import enHome from '../locales/en/home.json';
import frHome from '../locales/fr/home.json';
import itGraph from '../locales/it/graph.json';
import itRust from '../locales/it/rust.json';
import enGraph from '../locales/en/graph.json';
import enRust from '../locales/en/rust.json';
import frGraph from '../locales/fr/graph.json';
import frRust from '../locales/fr/rust.json';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import frCommon from '../locales/fr/common.json';
import frSettings from '../locales/fr/settings.json';
import enCommon from '../locales/en/common.json';
import enSettings from '../locales/en/settings.json';
import itCommon from '../locales/it/common.json';
import itSettings from '../locales/it/settings.json';
import { pseudoResources } from './pseudo.js';
import { updateDocumentLanguage } from './language.js';

export function initializeI18n(language) {
  const resources = {
    fr: { examples: frExamples, help: frHelp, checker: frChecker, production: frProduction, ai: frAi, media: frMedia, import: frImport, native: frNative, common: frCommon, settings: frSettings, rust: frRust, graph: frGraph, home: frHome, tree: frTree, catalogue: frCatalogue },
    en: { examples: enExamples, help: enHelp, checker: enChecker, production: enProduction, ai: enAi, media: enMedia, import: enImport, native: enNative, common: enCommon, settings: enSettings, rust: enRust, graph: enGraph, home: enHome, tree: enTree, catalogue: enCatalogue },
    it: { examples: itExamples, help: itHelp, checker: itChecker, production: itProduction, ai: itAi, media: itMedia, import: itImport, native: itNative, common: itCommon, settings: itSettings, rust: itRust, graph: itGraph, home: itHome, tree: itTree, catalogue: itCatalogue },
  };
  if (import.meta.env.DEV) resources.pseudo = pseudoResources(resources.fr);
  i18n.on('languageChanged', updateDocumentLanguage);
  i18n.use(initReactI18next).init({
    resources, lng: language, defaultNS: 'common', fallbackLng: 'en',
    initAsync: false, returnNull: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    // Les clés sémantiques sont plates dans les fichiers JSON.
    keySeparator: false,
  });
  return i18n;
}

export default i18n;
