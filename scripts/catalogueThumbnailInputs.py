"""Generate disposable synthetic RSS benchmark inputs outside the repository.

Requires Pillow already installed on the measurement machine. Generation must
run before /usr/bin/time starts the Rust worker process; its own allocations
are deliberately not part of the worker RSS measurement.
"""
from pathlib import Path
import os
import sys
from PIL import Image

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
noise = Image.frombytes("RGB", (4000, 2000), os.urandom(4000 * 2000 * 3))
noise.save(root / "noise-8mp.jpeg", quality=95)
del noise
rgba = Image.new("RGBA", (4000, 2000), (30, 70, 110, 127))
rgba.save(root / "alpha-8mp.png")
rgba.save(root / "alpha-8mp.webp", lossless=True)
del rgba
Image.new("P", (4000, 2000), 11).save(root / "palette-8mp.gif")
Image.new("RGB", (256, 256), (11, 22, 33)).save(root / "small-256.png")
