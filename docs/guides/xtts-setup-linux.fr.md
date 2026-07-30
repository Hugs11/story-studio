> [🇬🇧 English](xtts-setup-linux.md) | 🇫🇷 **Français**

# Installation de XTTS CPU sous Linux

> Cible : Story Studio 0.9.6 · Linux x86_64 · CPU uniquement

XTTS est optionnel. Story Studio fonctionne aussi avec des audios importés et
les voix Piper embarquées. La configuration XTTS Linux validée pour la 0.9.6
utilise volontairement le CPU uniquement : aucun pilote NVIDIA, toolkit CUDA
ou paquet Python GPU n'est requis. Prévoyez environ 8 Go une fois
l'environnement Python et le modèle installés.

## Arborescence requise

Choisissez un dossier XTTS hors du dépôt Story Studio. Il doit contenir :

```text
XTTS/
  venv/bin/python
  server.py
  models/
  voices/
```

Utilisez un environnement Python 3.11 natif Linux ; ne copiez et ne réutilisez
pas un environnement virtuel Windows. Installez-y votre serveur XTTS et ses
dépendances verrouillées, avec les variantes CPU de PyTorch, TorchAudio et
TorchVision. Conservez modèles et voix de référence privées hors du dépôt
Story Studio.

Le lanceur doit résoudre les fichiers depuis son propre emplacement, limiter le
serveur à `127.0.0.1:8020`, masquer CUDA et toujours utiliser le mode CPU :

```sh
#!/bin/sh
set -eu
XTTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CUDA_VISIBLE_DEVICES=""
exec "$XTTS_DIR/venv/bin/python" "$XTTS_DIR/server.py" --cpu
```

Rendez le lanceur exécutable avec `chmod +x start_xtts.sh`. Avant Story Studio,
lancez-le manuellement et vérifiez :

- `http://127.0.0.1:8020/health` indique `"device":"cpu"` ;
- `http://127.0.0.1:8020/voices` liste les profils attendus ;
- après l'arrêt, aucun serveur n'écoute encore sur le port 8020.

Dans Story Studio, activez XTTS, sélectionnez le dossier XTTS, conservez l'URL
`http://127.0.0.1:8020`, activez si besoin le démarrage automatique et cochez
**Forcer le CPU**. Testez puis actualisez les voix avant toute génération.

XTTS n'a pas été installé ni validé manuellement sous macOS pour la 0.9.6. Ce
guide Linux ne constitue pas une promesse de prise en charge macOS.
