#!/usr/bin/env python
"""Oracle Lunii.QT : `luniiqt_oracle.py <archive.zip> [--keep DIR]`.

Appelle le vrai code de Lunii.QT (`LuniiDevice.import_story`, `stories.StudioStory`)
sur un « appareil » factice (dossier temporaire, Lunii V2, clé d'appareil nulle),
puis relit structurellement les fichiers Lunii produits. JSON sur stdout.
Environnement : SS_LUNIIQT_CLONE (dossier Lunii.QT).
"""
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import zipfile

t0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
CLONE = os.environ.get('SS_LUNIIQT_CLONE')
if not CLONE or not os.path.isdir(CLONE):
    print(json.dumps({'ok': False, 'errors': ['SS_LUNIIQT_CLONE absent ou invalide'], 'warnings': []}))
    sys.exit(2)

work = tempfile.mkdtemp(prefix='luniiqt-')
# Lunii.QT écrit ~/.lunii-qt (base tierce) : on redirige le « home » vers le temp.
for var in ('USERPROFILE', 'HOME'):
    os.environ[var] = os.path.join(work, 'home')
# le GUI crée ce dossier au démarrage
os.makedirs(os.path.join(work, 'home', '.lunii-qt'), exist_ok=True)
sys.path.insert(0, CLONE)
sys.path.insert(0, os.path.join(HERE, 'stubs'))

result = {'ok': False, 'format_detected': None, 'stage_count': None, 'action_count': None,
          'errors': [], 'warnings': [], 'elapsed_ms': 0}


def finish(code=0):
    result['elapsed_ms'] = int((time.time() - t0) * 1000)
    shutil.rmtree(work, ignore_errors=True)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(code)


def rd(b, o):
    return int.from_bytes(b[o:o + 4], 'little', signed=True)


