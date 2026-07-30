> 🇬🇧 **English** | [🇫🇷 Français](xtts-setup-linux.fr.md)

# XTTS CPU setup on Linux

> Target: Story Studio 0.9.6 · Linux x86_64 · CPU only

XTTS is optional. Story Studio also works with imported audio and its bundled
Piper voices. The Linux XTTS configuration validated for 0.9.6 deliberately
uses CPU only: no NVIDIA driver, CUDA toolkit or GPU Python package is required.
Expect roughly 8 GB of disk usage once the Python environment and model are
installed.

## Required layout

Choose an XTTS directory outside the Story Studio repository. It must contain:

```text
XTTS/
  venv/bin/python
  server.py
  models/
  voices/
```

Use a native Linux Python 3.11 environment; do not copy or reuse a Windows
virtual environment. Install your XTTS server and its locked dependencies in
that environment, with the CPU variants of PyTorch, TorchAudio and TorchVision.
Keep models and private reference voices outside the Story Studio repository.

Your launcher must resolve files relative to its own location, bind the server
to `127.0.0.1:8020`, hide CUDA devices and always start the server in CPU mode:

```sh
#!/bin/sh
set -eu
XTTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CUDA_VISIBLE_DEVICES=""
exec "$XTTS_DIR/venv/bin/python" "$XTTS_DIR/server.py" --cpu
```

Make the launcher executable with `chmod +x start_xtts.sh`. Before using Story
Studio, run it manually and verify:

- `http://127.0.0.1:8020/health` reports `"device":"cpu"`;
- `http://127.0.0.1:8020/voices` lists the expected profiles;
- stopping the launcher leaves no server listening on port 8020.

In Story Studio, enable XTTS, select the XTTS directory, keep the server URL at
`http://127.0.0.1:8020`, enable automatic startup if desired and enable
**Force CPU**. Test and refresh the voices before generating audio.

XTTS was not installed or manually validated on macOS for 0.9.6. This Linux
guide must not be used as a promise of macOS support.
