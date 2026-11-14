"""Contrats du transfert experimental sur volume synthetique, jamais sur la FLAM."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import prototype as p


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.root, self.output, self.backups = base / "device", base / "build", base / "backups"
        for relative in ("str/original", "etc/library", "usr/0"):
            (self.root / relative).mkdir(parents=True)
        self.original_list = b"f3695bfd-0cc5-4b18-acd4-586f5beb6116"  # Pas de LF final.
        (self.root / "etc/library/list").write_bytes(self.original_list)
        (self.root / "usr/0/library.cache").write_bytes(b"cache-original")
        (self.root / "str/original/precieux").write_bytes(b"histoire-originale")
        self.metadata = (b"\x01\x00" + b"2.4.1-test".ljust(48, b"\0")
                         + b"30224029999999".ljust(24, b"\0") + bytes(4) + bytes(range(48)))
        (self.root / ".mdf").write_bytes(self.metadata)
        self.output.mkdir()
        self.files = {
            "uuid.bin": p.STORY.bytes, "version": b"1", "info.plain": b"Titre\nSous-titre\n000000\nTitre",
            "main.lua": b"function setup() end", "script/passage.lua": b"return {}",
            "sounds/intro.mp3": b"audio-original", "sounds/intro.mp3map": bytes(12),
            "sounds/intro-stereo.mp3": b"audio-stereo", "sounds/intro-stereo.mp3map": bytes(12),
        }
        with zipfile.ZipFile(self.output / p.PACK, "w") as archive:
            for name, data in self.files.items():
                archive.writestr(name, data)
        (self.output / "manifest.json").write_text(json.dumps({
            "uuid": str(p.STORY), "files": {n: p.digest(d) for n, d in self.files.items()}}))
        self.sync = patch.object(p.os, "sync")
        self.sync.start()
        self.addCleanup(self.sync.stop)

    def assert_original_untouched(self):
        self.assertEqual((self.root / ".mdf").read_bytes(), self.metadata)
        self.assertEqual((self.root / "str/original/precieux").read_bytes(), b"histoire-originale")

    def test_install_readback_and_remove_preserve_other_stories_and_later_additions(self):
        backup = p.install(self.root, self.output, self.backups)
        self.assertEqual((backup / "library-list").read_bytes(), self.original_list)
        self.assertEqual((backup / "library.cache").read_bytes(), b"cache-original")
        destination = self.root / "str" / str(p.STORY)
        _, keyfile, key, iv = p.device_material(self.root)
        self.assertEqual((destination / "key").read_bytes(), keyfile)
        for source, target in (("info.plain", "info"), ("main.lua", "main.lsf"),
                               ("script/passage.lua", "script/passage.lsf")):
            plain = self.files[source]
            self.assertEqual(p.decrypt((destination / target).read_bytes(), key, iv),
                             plain + bytes((-len(plain)) % 16))
        self.assertEqual((destination / "sounds/intro.mp3").read_bytes(), b"audio-original")
        self.assert_original_untouched()
        with self.assertRaisesRegex(ValueError, "deja present"):
            p.install(self.root, self.output, self.backups)
        playlist = self.root / "etc/library/list"
        with playlist.open("ab") as f:
            f.write(b"b004b728-bb98-42e5-91f3-70dc44f05db7\n")
        p.remove(self.root, self.backups)
        self.assertFalse(destination.exists())
        self.assertEqual(playlist.read_bytes(), self.original_list + b"\nb004b728-bb98-42e5-91f3-70dc44f05db7\n")
        self.assert_original_untouched()

    def test_failure_after_registration_rolls_back_list_cache_and_new_story(self):
        with patch.object(p.os, "sync", side_effect=[OSError("sync refuse"), None]):
            with self.assertRaisesRegex(OSError, "sync refuse"):
                p.install(self.root, self.output, self.backups)
        self.assertEqual((self.root / "etc/library/list").read_bytes(), self.original_list)
        self.assertEqual((self.root / "usr/0/library.cache").read_bytes(), b"cache-original")
        self.assertFalse((self.root / "str" / str(p.STORY)).exists())
        self.assert_original_untouched()

    def test_changed_story_is_never_deleted(self):
        p.install(self.root, self.output, self.backups)
        (self.root / "str" / str(p.STORY) / "main.lsf").write_bytes(b"modification")
        with self.assertRaisesRegex(ValueError, "dossier a change"):
            p.remove(self.root, self.backups)
        self.assertIn(str(p.STORY).encode(), (self.root / "etc/library/list").read_bytes())

    def test_linked_paths_and_unsupported_metadata_are_refused_before_writes(self):
        metadata = self.root / ".mdf"
        outside = self.root.parent / "outside"
        outside.write_bytes(metadata.read_bytes())
        metadata.unlink()
        metadata.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "liens symboliques"):
            p.install(self.root, self.output, self.backups)
        metadata.unlink()
        metadata.write_bytes(self.metadata.replace(b"2.4.1-test", b"9.9.9-test"))
        with self.assertRaisesRegex(ValueError, "limite aux firmwares"):
            p.install(self.root, self.output, self.backups)
        self.assertEqual((self.root / "etc/library/list").read_bytes(), self.original_list)


if __name__ == "__main__":
    unittest.main()
