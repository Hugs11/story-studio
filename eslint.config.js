// Configuration ESLint (flat) ciblée sur la détection de CODE MORT intra-fichier
// (imports et variables inutilisés) — complément de `knip` (exports/fichiers/deps
// morts cross-fichier). Volontairement minimale : pas de règles de style, pour que
// `npm run lint` reste un signal « code mort », pas du bikeshed.
//
// `react/jsx-uses-vars` est indispensable : sans lui, un composant utilisé seulement
// en JSX (`<Foo />`) serait faussement signalé comme import inutilisé.

import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

const unusedVarsRule = [
  'warn',
  { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
];

export default [
  { ignores: ['dist/**', 'src-tauri/**', 'node_modules/**'] },
  // Les `eslint-disable` existants visent des règles de style non activées ici
  // (no-console…) : ne pas les signaler comme orphelins.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks, 'unused-imports': unusedImports },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // Règle enregistrée (valide les eslint-disable du code) mais non reportée :
      // hors périmètre « code mort », et bruyante. Activable plus tard si voulu.
      'react-hooks/exhaustive-deps': 'off',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': unusedVarsRule,
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    plugins: { 'unused-imports': unusedImports },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': unusedVarsRule,
    },
  },
];
