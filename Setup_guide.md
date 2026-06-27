# DAFE Charts — Setup Guide

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [LLM Setup (Optional)](#llm-setup-optional)
5. [Configuration](#configuration)
6. [Verifying the Installation](#verifying-the-installation)
7. [Project Structure](#project-structure)
8. [Troubleshooting](#troubleshooting)
9. [Development Notes](#development-notes)

---

## System Requirements

### Minimum (Charting Only — `start.bat -no-llm`)

| Component | Requirement |
|-----------|-------------|
| OS | Windows 10/11 (x64) |
| Node.js | 18.x or later |
| Python | 3.10 or later |
| RAM | 4 GB |
| Internet | Required for market data and web search |

### Recommended (With LLM Advisor)

| Component | Requirement |
|-----------|-------------|
| OS | Windows 10/11 (x64) |
| Node.js | 18.x or later |
| Python | 3.10 or later |
| RAM | 16 GB |
| GPU | NVIDIA RTX 3060 or better with 8+ GB VRAM |
| CUDA | 12.4 or later (for GPU acceleration) |
| Storage | ~10 GB free (model files are 5-6 GB) |
| Internet | Required for market data and web search |

### Tested Configuration

| Hardware | Performance |
|----------|-------------|
| RTX 5050 Laptop (8 GB VRAM) + Ryzen 5 240 + 16 GB RAM | ~50 tokens/second (text-only), ~16 tokens/second (with vision) |

---

## Prerequisites

### 1. Node.js & npm

Download and install from: https://nodejs.org/

Verify installation:
```bash
node --version   # should be 18.x or later
npm --version    # should be 9.x or later
```

### 2. Python & pip

Download and install from: https://python.org/

**Important:** Check "Add Python to PATH" during installation.

Verify installation:
```bash
python --version   # should be 3.10 or later
pip --version
```

### 3. Git (for cloning)

Download from: https://git-scm.com/

---

## Installation

### Step 1: Clone or Copy the Repository

```bash
git clone <repository-url> DAFECharts
cd DAFECharts
```

Or simply copy the `DAFECharts` folder to your desired location (e.g., `C:\DAFECharts`).

### Step 2: Install Node.js Dependencies

```bash
cd C:\DAFECharts
npm install
```

This installs all frontend dependencies including Vite, TypeScript, and Three.js (for 3D rendering).

### Step 3: Install Python Dependencies

```bash
cd C:\DAFECharts\backend
pip install -r requirements.txt
```

This installs:
- **fastapi** — Web framework for the backend API
- **uvicorn** — ASGI server
- **httpx** — HTTP client for external API calls
- **yfinance** — Yahoo Finance market data
- **gTTS** — Google Text-to-Speech (voice synthesis)

### Step 4: Verify the Frontend Compiles

```bash
cd C:\DAFECharts
npm run lint
```

This runs TypeScript type-checking. It should complete with no errors.

### Step 5: Verify the Backend

```bash
cd C:\DAFECharts\backend
python -c "import main; print('Backend OK')"
```

---

## LLM Setup (Optional)

The Trade Advisor requires a local LLM. You can skip this section and run with `start.bat -no-llm` for charting only.

### Step 1: Install llama.cpp CUDA Build

1. Go to https://github.com/ggerganov/llama.cpp/releases
2. Download the latest `llama-bXXXX-bin-win-cuda-12.4-x64.zip` (the CUDA-enabled binary package)
3. Download the matching `cudart-llama-bin-win-cuda-12.4-x64.zip` (CUDA runtime DLLs)
4. Create folder `C:\llama.cpp` if it doesn't exist
5. Extract BOTH zip files into `C:\llama.cpp` (allow overwrites)

**Verify CUDA is detected:**
```bash
cd C:\llama.cpp
llama-server.exe --help
```

Look for `CUDA` in the output. If you see only `CPU` backends listed, the CUDA build is not properly installed.

### Step 2: Download a GGUF Model

Place a GGUF-format model file in `C:\DAFECharts\models\`.

**Recommended model:** A 7-9B parameter Q4_K_M quantized model (e.g., Qwen2.5, Llama 3, Mistral).

The default configuration expects:
```
C:\DAFECharts\models\Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M.gguf
```

You can change the model path and name by editing `start.bat` and updating the `MODEL_NAME` variable.

### Step 3: GPU Drivers

Ensure NVIDIA drivers with CUDA 12.4+ are installed:
```bash
nvidia-smi
```

Should show your GPU with driver version and CUDA version.

### How Auto-Detection Works

On launch, `start.bat` automatically:
1. Checks if `nvidia-smi` is available → GPU mode
2. Detects VRAM and configures layer count, context size, and batch size accordingly
3. Detects CPU cores and sets thread count
4. Prints the detected configuration in the terminal

| VRAM | -ngl (GPU layers) | Context |
|------|-------------------|---------|
| 16 GB+ | -1 (all layers) | 8192 |
| 12 GB+ | 42 | 4096 |
| 8 GB+ | 33 → -1 | 4096 |
| 6 GB+ | 24 | 1536 |
| 4 GB+ | 16 | 1024 |

---

## Configuration

### Backend Settings

The backend stores settings in `C:\DAFECharts\backend\settings.json`. This file is created automatically on first run. You can also configure settings through the Settings panel in the application UI.

**Available settings:**
```json
{
    "massive_api_key": "",
    "serpapi_api_key": "",
    "llm_provider": "local",
    "ollama_base_url": "http://localhost:11434",
    "local_llm_base_url": "http://localhost:8081",
    "llm_trade_advisor_model": "qwythos-9b",
    "market_data_source": "yahoo"
}
```

### API Keys (Optional)

| Service | Purpose | Get Key From |
|---------|---------|--------------|
| Massive | Premium market data | massive.com |
| SerpAPI | Enhanced web search | serpapi.com |

Without API keys:
- Market data falls back to Yahoo Finance (free, rate-limited)
- Web search uses DuckDuckGo HTML scraping (free, no key needed)

### Model Configuration

Edit `start.bat` lines 8-10 to change the model:
```batch
set "MODEL_NAME=your-model-name.gguf"
```

The `llama.cpp` directory can also be changed:
```batch
set "LLAMA_DIR=C:\llama.cpp"
```

---

## Verifying the Installation

### 1. Quick Test — Charting Only

```bash
start.bat -no-llm
```

This should:
- Start the backend server (port 8788)
- Start the frontend (port 5173)
- Open your browser to the chart

Type a symbol (e.g., `SPY`) and press Enter. You should see candlestick data load.

### 2. Full Test — With LLM

```bash
start.bat
```

Expect:
- Backend starts (port 8788)
- LLM loads (30-90 seconds, visible in the llama-server window)
- Frontend starts (port 5173)
- Browser opens

Click the **◆** diamond button and type "hello". The advisor should respond within seconds.

### 3. Verify Services

| Service | URL |
|---------|-----|
| Backend health | http://127.0.0.1:8788/api/ping |
| LLM health | http://127.0.0.1:8081/health |
| Frontend | http://127.0.0.1:5173 |

---

## Project Structure

```
DAFECharts/
├── apps/web/              # Frontend application (Vite + TypeScript)
│   ├── index.html         # Main HTML with all CSS
│   ├── vite.config.ts     # Vite configuration
│   ├── package.json       # Frontend dependencies
│   └── src/
│       ├── main.ts        # Core application logic
│       ├── chart-renderer.ts  # Canvas rendering
│       ├── data-generator.ts  # Synthetic data generation
│       ├── data-stream/       # Live data fetching
│       ├── oakscript/         # Custom indicator scripting engine
│       │   ├── lexer.ts       # Tokenizer
│       │   ├── parser.ts      # Syntax parser
│       │   ├── interpreter.ts # Script executor
│       │   ├── editor.ts      # Code editor UI
│       │   └── docs.ts        # Documentation
│       └── trade-advisor/     # AI Trade Advisor module
│           ├── agent.ts       # Agent logic
│           ├── voice.ts       # Speech recognition + TTS
│           ├── web-search.ts  # Web search client
│           ├── visual-adapter.ts  # Chart context builder
│           └── memory.ts      # Conversation persistence
│
├── backend/               # Python backend server
│   ├── main.py            # FastAPI server (all endpoints)
│   └── requirements.txt   # Python dependencies
│
├── packages/              # Shared TypeScript packages
│   ├── core/              # Core charting engine
│   ├── types/             # Type definitions
│   ├── ui/                # UI components
│   ├── themes/            # Visual themes
│   ├── indicators/        # Indicator API + Python bridge
│   └── wasm-math/         # WebAssembly math (Rust)
│
├── models/                # GGUF model files (gitignored)
├── start.bat              # Main launcher
├── reset.bat              # Hard reset utility
├── start-backend.bat      # Debug: backend only
├── start-frontend.bat     # Debug: frontend only
├── start-llama.bat        # Debug: LLM only
├── package.json           # Root workspace config
├── tsconfig.json          # TypeScript config
├── .gitignore
├── User_guide.md
└── Setup_guide.md
```

---

## Troubleshooting

### "LLM server not running at http://localhost:8081"

The LLM hasn't started yet or has crashed. Check:
1. The llama-server terminal window for red error text
2. That `llama-server.exe` exists at `C:\llama.cpp\`
3. That the GGUF model file exists at `C:\DAFECharts\models\`
4. That your GPU has enough VRAM (the model + KV cache must fit)

**Solution:** Use `start.bat -no-llm` to run without the LLM.

### "Model not found"

The GGUF file is missing. Place your model file at:
```
C:\DAFECharts\models\Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M.gguf
```

Or edit `start.bat` to point to your model's path.

### "llama.cpp server returned 400"

This usually means the prompt exceeds the context window. The application handles this automatically in most cases, but if it persists:
1. Reduce conversation history by clicking **Clear** in the advisor
2. Ask shorter questions
3. Restart the LLM (close and relaunch start.bat)

### "Data: synthetic" in status bar

Neither Massive nor Yahoo Finance could provide data for the symbol. This can happen if:
- The symbol is invalid or delisted
- Yahoo Finance is rate-limiting your IP
- Massive API key is expired or over quota

The app falls back to synthetic data generation so you can still use the chart.

### Backend won't start

1. Check Python is in PATH: `python --version`
2. Check dependencies are installed: `pip install -r backend\requirements.txt`
3. Check port 8788 is not in use: `netstat -ano | findstr 8788`
4. Run the debug helper: `start-backend.bat` to see error output

### Frontend blank or won't load

1. Check port 5173 is not in use
2. Clear Vite cache: run `reset.bat`
3. Hard refresh browser: `Ctrl+Shift+R`
4. Check browser console for errors (F12 → Console)

### "Connection error" in Trade Advisor

The backend is not running or not reachable:
1. Check the backend terminal window for errors
2. Verify http://127.0.0.1:8788/api/ping returns `{"ok":true}`
3. Make sure no firewall is blocking port 8788

### LLM runs on CPU instead of GPU

If the llama-server window shows only CPU in `device_info` and no `CUDA0`:
1. You don't have the CUDA build of llama.cpp — download it from GitHub releases
2. Your NVIDIA drivers need updating — run `nvidia-smi` to check
3. The model is too large for your VRAM — use a smaller model or quantize further

### Voice not working

1. Grant microphone permission when prompted
2. Check browser supports SpeechRecognition API (Chrome/Edge recommended)
3. For TTS: check that `gTTS` Python package is installed
4. Windows 11 has built-in natural voices — select "Natural" in Settings → Advisor Voice

---

## Development Notes

### Running Individual Services

For development/debugging, you can run services separately:

```bash
# Backend only (with auto-reload)
start-backend.bat

# Frontend only (Vite dev server with HMR)
start-frontend.bat

# LLM only
start-llama.bat
```

### TypeScript

```bash
# Type check
npm run lint

# Build (if you need production build)
npm run build
```

### Python Backend

The backend is a single-file FastAPI application at `backend/main.py`. It requires no database, no external services — just the Python dependencies.

To add endpoints, edit `backend/main.py` directly. The file is self-contained with all routes, middleware, and logic.

### Adding Symbols

The securities list is embedded in two places:
1. `apps/web/src/main.ts` — for the frontend symbol dropdown
2. `backend/main.py` — for the `/api/market-data/securities` endpoint

Add new symbols to both files to keep them in sync.

### Customizing Behavior

- **LLM params**: Edit the adaptive detection section in `start.bat` (around line 70)
- **Chart defaults**: Edit `main.ts` initial state variables (around line 40)
- **Voice wake word**: Pass `wakeWord` option to `AdvisorVoice` constructor
- **News refresh interval**: Edit `fetchNews` interval in `main.ts` (line ~1170)
