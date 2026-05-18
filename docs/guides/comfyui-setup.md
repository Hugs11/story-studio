# Guide d'installation — Images IA (ComfyUI)

> **Version** : Story Studio 0.8.7 · Windows 10/11 · Dernière mise à jour : 2026-05-16

ComfyUI est un outil de génération d'images par intelligence artificielle (basé sur Stable Diffusion). Il produit des illustrations pour tes histoires à partir de descriptions textuelles, directement sur ton ordinateur.

Cet outil est optionnel. Story Studio fonctionne parfaitement sans lui — tu peux toujours utiliser tes propres images.

---

## Prérequis système

| Élément | Minimum | Recommandé |
|---|---|---|
| Système | Windows 10 64-bit | Windows 11 64-bit |
| RAM | 8 Go | 16 Go |
| GPU NVIDIA | 4 Go VRAM | 8 Go VRAM+ |
| Espace disque | 10 Go libres | 30 Go libres |

> **Sans GPU NVIDIA** : ComfyUI peut fonctionner sur CPU mais la génération dure plusieurs minutes par image. Ce n'est praticable que pour des tests occasionnels. Pour un usage régulier, un GPU NVIDIA est fortement recommandé.

---

## 1. Installation de ComfyUI

La manière la plus simple sur Windows est d'utiliser le **pack portable officiel** de ComfyUI.

**Étape 1** — Va sur la page GitHub de ComfyUI :
`https://github.com/comfyanonymous/ComfyUI`

**Étape 2** — Dans la section **Releases** (colonne de droite), télécharge la dernière version du fichier nommé :
- `ComfyUI_windows_portable_nvidia.7z` (pour GPU NVIDIA)
- ou `ComfyUI_windows_portable_cpu.7z` (pour CPU uniquement)

[SCREENSHOT: Page GitHub ComfyUI avec la section Releases et le fichier portable surligné]

**Étape 3** — Extrais l'archive dans le dossier de ton choix, par exemple `D:\ComfyUI\`.

[SCREENSHOT: Explorateur Windows montrant D:\ComfyUI\ après extraction]

**Étape 4** — Dans le dossier extrait, tu trouves un fichier :
- `run_nvidia_gpu.bat` (pour GPU)
- ou `run_cpu.bat` (pour CPU)

**Garde le chemin complet de ce fichier** — tu en auras besoin dans Story Studio.

---

## 2. Télécharger un modèle d'image

ComfyUI sans modèle ne peut pas générer d'images. Tu dois en télécharger au moins un.

**Pour les histoires Lunii (images 320×240, style dessin)**, un modèle adapté est par exemple **Dreamshaper** ou **Deliberate** (modèles Stable Diffusion 1.5).

