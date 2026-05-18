> 🇬🇧 **English** | [🇫🇷 Français](comfyui-setup.fr.md)

# Setup guide — AI images (ComfyUI)

> **Version**: Story Studio 0.8.7 · Windows 10/11 · Last updated: 2026-05-16

ComfyUI is an AI image generation tool (based on Stable Diffusion). It produces illustrations for your stories from text descriptions, directly on your computer.

This tool is optional. Story Studio works perfectly fine without it — you can always use your own images.

---

## System requirements

| Item | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 64-bit | Windows 11 64-bit |
| RAM | 8 GB | 16 GB |
| NVIDIA GPU | 4 GB VRAM | 8 GB VRAM+ |
| Disk space | 10 GB free | 30 GB free |

> **Without an NVIDIA GPU**: ComfyUI can run on CPU but generation takes several minutes per image. This is only practical for occasional tests. For regular usage, an NVIDIA GPU is strongly recommended.

---

## 1. Install ComfyUI

The easiest way on Windows is to use the **official portable pack** of ComfyUI.

**Step 1** — Go to the ComfyUI GitHub page:
`https://github.com/comfyanonymous/ComfyUI`

**Step 2** — In the **Releases** section (right column), download the latest version of the file named:
- `ComfyUI_windows_portable_nvidia.7z` (for NVIDIA GPU)
- or `ComfyUI_windows_portable_cpu.7z` (for CPU only)

[SCREENSHOT: ComfyUI GitHub page with the Releases section and the portable file highlighted]

**Step 3** — Extract the archive into the folder of your choice, e.g. `D:\ComfyUI\`.

[SCREENSHOT: Windows Explorer showing D:\ComfyUI\ after extraction]

**Step 4** — In the extracted folder, you'll find a file:
- `run_nvidia_gpu.bat` (for GPU)
- or `run_cpu.bat` (for CPU)

**Keep the full path to this file** — you'll need it in Story Studio.

---

## 2. Download an image model

ComfyUI without a model can't generate images. You need to download at least one.

**For Lunii stories (320×240 illustrations, drawing style)**, a suitable model is for example **Dreamshaper** or **Deliberate** (Stable Diffusion 1.5 models).

1. Go to [civitai.com](https://civitai.com) or [huggingface.co](https://huggingface.co)
2. Look for an SD 1.5 model with a cartoon/illustration style
3. Download the `.safetensors` file
4. Copy it into: `D:\ComfyUI\ComfyUI\models\checkpoints\`

[SCREENSHOT: models\checkpoints\ folder with a visible .safetensors file]

---

## 3. First manual launch (test)

1. Double-click `run_nvidia_gpu.bat` (or `run_cpu.bat`)
2. A black window opens with logs — leave it open
3. When you see `To see the GUI go to: http://127.0.0.1:8188`, ComfyUI is ready
4. You can open this link in your browser to verify

[SCREENSHOT: CMD window with the message "To see the GUI go to: http://127.0.0.1:8188"]

---

## 4. Connect to Story Studio

[SCREENSHOT: Story Studio — Options tab, "AI image generation — ComfyUI" section]

1. Open Story Studio → **Options** tab
2. In the **AI image generation — ComfyUI** section:
   - Enable the **"Enable AI image generation"** toggle
3. Configure the fields:

| Field | Value | Description |
|---|---|---|
| **ComfyUI server URL** | `http://127.0.0.1:8188` | Only change if you modified the port |
| **Startup file (.bat)** | e.g. `D:\ComfyUI\run_nvidia_gpu.bat` | Path to the launch .bat |
| **Start ComfyUI automatically** | Your choice | Launches the .bat if ComfyUI doesn't respond |

4. Click **"Test ComfyUI"**

If all is well: **"ComfyUI reachable and ready."**

---

## 5. Auto-start

With **"Start ComfyUI automatically"** enabled and the `.bat` path filled in, Story Studio launches ComfyUI itself if necessary when you request an image.

> **Note**: ComfyUI typically takes 30–90 seconds to start. Story Studio waits up to 60 seconds before showing an error.

---

## 6. Import a workflow

Story Studio works with **ComfyUI workflows** — recipes that define how images are generated. Workflows are provided embedded in the application.

To import a custom workflow:

1. In ComfyUI (browser), configure your workflow as you wish
2. Enable **developer mode**: Settings → Enable Dev Mode Options

[SCREENSHOT: ComfyUI Settings with "Enable Dev Mode Options" checked]

3. Export the workflow in **API format** (`*-api.json` file)
4. Create or obtain a Story Studio configuration file (`*.config.json`) describing the exposed parameters
5. In Story Studio → Options → ComfyUI section:
   - Click **"Pick \*-api.json…"** → select your ComfyUI export
   - Click **"Pick \*.config.json…"** → select the config file
   - Click **"Import"**

[SCREENSHOT: "Import a custom workflow" section with the two selection buttons and the Import button]

The workflow appears in the list of available workflows.

---

## 7. Use ComfyUI in the editor

Once enabled, a **"✨ Generate AI"** button appears under each image field of the editor.

[SCREENSHOT: Image field in the editor with the "Generate AI" button]

1. Click this button
2. Pick a workflow from the list
3. Write a prompt (image description in English for better results)
4. Click **Generate** — the image is automatically saved in your workspace and appears in the render queue at the bottom of the screen
5. Click the generated image to use it directly in the project

> **Expected format**: Story Studio generates images at 320×240 pixels (Lunii format). The embedded workflows handle this automatically.

---

## Common errors

**"ComfyUI not responding at http://127.0.0.1:8188"**
ComfyUI isn't running.
→ Launch the `.bat` manually, or enable auto-start with the `.bat` path filled in.

**ComfyUI starts but doesn't generate any image**
A model is probably missing in `models\checkpoints\`.
→ Download a `.safetensors` model and place it in that folder (see section 2).

**Generated images are blurry or incoherent**
The model isn't suitable, or the prompt is too vague.
→ Try a different model, or specify the style in the prompt (e.g. "children book illustration, flat colors, simple background").

**"Starting… (may take up to 60s)" then an error**
ComfyUI takes too long to start, or the `.bat` is incorrect.
→ Check the `.bat` path in Options. Launch it manually to see if errors appear in the CMD window.

**Error when importing a workflow**
The API JSON file isn't in the right format.
→ In ComfyUI (browser), make sure to enable **developer mode** (Settings → Enable Dev Mode Options) before exporting in API format.

---

## Using ComfyUI and XTTS at the same time

If you use both tools simultaneously on a PC with a single GPU:

- **XTTS** and **ComfyUI** share GPU memory
- This can cause slowdowns or out-of-memory errors
- **Recommended workaround**: in Story Studio → Options → XTTS, enable **"Force CPU"** — XTTS then uses the CPU and leaves the GPU fully available for ComfyUI
