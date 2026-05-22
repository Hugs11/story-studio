> [🇬🇧 English](README.md) | 🇫🇷 **Français**

<p align="center">
  <img src="public/logostory.svg" alt="Story Studio" width="240">
</p>

<p align="center">
  Éditeur Windows moderne pour créer, agréger, tester et exporter des packs d'histoires compatibles Lunii.
</p>

<p align="center">
  <a href=".github/workflows/ci.yml"><img alt="CI: Windows build" src="https://img.shields.io/badge/CI-Windows%20build-2ea44f.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="#configuration-requise"><img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D4.svg"></a>
  <a href="CHANGELOG.md"><img alt="Version 0.9.0" src="https://img.shields.io/badge/version-0.9.0-2F80ED.svg"></a>
  <a href="#statut-beta"><img alt="Status: beta" src="https://img.shields.io/badge/status-beta-f59e0b.svg"></a>
  <a href="https://tauri.app/"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB.svg"></a>
  <a href="https://react.dev/"><img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB.svg"></a>
</p>

Story Studio t'aide à construire des packs d'histoires audio interactives avec
un workflow visuel et 100 % local. Organise tes menus et tes histoires, gère
ton audio et tes images, prévisualise la navigation, agrège des packs ZIP
existants et exporte des fichiers ZIP compatibles Lunii — le tout depuis une
seule application desktop.

> Story Studio est un outil communautaire. Il n'est pas affilié à Lunii, ni
> soutenu ou sponsorisé par Lunii.

## Statut beta

Story Studio est actuellement en beta. L'app est utilisable, mais elle peut
encore contenir des bugs, des cas limites et des problèmes de compatibilité
avec certains packs communautaires. Garde des copies de sauvegarde de tes
projets importants et signale les problèmes reproductibles via les GitHub
issues.

## En un coup d'œil

| | |
|---|---|
| **Statut** | Beta |
| **Plateforme** | Windows desktop |
| **Format projet** | `.mbah` |
| **Format d'export** | Packs ZIP compatibles Lunii |
| **Stack principale** | React 19, Vite, Tauri 2, Rust |
| **Workflow** | Éditeur arborescent visuel, agrégation de packs ZIP, navigation par nœuds, explorateur de médias, simulateur |
| **Vie privée** | App locale, aucun backend hébergé, aucune télémétrie |

## Pourquoi Story Studio ?

Les packs d'histoires deviennent vite difficiles à gérer quand ils contiennent
beaucoup de menus, d'enregistrements, de packs ZIP importés, d'images
générées et de règles de navigation. Story Studio garde toutes ces pièces
visibles et éditables dans un seul espace de travail.

- Construis des histoires simples ou des packs structurés avec menus
  imbriqués.
- Agrège des packs ZIP existants dans des collections personnalisées plus
  larges.
- Importe des packs communautaires, inspecte-les ou modifie-les avant de les ré-exporter.
- Édite tes médias sans perdre de vue où chaque fichier est utilisé.
- Teste la navigation dans le simulateur avant de générer un pack final.
- Garde tes voix générées, images générées, enregistrements et imports bien
  rangés dans les dossiers de l'espace de travail.

## Captures d'écran

![Éditeur Story Studio](docs/assets/screenshots/editor-dark.png)

| Diagramme et simulateur | Explorateur de médias |
|---|---|
| ![Vue diagramme avec simulateur](docs/assets/screenshots/diagram-simulator-dark.png) | ![Explorateur de médias](docs/assets/screenshots/media-explorer-dark.png) |

