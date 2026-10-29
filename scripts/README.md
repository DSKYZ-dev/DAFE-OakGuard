# Scripts

Windows helpers. Every path is relative to the script (`%~dp0..` = repository
root), so the folder can be moved anywhere without editing.

## Everyday

| Script | What it does |
|---|---|
| `../start.bat` | **The launcher.** Stops stale services, asks `model_manager.py` which model fits this machine, starts llama.cpp → backend → frontend, waits for each to answer, opens the browser, and shuts everything down on Enter. Flags: `-no-llm`, `-vision`, `-reset`. |
| `reset.bat` | Kills the three services by port (8081 / 8788 / 5173), clears the Python and Vite caches. Use when something is wedged. |

## Debug helpers — one service at a time

| Script | What it does |
|---|---|
| `start-backend.bat` | Runs the FastAPI backend alone, with auto-reload. |
| `start-frontend.bat` | Runs the Vite dev server for the web app alone. |
| `start-llama.bat` | Runs llama.cpp alone with the auto-selected model and parameters, and captures its log to `%TEMP%\dafe_llama_debug.log` (last 20 lines printed on exit). |
| `start-mobile.bat` | Runs the mobile app's dev server for a phone on the LAN (`http://<your-ip>:5174`). |

## Releases and deployment

| Script | What it does |
|---|---|
| `archive-apk.bat` | Copies the current debug APK into `releases/` as `DAFECharts-v<version>-<timestamp>.apk`. |
| `deploy-demo.bat` | Builds the web app and publishes the static build to a GitHub Pages demo repo (`dafe-charts-demo`). |
| `deploy-mobile-demo.bat` | Same, for the mobile bundle (`dafe-mobile-demo`). |

> `deploy-*.bat` publish to the repository owner's GitHub Pages. Point them at
> your own remote before using them.

## Requirements

- Python on `PATH` (the backend and the model manager are Python).
- Node.js 18+ for Vite, the builds and the harness.
- PowerShell for the process/port handling in `start.bat` and `reset.bat`
  (present on every supported Windows version).