1. Va sur [civitai.com](https://civitai.com) ou [huggingface.co](https://huggingface.co)
2. Cherche un modèle SD 1.5 au style cartoon/illustration
3. Télécharge le fichier `.safetensors`
4. Copie-le dans : `D:\ComfyUI\ComfyUI\models\checkpoints\`

[SCREENSHOT: Dossier models\checkpoints\ avec un fichier .safetensors visible]

---

## 3. Premier lancement manuel (test)

1. Double-clique sur `run_nvidia_gpu.bat` (ou `run_cpu.bat`)
2. Une fenêtre noire s'ouvre avec des logs — laisse-la ouverte
3. Quand tu vois `To see the GUI go to: http://127.0.0.1:8188`, ComfyUI est prêt
4. Tu peux ouvrir ce lien dans ton navigateur pour vérifier

[SCREENSHOT: Fenêtre CMD avec le message "To see the GUI go to: http://127.0.0.1:8188"]

---

## 4. Connexion à Story Studio

[SCREENSHOT: Story Studio — onglet Options, section "Génération d'images IA — ComfyUI"]

1. Ouvre Story Studio → onglet **Options**
2. Dans la section **Génération d'images IA — ComfyUI** :
   - Active le toggle **"Activer la génération d'images IA"**
3. Configure les champs :

| Champ | Valeur | Description |
|---|---|---|
| **URL du serveur ComfyUI** | `http://127.0.0.1:8188` | Ne change que si tu as modifié le port |
| **Fichier de démarrage (.bat)** | ex. `D:\ComfyUI\run_nvidia_gpu.bat` | Chemin vers le .bat de lancement |
| **Démarrer ComfyUI automatiquement** | À ton choix | Lance le .bat si ComfyUI ne répond pas |

4. Clique sur **"Tester ComfyUI"**

Si tout va bien : **"ComfyUI accessible et prêt."**

---

## 5. Démarrage automatique

Avec **"Démarrer ComfyUI automatiquement"** activé et le chemin du `.bat` renseigné, Story Studio lance ComfyUI lui-même si nécessaire au moment où tu demandes une image.

> **Note** : ComfyUI met généralement 30–90 secondes à démarrer. Story Studio attend jusqu'à 60 secondes avant d'afficher une erreur.

---

## 6. Importer un workflow

Story Studio fonctionne avec des **workflows ComfyUI** — des recettes qui définissent comment générer les images. Des workflows sont fournis intégrés dans l'application.

Pour importer un workflow personnalisé :

1. Dans ComfyUI (navigateur), configure ton workflow comme tu le souhaites
2. Active le **mode développeur** : Settings → Enable Dev Mode Options

[SCREENSHOT: ComfyUI Settings avec "Enable Dev Mode Options" coché]

3. Exporte le workflow en **API format** (fichier `*-api.json`)
4. Crée ou obtiens un fichier de configuration Story Studio (`*.config.json`) qui décrit les paramètres exposés
5. Dans Story Studio → Options → section ComfyUI :
   - Clique **"Choisir \*-api.json…"** → sélectionne ton export ComfyUI
   - Clique **"Choisir \*.config.json…"** → sélectionne le fichier de config
   - Clique **"Importer"**

[SCREENSHOT: Section "Importer un workflow custom" avec les deux boutons de sélection et le bouton Importer]

Le workflow apparaît dans la liste des workflows disponibles.

---

## 7. Utiliser ComfyUI dans l'éditeur

Une fois activé, un bouton **"✨ Générer IA"** apparaît sous chaque champ image de l'éditeur.

[SCREENSHOT: Champ image dans l'éditeur avec le bouton "Générer IA"]

1. Clique sur ce bouton
2. Choisis un workflow dans la liste
3. Rédige un prompt (description de l'image en anglais pour de meilleurs résultats)
4. Clique sur **Générer** — l'image est automatiquement enregistrée dans ton espace de travail et apparaît dans la file de rendu en bas de l'écran
5. Clique sur l'image générée pour l'utiliser directement dans le projet

> **Format attendu** : Story Studio génère des images au format 320×240 pixels (format Lunii). Les workflows intégrés s'en chargent automatiquement.

---

## Erreurs courantes

**"ComfyUI ne répond pas sur http://127.0.0.1:8188"**
ComfyUI n'est pas lancé.
→ Lance le `.bat` manuellement ou active le démarrage automatique avec le chemin du `.bat` renseigné.

**ComfyUI démarre mais ne génère pas d'image**
Il manque probablement un modèle dans `models\checkpoints\`.
→ Télécharge un modèle `.safetensors` et place-le dans ce dossier (voir section 2).

**Les images générées sont floues ou incohérentes**
Le modèle n'est pas adapté ou le prompt est trop vague.
→ Essaie un modèle différent, ou précise le style dans le prompt (ex. "children book illustration, flat colors, simple background").

**"Démarrage… (peut prendre jusqu'à 60s)" puis erreur**
ComfyUI est trop long à démarrer ou le `.bat` est incorrect.
→ Vérifie le chemin du `.bat` dans les Options. Lance-le manuellement pour voir si des erreurs apparaissent dans la fenêtre CMD.

**Erreur lors de l'import d'un workflow**
Le fichier API JSON n'est pas au bon format.
→ Dans ComfyUI (navigateur), assure-toi d'activer le **mode développeur** (Settings → Enable Dev Mode Options) avant d'exporter en API format.

---

## Utiliser ComfyUI et XTTS en même temps

Si tu utilises les deux outils simultanément sur un PC avec un seul GPU :

- **XTTS** et **ComfyUI** se partagent la mémoire GPU
- Cela peut provoquer des ralentissements ou des erreurs de mémoire
- **Solution recommandée** : dans Story Studio → Options → XTTS, active **"Forcer le CPU"** — XTTS utilise alors le processeur et laisse le GPU entièrement disponible pour ComfyUI