| Éditeur d'histoire | Métadonnées du pack |
|---|---|
| ![Réglages d'une histoire](docs/assets/screenshots/story-editor-dark.png) | ![Métadonnées du pack](docs/assets/screenshots/pack-metadata-dark.png) |

| Éditeur audio | Préférences |
|---|---|
| ![Éditeur audio](docs/assets/screenshots/audio-editor-dark.png) | ![Préférences en mode clair](docs/assets/screenshots/settings-light.png) |

| Écran d'accueil |
|---|
| ![Écran d'accueil](docs/assets/screenshots/home-dark.png) |

## Fonctionnalités

### Édition de packs

- Modes projet « histoire simple » et « multi-packs ».
- Éditeur visuel pour menus racine, menus imbriqués, histoires, entrées ZIP
  importées et nœuds de fin.
- Organisation par glisser-déposer dans l'arbre, avec multi-sélection,
  copier/couper/coller et actions contextuelles.
- Import de dossier qui peut créer une histoire par fichier audio.
- Aide à la convention de nommage communautaire pour le titre, les
  métadonnées et la version du pack.
- Contrôles de navigation par nœuds pour la lecture, les cibles de retour,
  le comportement du bouton Home et les flux de fin d'histoire — y compris
  les nœuds de fin en mode nuit.
- Vérifications de validation pour les médias manquants courants, les
  problèmes de navigation et de compatibilité.

### Import, prévisualisation et export

- Import de packs ZIP Lunii.
- Inspection des packs importés et extraction en entrées de projet
  éditables.
- Agrégation de packs ZIP importés avec des menus et histoires natifs.
- Choix d'appliquer ou non le traitement global de silence début/fin sur
  l'audio extrait des ZIP.
- Prévisualisation des projets ou des packs importés dans le simulateur
  intégré.
- Génération de packs ZIP compatibles Lunii avec le moteur natif Rust.
- Mise en file de plusieurs rendus de pack avec suivi des logs depuis la
  file de rendu.
- Validation ZIP optionnelle après génération qui signale les problèmes de
  compatibilité sans bloquer l'export.

### Workflow audio

- Enregistrement micro directement depuis l'app.
- Édition audio avec rognage/coupes/fondus basés sur la forme d'onde et
  prévisualisation.
- Assemblage de plusieurs fichiers audio en un MP3.
- Insertion optionnelle de silence entre les fichiers assemblés.
- Import de dossiers de fichiers audio en collections d'histoires.
- Lecture des pochettes MP3 embarquées quand elles sont présentes.
- Gestion des voix générées et enregistrements dans l'espace de travail du
  projet.
- Intégration locale optionnelle XTTS pour la génération de voix.

### Workflow image et média

- Explorateur de médias pour audio, images et fichiers ZIP.
- Recherche, filtres, tri, tags, compteurs d'utilisation et aperçus rapides.
- Glisser des médias dans l'arbre, le diagramme ou les champs de l'éditeur.
- Recadrage/édition d'images et génération d'images textuelles à partir des
  noms de nœuds.
- Redimensionnement automatique des images exportées au format Lunii
  320×240.
- Intégration locale optionnelle ComfyUI pour la génération d'images.

### Outils projet et interface

- Écran d'accueil avec projets récents.
- Modes thème clair, sombre et système.
- Raccourcis clavier configurables.
- Autosave, versions de sécurité et outils de consolidation de projet.
- Vue diagramme complète du pack avec focus de branche et simulateur
  flottant.

### App desktop, 100 % locale

- Pas de backend hébergé.
- Pas de télémétrie.
- Sélection de fichiers large pour les assets choisis par l'utilisateur,
  avec des écritures protégées pour les dossiers projet gérés.
- Outils en ligne de commande embarqués pour les opérations audio et ZIP
  locales.

## Configuration requise

- Windows 10 ou plus récent
- [Node.js](https://nodejs.org/) 20.19+ ou 22.12+
- Toolchain [Rust](https://rustup.rs/) stable
- [Prérequis Tauri v2 Windows](https://v2.tauri.app/start/prerequisites/),
  dont WebView2

Les binaires embarqués ont leurs propres licences, documentées séparément.
Voir [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Installation

### Télécharger une release

Le chemin d'installation recommandé est l'installeur Windows depuis la page
GitHub Releases une fois la première release publique publiée.

### Lancer depuis les sources

```powershell
git clone https://github.com/hugs11/story-studio.git
cd story-studio
npm install
npm run tauri dev
```

Le serveur de dev utilise le port `1420`. Si ce port est déjà occupé :

```powershell
npx kill-port 1420
npm run tauri dev
```

## Développement

Commandes frontend et desktop :

```powershell
# Démarrer l'app Tauri desktop avec hot reload
npm run tauri dev

# Builder uniquement le frontend
npm run build

# Builder l'app desktop Windows complète
npm run tauri build
```

Vérifications Rust :

```powershell
cd src-tauri
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

Les bundles de release sont générés dans :

```text
src-tauri/target/release/bundle/
```

Si tu modifies `src-tauri/src/native_pack.rs`, lance les tests Rust. Ce
fichier contient le moteur natif de génération de packs, où de petites
régressions peuvent produire des packs invalides.

## Fichiers projet et espace de travail

Story Studio enregistre les projets sous forme de fichiers `.mbah`. Les
assets d'exécution sont organisés dans des dossiers d'espace de travail
gérés :

| Dossier | Rôle |
|---|---|
| `fichiers-importes/` | Médias importés quand la copie à l'import est activée |
| `enregistrements/` | Enregistrements micro |
| `voix-generees/` | Clips vocaux générés par XTTS |
| `images-generees/` | Images générées par ComfyUI et images éditées |
| `zips-extraits/` | Collections ZIP décompressées |
| `sauvegardes/` | Dossier de sauvegarde par défaut + versions de sécurité |
| `exports/` | Dossier de sortie suggéré pour les packs générés |

Les fichiers dans les dossiers médias gérés utilisent un préfixe
`{nom-du-projet}__` pour que plusieurs projets puissent partager le même
espace de travail sans risque.

Quand Story Studio te propose de supprimer un média du disque, il ne
supprime que les fichiers à l'intérieur des dossiers médias gérés de
l'espace de travail. Les fichiers sources externes ne sont retirés que de
la référence projet ou bibliothèque médias.

## Documentation

- [Guide d'installation XTTS](docs/guides/xtts-setup.fr.md)
- [Guide d'installation ComfyUI](docs/guides/comfyui-setup.fr.md)
- [Modèle de sécurité](SECURITY.md)
- [Mentions tierces](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

> ℹ️ Les trois derniers documents (SECURITY, THIRD_PARTY_NOTICES, CHANGELOG) sont uniquement en anglais pour le moment.

## Roadmap

Priorités à court terme :

- Publier le premier installeur beta depuis le workflow de release `v0.9.0`.
- Smoke-tester une installation fraîche sur Windows avant de partager la
  beta plus largement.
- Continuer à améliorer la compatibilité import/export avec les packs
  communautaires.
- Garder les workflows audio et média accessibles aux créateurs non
  techniques.

Idées à plus long terme :

- Onboarding plus guidé pour les premières créations de packs.
- Meilleurs diagnostics pour les packs importés inhabituels.
- Projet d'exemple optionnel pour tester l'éditeur rapidement.
- Documentation étendue pour les workflows de navigation avancés.

## Contribuer

Les contributions sont les bienvenues, en particulier :

- Rapports de bugs reproductibles.
- Notes de compatibilité pour les packs communautaires.
- Améliorations de la documentation.
- Pull requests ciblées avec des notes de test claires.

Merci de lire [CONTRIBUTING.md](CONTRIBUTING.md) avant d'ouvrir une pull
request.

## Sécurité

Story Studio est un éditeur de fichiers desktop local. Les fonctionnalités
optionnelles XTTS et ComfyUI se connectent à des services locaux configurés
par l'utilisateur.

Voir [SECURITY.md](SECURITY.md) pour le modèle de permissions et la
procédure de signalement des vulnérabilités.

## Licence

Le code source de Story Studio est sous licence [MIT](LICENSE).

Les binaires tiers embarqués et les assets tiers copiés restent sous leurs
licences respectives. Voir [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
