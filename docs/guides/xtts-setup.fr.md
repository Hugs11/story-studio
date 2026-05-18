> [🇬🇧 English](xtts-setup.md) | 🇫🇷 **Français**

# Guide d'installation — Voix IA (XTTS)

> **Version** : Story Studio 0.8.7 · Windows 10/11 · Dernière mise à jour : 2026-05-16

XTTS est un moteur de synthèse vocale qui tourne **sur ton ordinateur**. Il peut parler en français, anglais, espagnol, allemand, italien et portugais, avec des voix naturelles.

Cet outil est optionnel. Story Studio fonctionne parfaitement sans lui — tu peux toujours utiliser tes propres fichiers audio.

---

## Prérequis système

| Élément | Minimum | Recommandé |
|---|---|---|
| Système | Windows 10 64-bit | Windows 11 64-bit |
| RAM | 8 Go | 16 Go |
| GPU | Pas obligatoire | NVIDIA (4 Go VRAM+) |
| Espace disque | 5 Go libres | 10 Go libres |
| Python | 3.10 ou 3.11 | 3.11 |

> **Sans GPU NVIDIA** : XTTS fonctionne en mode CPU. La génération est plus lente (30–90 secondes par fichier au lieu de 5–15 s), mais le résultat est identique. Story Studio a une option pour forcer le mode CPU si tu veux laisser le GPU libre pour la génération d'images.

---

## 1. Installation de Python

Si tu n'as pas Python installé :

