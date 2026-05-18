> [🇬🇧 English](release-checklist.md) | 🇫🇷 **Français**

# Checklist de release

Utilise cette checklist quand tu prépares une release publique de Story Studio.

## 1. Préparation

- Relis `CHANGELOG.md` et assure-toi que la section de la release publique est concise et orientée utilisateur.
- Vérifie que le numéro de version est synchronisé dans :
  - `package.json`
  - `package-lock.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/Cargo.lock`
  - `src-tauri/tauri.conf.json`
- Si des captures d'écran sont présentes dans le README, vérifie qu'elles correspondent toujours à l'UI actuelle.
- Vérifie que `THIRD_PARTY_NOTICES.md` correspond aux versions embarquées de `ffmpeg.exe` et `7z.exe`.

## 2. Validation

Lance les commandes de validation de release depuis un checkout propre :

```powershell
npm ci
npm run build
cd src-tauri
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cd ..
npm run tauri build
```

Si `src-tauri/src/native_pack.rs` a changé, teste manuellement au moins :

- Un projet histoire simple
- Un pack multi-menus
- Un pack contenant du ZIP importé
- Une histoire avec navigation personnalisée après lecture

## 3. Build de release

Les artefacts du build sont créés sous :

```text
src-tauri/target/release/bundle/
```

Avant d'uploader les installeurs, vérifie que :

- L'app se lance sur Windows
- La barre de titre affiche la bonne version
- Un nouveau projet peut être enregistré au format `.mbah`
- Un petit pack peut être généré et rouvert par l'émulateur
- Les mentions tierces embarquées sont incluses dans le bundle de l'app

## 4. Release GitHub

Crée une release GitHub à partir du tag de version, par exemple :

```text
v0.8.9
```

Les notes de release doivent inclure :

- Un court résumé humain de la release
- Les ajouts et corrections visibles pour l'utilisateur
- Les notes de migration, le cas échéant
- Les limitations connues, le cas échéant
- Les artefacts d'installeur Windows depuis le bundle Tauri ou le workflow `Release Build`

Pars des notes de release générées par GitHub, puis édite-les pour les clarifier.

## 5. Première publication GitHub publique

Pour la première release publique, ne pousse pas l'historique de dev local si le dépôt doit démarrer propre sur GitHub.

Chemin recommandé :

- Crée un nouveau dépôt GitHub vide et pousse l'arbre `v0.8.9` préparé comme premier commit. Garde ce dépôt local comme historique de travail privé.

Chemin alternatif :

- Crée une branche `main` orpheline à partir de l'arbre préparé, puis pousse cette branche vers GitHub comme branche par défaut publique.

Avant de faire l'un ou l'autre, vérifie que :

- `CHANGELOG.md` contient l'historique public simplifié.
- Aucun fichier local-only n'est tracké.
- Le commit de release est tagué avec la version publique, par exemple `v0.8.9`.

Conserve le dépôt privé/local comme historique de travail si tu en as encore besoin pour référence.

## 6. Après publication

- Vérifie que la page de release pointe bien vers les artefacts uploadés.
- Télécharge l'installeur publié une fois et fais un smoke-test.
- Ouvre un ticket de suivi pour toute dette de release connue, plutôt que de la cacher dans les notes.
