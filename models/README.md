# Models

Drop one or more `.gguf` model files in this folder. Nothing else to configure.

`backend/model_manager.py` reads each file's real GGUF header (layer count,
embedding size, grouped-query attention heads, trained context length), measures
your free VRAM (`nvidia-smi` / `amd-smi` / `rocm-smi` / Apple Metal unified
memory, with a CPU fallback), and derives the launch parameters for that model
on that machine: context size, GPU layer offload, batch size, and thread count.

- No saved preference: the largest model that fully fits VRAM is chosen.
- Pin a specific model in **Settings → Trade Advisor Model** (or in
  `backend/settings.json`) to override.
- Switching models in the UI hot-reloads llama.cpp without restarting the app.

Recommended: a 3B–12B instruct model. Larger models are more capable but need
more VRAM; smaller ones load in seconds.

Model files are ignored by git (`models/*.gguf`) — they are multi-gigabyte
artifacts, not source. Check the license of any model you download before
shipping it with an application.

See `docs/SETUP.md` for the full local-LLM setup path, and the
**Provider API Keys** panel in Settings to run the advisor on a hosted model
(OpenCode, OpenRouter, OpenAI, Anthropic, OrcaRouter, NVIDIA NIM, or any
OpenAI-compatible endpoint) when the machine has no GPU headroom.