try:
    zip_path = sys.argv[1]
    keep = sys.argv[sys.argv.index('--keep') + 1] if '--keep' in sys.argv else None
    from PySide6 import QtCore  # stub
    from pkg.api.constants import LUNII_V2
    from pkg.api import stories
    from pkg.api.stories import StoryList
    from pkg.api.device_lunii import LuniiDevice

    names = {0x00: 'unknown', 0x01: 'lunii_plain', 0x02: 'lunii_v3_zip', 0x03: 'lunii_flam_zip',
             0x10: 'lunii_v2_zip', 0x20: 'studio_zip', 0x40: 'flam_zip'}

    # Appareil factice : pas de `.md`, donc __init__ sort tôt ; on pose les champs
    # que __feed_device aurait remplis. V2 = xxtea avec la clé générique (constante du
    # code) ; la clé d'appareil ne sert qu'au fichier `bt` (ici nulle, non vérifiable).
    mount = os.path.join(work, 'device')
    os.makedirs(mount)
    dev = LuniiDevice(mount)
    dev.device_version = LUNII_V2
    dev.device_key = bytes(16)
    dev.snu = bytes(8)
    dev.stories = StoryList()
    dev.config = None

    # story.json attendu (pour comparer), lu indépendamment de Lunii.QT
    sj = None
    try:
        with zipfile.ZipFile(zip_path) as z:
            if 'story.json' in z.namelist():
                sj = json.loads(z.read('story.json'))
    except Exception:
        pass
    if sj:
        result['expected'] = {
            'stage_count': len(sj.get('stageNodes', [])),
            'action_count': len(sj.get('actionNodes', [])),
            'option_count': sum(len(a.get('options', [])) for a in sj.get('actionNodes', [])),
        }
        result['stage_count'] = result['expected']['stage_count']
        result['action_count'] = result['expected']['action_count']

    try:
        result['format_detected'] = names.get(stories.archive_check_zipcontent(zip_path), 'other')
    except Exception as e:
        result['format_detected'] = 'unreadable'
        result['errors'].append(f'détection du format : {type(e).__name__}: {e}')
    if result['errors']:
        finish()

    try:
        returned = dev.import_story(zip_path)
    except Exception as e:
        returned = False
        result['errors'].append(f'exception Lunii.QT : {type(e).__name__}: {e}')
    for level, msg in QtCore.LOG:
        if level >= logging.ERROR:
            result['errors'].append(msg)
        elif level == logging.WARNING:
            result['warnings'].append(msg)
    result['import_returned'] = returned
    if returned is not True and not result['errors']:
        result['errors'].append("import_story n'a pas renvoyé True")

    # Relecture structurelle du dossier produit
    if returned is True and sj:
        content = os.path.join(mount, '.content')
        pack_dirs = os.listdir(content)
        pdir = os.path.join(content, pack_dirs[0])
        rb = {'pack_dir': pack_dirs[0]}
        ni = open(os.path.join(pdir, 'ni'), 'rb').read()
        # li est chiffré (xxtea, clé générique V2) : relu par le code de Lunii.QT lui-même
        li = dev._LuniiDevice__get_plain_data(os.path.join(pdir, 'li'))
        n_nodes, n_ri, n_si = rd(ni, 12), rd(ni, 16), rd(ni, 20)
        hdr, nsz = rd(ni, 4), rd(ni, 8)
        rb.update(ni_nodes=n_nodes, ni_size_ok=len(ni) == hdr + n_nodes * nsz, ri_count=n_ri, si_count=n_si)
        n_opt = result['expected']['option_count']
        li_vals = [rd(li, i) for i in range(0, min(len(li), 4 * n_opt), 4)]
        rb['li_count'] = len(li_vals)
        dangling = sum(1 for v in li_vals if v < 0 or v >= n_nodes)
        rb['li_dangling'] = dangling
        rb['ri_file_size_ok'] = os.path.getsize(os.path.join(pdir, 'ri')) == 12 * n_ri
        rb['si_file_size_ok'] = os.path.getsize(os.path.join(pdir, 'si')) == 12 * n_si
        rb['rf_files'] = sum(len(f) for _, _, f in os.walk(os.path.join(pdir, 'rf')))
        rb['sf_files'] = sum(len(f) for _, _, f in os.walk(os.path.join(pdir, 'sf')))
        rb['has_bt'] = os.path.isfile(os.path.join(pdir, 'bt'))
        # transitions ok/home dont la plage d'options sort de li
        bad_tr = 0
        for i in range(n_nodes):
            off = hdr + i * nsz
            for base in (8, 20):
                first, cnt = rd(ni, off + base), rd(ni, off + base + 4)
                if first != -1 and (first < 0 or first + cnt > n_opt):
                    bad_tr += 1
        rb['ni_bad_transitions'] = bad_tr
        result['readback'] = rb
        if n_nodes != result['expected']['stage_count']:
            result['errors'].append(f"ni : {n_nodes} noeuds pour {result['expected']['stage_count']} stages")
        if not (rb['ni_size_ok'] and rb['ri_file_size_ok'] and rb['si_file_size_ok']):
            result['errors'].append('tailles ni/ri/si incohérentes')
        if rb['rf_files'] != n_ri or rb['sf_files'] != n_si:
            result['errors'].append(f"fichiers média produits (rf={rb['rf_files']}, sf={rb['sf_files']}) != ri/si ({n_ri}/{n_si})")
        if dangling:
            result['warnings'].append(f'li : {dangling} option(s) vers un noeud inexistant (index -1 ou hors bornes)')
        if bad_tr:
            result['errors'].append(f'ni : {bad_tr} transition(s) hors de li')
        if keep:
            shutil.copytree(mount, keep, dirs_exist_ok=True)

    # Faits sur l'Écran d'entrée (squareOne), informatifs
    if sj:
        snodes = sj.get('stageNodes', [])
        sq = [n for n in snodes if n.get('squareOne')]
        sq_uuid = sq[0].get('uuid') if sq else None
        result['square_one'] = {
            'count': len(sq),
            'index': next((i for i, n in enumerate(snodes) if n.get('squareOne')), None),
            'home_true_without_home_transition': sum(
                1 for n in sq if (n.get('controlSettings') or {}).get('home') and not n.get('homeTransition')),
            'options_targeting': sum(1 for a in sj.get('actionNodes', []) for o in a.get('options', []) if o == sq_uuid),
        }
    result['ok'] = returned is True and not result['errors']
except SystemExit:
    raise
except Exception as e:
    import traceback
    result['errors'].append(f'oracle : {type(e).__name__}: {e}')
    result['trace'] = traceback.format_exc()[-800:]
finish()
