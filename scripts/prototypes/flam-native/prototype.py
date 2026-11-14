#!/usr/bin/env python3
"""Prototype jetable Lua natif FLAM 2.4.x, distinct du transfert de production.

python scripts/prototypes/flam-native/prototype.py build
python scripts/prototypes/flam-native/prototype.py install --device /chemin/FLAM
python scripts/prototypes/flam-native/prototype.py remove --device /chemin/FLAM
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
from datetime import datetime, timezone
from uuid import UUID
import zipfile

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

SOURCE = Path(__file__).resolve().parent
OUTPUT = SOURCE.parents[2] / "exports" / "flam-inventaire-prototype"
STORY = UUID("b74aa3e6-2d71-4d16-aad3-c7feab77389f")
TITLE = "La clé des lucioles"
PACK = "cle-des-lucioles.plain.pk"
BACKUPS = Path.home() / ".local/share/com.hugs11.story-studio/flam-prototype"


def run(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_synced(path, data):
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def replace_synced(path, data):
    temporary = path.with_name(path.name + ".story-studio-prototype.tmp")
    write_synced(temporary, data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def encrypt(data, key, iv):
    padded = data + bytes((-len(data)) % 16)
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return cipher.update(padded) + cipher.finalize()


def decrypt(data, key, iv):
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    return cipher.update(data) + cipher.finalize()


def audio_map(path):
    # Table de seek documentee : duree en unites 88200 Hz, puis offset/position.
    # ffprobe fournit les limites des trames ; aucun parseur tiers n'est embarque.
    report = json.loads(run("ffprobe", "-v", "error", "-show_packets",
                            "-show_entries", "packet=pos,duration_time",
                            "-of", "json", str(path)))
    packets = report["packets"]
    if not packets:
        raise ValueError("Le MP3 ne contient aucune trame.")
    elapsed, next_second, entries = 0.0, 1, []
    for packet in packets:
        if elapsed >= next_second:
            entries.append((int(packet["pos"]), round(elapsed * 88200)))
            next_second += 1
        elapsed += float(packet["duration_time"])
    header = struct.pack("<III", round(elapsed * 88200), int(packets[0]["pos"]), 0)
    return header + b"".join(struct.pack("<II", *entry) for entry in entries)


def build(output, piper, voice, audio_source=None):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="flam-narration-") as temporary:
        wav = Path(temporary) / "intro.wav"
        mp3 = Path(temporary) / "intro.mp3"
        if audio_source is not None:
            mp3.write_bytes(audio_source.read_bytes())
        else:
            run(str(piper), "--model", str(voice), "--input-file", str(SOURCE / "narration.txt"),
                "--output-file", str(wav))
            run("ffmpeg", "-v", "error", "-i", str(wav), "-ac", "1", "-ar", "44100",
                "-codec:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0",
                "-id3v2_version", "0", "-map_metadata", "-1", str(mp3))
        stereo = Path(temporary) / "intro-stereo.mp3"
        run("ffmpeg", "-v", "error", "-i", str(mp3), "-ac", "2", "-ar", "44100",
            "-codec:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3",
            "-map_metadata", "-1", str(stereo))
        files = {
            "info.plain": f"{TITLE}\nPrototype Story Studio\n000000\n{TITLE}".encode(),
            "version": b"1",
            "main.lua": (SOURCE / "main.lua").read_bytes(),
            "script/passage.lua": (SOURCE / "passage.lua").read_bytes(),
            "script/scenes.lua": (SOURCE / "scenes.lua").read_bytes(),
            "script/savegame.lua": (SOURCE / "savegame.lua").read_bytes(),
            "sounds/intro.mp3": mp3.read_bytes(),
            "sounds/intro.mp3map": audio_map(mp3),
            "sounds/intro-stereo.mp3": stereo.read_bytes(),
            "sounds/intro-stereo.mp3map": audio_map(stereo),
            "uuid.bin": STORY.bytes,
        }
        for name in ("coffre", "porte", "fin"):
            clip_wav = Path(temporary) / f"{name}.wav"
            clip_mp3 = Path(temporary) / f"{name}-stereo.mp3"
            run(str(piper), "--model", str(voice), "--input-file", str(SOURCE / f"{name}.txt"),
                "--output-file", str(clip_wav))
            run("ffmpeg", "-v", "error", "-i", str(clip_wav), "-ac", "2", "-ar", "44100",
                "-codec:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3",
                "-map_metadata", "-1", str(clip_mp3))
            files[f"sounds/{name}-stereo.mp3"] = clip_mp3.read_bytes()
            files[f"sounds/{name}-stereo.mp3map"] = audio_map(clip_mp3)
        with zipfile.ZipFile(output / PACK, "w", zipfile.ZIP_STORED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        (output / "manifest.json").write_text(json.dumps({
            "prototype": True, "uuid": str(STORY), "title": TITLE,
            "files": {name: digest(data) for name, data in files.items()},
            "hardwareValidation": "pending",
        }, indent=2) + "\n")
        (output / "intro-stereo.mp3").write_bytes(stereo.read_bytes())
    print(f"Pack original construit : {output / PACK}")


def safe_path(root, relative, required=True):
    path = root
    for part in Path(relative).parts:
        if part in ("..", ".") or Path(part).is_absolute():
            raise ValueError("Chemin invalide.")
        path = path / part
        if path.is_symlink():
            raise ValueError("Les liens symboliques ne sont pas acceptes.")
    if required and not path.exists():
        raise ValueError(f"Fichier ou dossier attendu absent : {relative}")
    return path


def device_material(root):
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError("Utiliser le chemin absolu reel de la FLAM.")
    metadata = safe_path(root, ".mdf")
    if metadata.stat().st_size != 126:
        raise ValueError("Format de metadonnees non valide pour ce prototype.")
    data = metadata.read_bytes()
    if data[:2] != b"\x01\x00":
        raise ValueError("Version de metadonnees inconnue.")
    firmware = data[2:50].rstrip(b"\0").decode("ascii")
    firmware = firmware.removeprefix("main: ").splitlines()[0]
    if firmware.split("-")[0] not in ("2.4.1", "2.4.2"):
        raise ValueError("Ce prototype est limite aux firmwares 2.4.1 et 2.4.2.")
    serial = data[50:74]
    if not serial.rstrip(b"\0").isdigit():
        raise ValueError("Champ serie non reconnu.")
    safe_path(root, "str")
    safe_path(root, "etc/library/list")
    safe_path(root, "usr/0")
    return firmware, (serial + serial)[:32], data[78:94], data[94:110]


def read_pack(output):
    manifest = json.loads((output / "manifest.json").read_text())
    if manifest["uuid"] != str(STORY):
        raise ValueError("Identite du prototype incorrecte.")
    expected = {"info.plain", "version", "main.lua", "script/passage.lua",
                "script/scenes.lua", "script/savegame.lua",
                "sounds/intro.mp3", "sounds/intro.mp3map", "sounds/intro-stereo.mp3",
                "sounds/intro-stereo.mp3map", "uuid.bin"}
    expected.update(f"sounds/{name}-stereo.{suffix}" for name in ("coffre", "porte", "fin")
                    for suffix in ("mp3", "mp3map"))
    with zipfile.ZipFile(output / PACK) as archive:
        if len(archive.namelist()) != len(expected) or set(archive.namelist()) != expected:
            raise ValueError("Le pack contient des fichiers inattendus.")
        files = {name: archive.read(name) for name in expected}
    if files["uuid.bin"] != STORY.bytes:
        raise ValueError("UUID de l'archive incorrect.")
    if {name: digest(data) for name, data in files.items()} != manifest["files"]:
        raise ValueError("Le pack ne correspond pas au manifeste.")
    return files


def install(root, output, backups=BACKUPS):
    firmware, keyfile, key, iv = device_material(root)
    files = read_pack(output)
    playlist = safe_path(root, "etc/library/list")
    original = playlist.read_bytes()
    listed = [str(UUID(line.strip())) for line in original.decode().splitlines() if line.strip()]
    hidden = safe_path(root, "etc/library/list.hidden", False)
    if hidden.exists():
        listed += [str(UUID(line.strip())) for line in hidden.read_text().splitlines() if line.strip()]
    destination = safe_path(root, f"str/{STORY}", False)
    hidden_story = safe_path(root, f"str.hidden/{STORY}", False)
    if destination.exists() or hidden_story.exists() or str(STORY) in listed:
        raise ValueError("Le prototype est deja present ; aucune histoire n'a ete remplacee.")
    backup = backups / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup, 0o700)
    write_synced(backup / "library-list", original)
    cache = safe_path(root, "usr/0/library.cache", False)
    old_cache = cache.read_bytes() if cache.exists() else None
    if old_cache is not None:
        write_synced(backup / "library.cache", old_cache)
    changed = original + (b"\n" if original and not original.endswith(b"\n") else b"")
    changed += str(STORY).encode() + b"\n"
    published, registered = False, False
    with tempfile.TemporaryDirectory(prefix=".prototype-", dir=root / "str") as temporary:
        stage = Path(temporary) / str(STORY)
        stage.mkdir()
        hashes = {}
        for name, data in files.items():
            if name == "uuid.bin":
                continue
            encrypted = name == "info.plain" or name.endswith(".lua")
            target = "info" if name == "info.plain" else name.removesuffix(".lua") + ".lsf" if encrypted else name
            payload = encrypt(data, key, iv) if encrypted else data
            path = stage / target
            path.parent.mkdir(parents=True, exist_ok=True)
            write_synced(path, payload)
            readback = path.read_bytes()
            if readback != payload or (encrypted and decrypt(readback, key, iv) != data + bytes((-len(data)) % 16)):
                raise ValueError("Echec de verification du fichier transfere.")
            hashes[target] = digest(payload)
        write_synced(stage / "key", keyfile)
        hashes["key"] = digest(keyfile)
        receipt = {"uuid": str(STORY), "firmware": firmware, "files": hashes,
                   "playlistBefore": digest(original), "playlistAfter": digest(changed),
                   "hardwareValidation": "pending"}
        write_synced(backup / "installation.json", (json.dumps(receipt, indent=2) + "\n").encode())
        try:
            # Ne pas publier la liste si une autre application l'a modifiee entretemps.
            if playlist.read_bytes() != original:
                raise ValueError("La bibliotheque a change pendant le transfert.")
            os.rename(stage, destination)
            published = True
            replace_synced(playlist, changed)
            registered = True
            cache.unlink(missing_ok=True)
            os.sync()
            if playlist.read_bytes() != changed or any(digest((destination / n).read_bytes()) != h for n, h in hashes.items()):
                raise ValueError("Echec de verification apres publication.")
        except BaseException:
            if registered and playlist.read_bytes() == changed:
                replace_synced(playlist, original)
            if published:
                shutil.rmtree(destination)
            if old_cache is not None and not cache.exists():
                write_synced(cache, old_cache)
            os.sync()
            raise
    print(f"Prototype installe, firmware {firmware}. Lecture materielle non encore validee.")
    print(f"Sauvegarde locale de la liste et du cache : {backup}")
    return backup


def remove(root, backups=BACKUPS):
    device_material(root)
    destination = safe_path(root, f"str/{STORY}")
    receipts = sorted(backups.glob("*/installation.json"), reverse=True)
    receipt = next((json.loads(p.read_text()) for p in receipts
                    if json.loads(p.read_text()).get("uuid") == str(STORY)), None)
    if receipt is None:
        raise ValueError("Aucun recu d'installation : suppression refusee.")
    actual = {str(p.relative_to(destination)): digest(p.read_bytes())
              for p in destination.rglob("*") if p.is_file() and not p.is_symlink()}
    if any(p.is_symlink() for p in destination.rglob("*")) or actual != receipt["files"]:
        raise ValueError("Le dossier a change : suppression refusee.")
    playlist = safe_path(root, "etc/library/list")
    original = playlist.read_bytes()
    updated = b"".join(line for line in original.splitlines(keepends=True)
                       if line.strip().lower() != str(STORY).encode())
    replace_synced(playlist, updated)
    shutil.rmtree(destination)
    safe_path(root, "usr/0/library.cache", False).unlink(missing_ok=True)
    os.sync()
    print("Prototype retire ; les autres histoires sont conservees.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("build", "install", "remove"))
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--device", type=Path)
    parser.add_argument("--audio-source", type=Path,
                        help="Reutiliser exactement le MP3 original pour un essai comparatif.")
    parser.add_argument("--piper", type=Path, default=Path(shutil.which("piper") or "piper"))
    parser.add_argument("--voice", type=Path, default=Path.home() /
                        ".local/share/com.hugs11.story-studio/piper/voices/fr_FR-siwis-medium.onnx")
    args = parser.parse_args()
    if args.action == "build":
        build(args.output, args.piper, args.voice, args.audio_source)
    elif args.device is None:
        parser.error("--device est obligatoire pour agir sur un appareil.")
    elif not args.device.is_mount():
        parser.error("Le chemin indique doit etre le point de montage de la FLAM.")
    elif args.action == "install":
        install(args.device, args.output)
    else:
        remove(args.device)


if __name__ == "__main__":
    main()