1. Va sur [python.org/downloads](https://www.python.org/downloads/) et télécharge Python **3.11**
2. Lance l'installateur
3. **Important** : coche la case **"Add Python to PATH"** avant de cliquer sur Installer

[SCREENSHOT: Installateur Python avec la case "Add Python to PATH" cochée en bas]

Pour vérifier l'installation, ouvre le **Démarrer**, tape `cmd`, et dans la fenêtre noire qui s'ouvre :

```
python --version
```

Tu dois voir quelque chose comme `Python 3.11.9`. Si tu vois une erreur, Python n'est pas correctement installé.

---

## 2. Installation du serveur XTTS

Story Studio s'attend à trouver XTTS dans un dossier précis. La procédure crée cette structure automatiquement.

**Étape 1** — Ouvre une fenêtre **PowerShell en tant qu'administrateur** :
- Clique droit sur le bouton Démarrer → **Terminal Windows (admin)** ou **Windows PowerShell (admin)**

**Étape 2** — Crée le dossier XTTS et entre dedans :

```powershell
mkdir D:\XTTS
cd D:\XTTS
```

> Tu peux choisir un autre dossier (ex. `C:\XTTS`), mais note-le — tu devras l'indiquer dans Story Studio.

**Étape 3** — Crée un environnement Python isolé (évite les conflits avec d'autres logiciels) :

```powershell
python -m venv venv
```

**Étape 4** — Active cet environnement :

```powershell
.\venv\Scripts\Activate.ps1
```

Tu dois voir `(venv)` apparaître au début de la ligne dans PowerShell.

**Étape 5** — Installe le serveur XTTS :

```powershell
pip install xtts-api-server
```

> Cette étape télécharge plusieurs centaines de Mo. Laisse-la se terminer complètement (3–10 minutes selon ta connexion).

**Étape 6** — Crée le fichier de démarrage du serveur. Dans PowerShell, dans `D:\XTTS` :

```powershell
# Vérifie que tu es bien dans D:\XTTS
Get-Location

# Cherche le script server.py fourni par xtts-api-server
Get-ChildItem -Recurse -Filter "server.py" | Select-Object FullName
```

Si `server.py` n'est pas directement dans `D:\XTTS\`, copie-le depuis l'endroit trouvé :

```powershell
# Exemple — adapte le chemin si nécessaire
Copy-Item ".\venv\Lib\site-packages\xtts_api_server\server.py" -Destination ".\server.py"
```

**Étape 7** — Crée les dossiers nécessaires :

```powershell
mkdir models
mkdir voices
mkdir output
```

**Vérification** — Ton dossier `D:\XTTS` doit ressembler à ceci :

```
D:\XTTS\
  venv\              ← environnement Python
  models\            ← modèles IA (téléchargés au 1er lancement)
  voices\            ← tes voix de référence (optionnel)
  output\            ← audios générés par XTTS
  server.py          ← script de démarrage
```

[SCREENSHOT: Explorateur Windows montrant le dossier D:\XTTS avec la structure ci-dessus]

---

## 3. Premier lancement manuel (test)

Avant de connecter Story Studio, teste que le serveur fonctionne seul :

1. Dans PowerShell (toujours dans `D:\XTTS`, avec `(venv)` actif) :

```powershell
python server.py
```

2. Tu verras des messages défiler — c'est normal. Le serveur télécharge le modèle XTTS au premier lancement (**environ 2 Go**, une seule fois).

3. Quand tu vois une ligne contenant `Running on http://0.0.0.0:8020` ou similaire, le serveur est prêt.

[SCREENSHOT: Fenêtre PowerShell montrant les logs de démarrage XTTS avec la ligne "Running on..."]

4. Pour arrêter le serveur : appuie sur **Ctrl+C** dans PowerShell.

> **Premier lancement** : le téléchargement du modèle peut prendre 5–20 minutes. Les lancements suivants sont rapides (30–60 secondes).

---

## 4. Connexion à Story Studio

[SCREENSHOT: Story Studio — onglet Options, section "Génération de voix locale — XTTS"]

1. Ouvre Story Studio
2. Clique sur l'onglet **Options** (ou **Préférences** si tu passes par le menu)
3. Dans la section **Génération de voix locale — XTTS** :
   - Active le toggle **"Activer la génération de voix"**
4. Les paramètres apparaissent :

| Champ | Valeur par défaut | À modifier si... |
|---|---|---|
| **URL du serveur XTTS** | `http://127.0.0.1:8020` | Tu as changé le port dans `server.py` |
| **Dossier XTTS** | `D:\XTTS` | Tu as installé ailleurs |
| **Langue par défaut** | Français | Tu veux une autre langue par défaut |
| **Démarrer XTTS automatiquement** | Activé | — |
| **Forcer le CPU** | Désactivé | Tu utilises ComfyUI en même temps (GPU partagé) |

5. Clique sur **"Tester et actualiser les voix"**

[SCREENSHOT: Bouton "Tester et actualiser les voix" et résultat "Serveur prêt sur GPU CUDA • 3 voix détectée(s)"]

Si tout va bien, tu vois : **"Serveur prêt sur GPU CUDA • N voix détectée(s)"** (ou CPU si pas de GPU).

---

## 5. Démarrage automatique

Avec l'option **"Démarrer XTTS automatiquement"** activée, Story Studio lance `server.py` lui-même quand tu demandes une génération de voix, sans que tu aies besoin d'ouvrir PowerShell. Il attend jusqu'à 45 secondes que le serveur soit prêt.

> **Conseil** : laisse cette option activée. Elle te simplifie l'usage au quotidien.

---

## 6. Ajouter des voix de référence

XTTS peut cloner une voix à partir d'un échantillon audio (10–30 secondes de parole claire sans bruit de fond).

1. Prépare un fichier WAV de 10 à 30 secondes (enregistrement propre, sans musique ni écho)
2. Nomme le fichier avec le nom que tu veux donner à la voix, ex. `narrateur.wav`
3. Copie-le dans `D:\XTTS\voices\`
4. Dans Story Studio, clique sur **"Tester et actualiser les voix"** — la voix apparaît dans la liste

[SCREENSHOT: Gestionnaire de voix dans Options avec des cases à cocher pour chaque voix]

---

## 7. Voix favorites

La liste de voix peut être longue. Tu peux cocher uniquement les voix que tu utilises souvent — elles seront les seules proposées dans le modal de génération.

---

## 8. Utiliser XTTS dans l'éditeur

Une fois activé, un bouton **"Générer voix"** (ou icône micro avec étoile) apparaît sur chaque champ audio de l'éditeur.

[SCREENSHOT: Champ audio dans l'éditeur avec le bouton de génération de voix]

1. Clique sur ce bouton
2. Saisis le texte à lire
3. Choisis une voix dans la liste
4. Clique sur **Générer** — l'audio est automatiquement enregistré dans ton espace de travail et injecté dans le champ

---

## Erreurs courantes

**"Serveur XTTS indisponible sur http://127.0.0.1:8020"**
Le serveur n'est pas lancé et le démarrage automatique est désactivé, ou le serveur a mis trop longtemps à démarrer.
→ Active "Démarrer XTTS automatiquement" dans les Options, ou lance `server.py` manuellement avant de générer.

**"Python XTTS introuvable : D:\XTTS\venv\Scripts\python.exe"**
Story Studio ne trouve pas Python dans le dossier XTTS.
→ Vérifie que tu as bien créé le `venv` dans `D:\XTTS` (étape 3). Vérifie aussi que le "Dossier XTTS" dans les Options correspond à l'endroit où tu as installé.

**"server.py introuvable dans D:\XTTS"**
Le fichier `server.py` est absent.
→ Reprends l'étape 6 de l'installation.

**Le serveur démarre mais aucune voix n'est détectée**
Le modèle XTTS n'est pas encore téléchargé ou le téléchargement a échoué.
→ Lance `server.py` manuellement dans PowerShell et attends la fin du téléchargement. Surveille les messages d'erreur éventuels.

**Génération très lente (plusieurs minutes)**
XTTS tourne en mode CPU.
→ Si tu as un GPU NVIDIA, vérifie que les drivers CUDA sont à jour (nvidia.com/drivers). Si tu utilises ComfyUI en même temps, l'option "Forcer le CPU" est normale — c'est un compromis voulu.

**"Le fichier XTTS attendu est introuvable dans D:\XTTS\output"**
Le serveur a généré l'audio mais ne l'a pas mis dans le dossier `output/`.
→ Vérifie que le dossier `D:\XTTS\output\` existe (étape 7 de l'installation).

---

## Utiliser XTTS et ComfyUI en même temps

Si tu utilises les deux outils simultanément sur un PC avec un seul GPU :

- **XTTS** et **ComfyUI** se partagent la mémoire GPU
- Cela peut provoquer des ralentissements ou des erreurs de mémoire
- **Solution recommandée** : dans Story Studio → Options → XTTS, active **"Forcer le CPU"** — XTTS utilise alors le processeur et laisse le GPU entièrement disponible pour ComfyUI
