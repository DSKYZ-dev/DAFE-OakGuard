# DAFE Charts — User Guide

## Overview

DAFE Charts is a professional-grade trading charting platform with an onboard AI Trade Advisor powered by a local LLM. It provides real-time market data visualization, one-click trading, technical analysis, web-search-augmented market intelligence, and voice interaction — all running entirely on your own hardware.

## Table of Contents

1. [Launching the Application](#launching-the-application)
2. [Main Interface](#main-interface)
3. [Symbol Selection & Data Loading](#symbol-selection--data-loading)
4. [Chart Navigation](#chart-navigation)
5. [Chart Types](#chart-types)
6. [Timeframes](#timeframes)
7. [Drawing Tools](#drawing-tools)
8. [Volume Profile](#volume-profile)
9. [OakScript — Custom Indicators](#oakscript--custom-indicators)
10. [Trade Advisor](#trade-advisor)
11. [Trading Panel](#trading-panel)
12. [News Feed](#news-feed)
13. [Settings](#settings)
14. [Hotkeys](#hotkeys)
15. [3D Mode](#3d-mode)
16. [Voice Commands](#voice-commands)
17. [Shutting Down](#shutting-down)

---

## Launching the Application

Double-click `start.bat` in the root folder. This single script launches everything:

- **LLM Server** (port 8081) — local AI model for the Trade Advisor
- **Backend Server** (port 8788) — market data, web search, voice synthesis, settings
- **Frontend** (port 5173) — the charting interface

Your default browser opens automatically to `http://127.0.0.1:5173`.

### Launch Flags

| Command | Effect |
|---------|--------|
| `start.bat` | Full launch (LLM + backend + frontend) |
| `start.bat -no-llm` | Skip the LLM — faster startup, charting only |
| `start.bat -reset` | Kill all services, clear caches, then launch |

If you only need charting without the AI advisor, use `start.bat -no-llm` for the fastest experience.

The main terminal window shows service status and health checks. **Press ENTER** in this window to shut down all services cleanly.

---

## Main Interface

When the application loads, you'll see:

- **Top Bar** — Symbol selector, timeframe selector, bar type selector, settings gear
- **Main Chart Area** — Candlestick/bar chart with volume profile overlay
- **Right Column** — News feed, settings panel (on toggle)
- **Top-Right** — Trading panel (collapsible, draggable)
- **Bottom-Right** — Trade Advisor FAB (diamond button)
- **Bottom Bar** — Status indicators, VPI toggle, 3D toggle, OakScript toggle

---

## Symbol Selection & Data Loading

1. Click the symbol input at the top (`SPY` by default)
2. Type a symbol — a dropdown appears with matching securities from 67+ pre-loaded symbols
3. Press **Enter** or click the result to load data

**Pre-loaded symbols include:**
- **ETFs**: SPY, QQQ, DIA, IWM, VTI, VOO, GLD, SLV, TLT, XL*, SMH, IBIT, ARKK, TQQQ, SQQQ
- **Stocks**: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, AVGO, AMD, NFLX, ADBE, CRM, INTC, ORCL, IBM, QCOM, MU, NOW, PANW, SNOW, JPM, BAC, GS, V, MA, PYPL, COIN, PLTR, XOM, CVX, JNJ, UNH, PFE, LLY, WMT, COST, HD, MCD, DIS, BA, CAT, GE, LMT, NOC
- **Crypto**: BTC-USD, ETH-USD, SOL-USD
- **Forex**: EURUSD=X, GBPUSD=X, USDJPY=X
- **Futures**: GC=F, SI=F, CL=F, NG=F

You can also type any valid Yahoo Finance ticker and press Enter.

The data status indicator shows which provider served the data:
- `massive` — Massive API (if API key configured)
- `yahoo` — Yahoo Finance
- `synthetic` — Generated demo data (used when both providers are unavailable)

---

## Chart Navigation

| Action | How |
|--------|-----|
| **Scroll** | Mouse wheel — zoom in/out (adjusts bar spacing) |
| **Pan** | Click and drag horizontally on the chart |
| **Vertical Pan** | Click and drag vertically |
| **Crosshair** | Hover over the chart to see OHLCV tooltip |

---

## Chart Types

Select from the dropdown in the bottom toolbar:

| Type | Description |
|------|-------------|
| **Candlestick** | Standard Japanese candlesticks |
| **Heikin-Ashi** | Smoothed candlesticks for trend clarity |
| **Renko** | Price-movement-based bricks |
| **Range Bar** | Fixed price-range bars |
| **Volume Bar** | Fixed volume bars |
| **Tick Bar** | Fixed tick-count bars |
| **Kagi** | Directional line breaks |
| **Footprint** | Bid/ask volume at price |
| **Line** | Close-price line chart |
| **Area** | Filled area chart |
| **Dollar Bar** | Fixed dollar-volume bars |
| **Imbalance Bar** | Order-imbalance bars |

---

## Timeframes

Available from the timeframe selector: **1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w**.

When live data is loaded, the backend fetches the appropriate historical period based on the timeframe:
- 1m: 7 days of data
- 5m: 60 days
- 15m/30m: 6 months
- 1h/2h/4h: 6 months to 1 year
- 1d/1w: 2 years

---

## Drawing Tools

Access drawing tools from the vertical toolbar on the left side of the chart:

| Tool | Description |
|------|-------------|
| **Horizontal Line** | Draw a price level |
| **Ray / Trend Line** | Draw directional lines |
| **Rectangle** | Mark a price/time zone |
| **Fibonacci Retracement** | Auto-plot fib levels from high to low |
| **Channel** | Parallel channel lines |
| **Text** | Add a text annotation |

- Click a tool to activate it, then click/drag on the chart
- Use the **Clear** button to remove all drawings
- Use **Undo** to remove the last drawing
- Use **Deselect** to deactivate the current tool

---

## Volume Profile

The volume profile appears as a horizontal histogram on the right side of the chart, showing volume distribution across price levels.

**Controls:**
- Toggle on/off via the **VPI** button in the bottom bar
- Adjust settings in the Settings panel under "Volume Profile":
  - **Lookback Bars** — how many bars to include
  - **Bin Count** — number of price bins
  - **Value Area %** — percentage for value area calculation
  - **Profile Width** — width of the profile on screen

---

## OakScript — Custom Indicators

OakScript is a built-in scripting language for creating custom technical indicators. Access it by clicking the OakScript toggle in the bottom bar.

**Opening the editor:** Click the OakScript button in the bottom bar to open the editor panel.

**Writing indicators:** You can define custom calculations like:
- Moving averages (SMA, EMA)
- RSI, MACD, Bollinger Bands
- Custom price transformations
- Alert conditions

Indicators plot directly on the chart and/or in a separate indicator pane below.

**Persistence:** Your script is saved in browser `localStorage` and persists across sessions.

**Overrides:** You can tweak indicator parameters without editing the script via the Overrides panel.

---

## Trade Advisor

The Trade Advisor is an AI assistant that can analyze your charts, answer market questions, and provide trading insights. It runs on your local GPU via llama.cpp.

### Opening

Click the **diamond button (◆)** in the bottom-right corner. The advisor panel slides open.

### How It Works

The advisor **automatically** has full context of what's on your chart. Every time you load a symbol or the chart updates, the current chart state (symbol, price, OHLCV bars, indicators, volume) is injected into the conversation. You don't need to press "Analyze" first — just ask a question.

### Features

| Button | Function |
|--------|----------|
| **Analyze** | Performs a deep analysis: fetches web search results for the current symbol (news + earnings), combines them with chart data, and provides a comprehensive market analysis including trend direction, key levels, patterns, and risk assessment |
| **Voice** | Starts/stops voice recognition (say "Advisor" followed by your question) |
| **♾️ Free** | Toggles continuous voice mode — advisor listens indefinitely, just say "Advisor?" before each question |
| **Clear** | Clears the conversation history |

### Example Questions

- "What's the current trend on SPY?"
- "What are the key support and resistance levels?"
- "Analyze the volume profile"
- "What's the risk/reward for a long entry here?"
- "How do the indicators look?"

### Copy Messages

Hover over any message and click the **📋 button** to copy it to your clipboard.

---

## Trading Panel

Located in the top-right corner (draggable, collapsible).

### Features

- **Spread Display** — Shows the current bid/ask spread
- **SELL Button** (red) — Simulates a market sell order
- **BUY Button** (blue) — Simulates a market buy order
- **Quantity Input** — Adaptive units that change based on the security type:
  - **shares** — Stocks, ETFs
  - **contracts** — Futures (ES, NQ, CL, GC, etc.)
  - **lots** — Forex (EURUSD, GBPUSD, etc.)
  - **coins** — Crypto (BTCUSD, ETHUSD)

### Using the Panel

1. Load a symbol — prices auto-populate
2. Set your quantity
3. Click BUY or SELL — the order is sent to the advisor for confirmation

The panel can be dragged anywhere on screen by its header bar and collapsed with the **−** button.

---

## News Feed

The news feed box on the right side shows:

- **Stock-specific news** — fetched for the current symbol
- **Earnings reports** — recent and upcoming
- **Fed/Macro events** — FOMC meetings, Fed speeches, economic data

**FED event warnings** appear as yellow banners when relevant keywords are detected (FOMC, Federal Reserve, interest rate, etc.).

News refreshes automatically every 2 minutes. Timestamps show your local time.

The news box can be collapsed with the **−** button.

---

## Settings

Click the **gear icon** in the top bar to open the settings panel.

### LLM Configuration

| Setting | Description |
|---------|-------------|
| **LLM Provider** | `local` (llama.cpp) or `ollama` |
| **Ollama URL** | Ollama server address |
| **Trade Advisor Model** | Model name for the advisor |
| **Advisor Voice** | TTS voice preference: Auto, Natural, Male, Female, Soft |

### Data

| Setting | Description |
|---------|-------------|
| **Source** | `massive` (primary) or `yahoo` (fallback) |

### API Keys

| Key | Purpose |
|-----|---------|
| **Massive API Key** | Premium market data (faster, more reliable than Yahoo) |
| **SerpAPI Key** | Enhanced web search results |

### Hotkeys

Customize keyboard shortcuts for tools and modes. See the [Hotkeys](#hotkeys) section.

---

## Hotkeys

Default hotkey assignments (requires numpad):

| Key | Action |
|-----|--------|
| Numpad 0 | Toggle 3D mode |
| Numpad 1 | Toggle volume profile |
| Numpad 2 | Toggle timeframe |
| Numpad 3 | Toggle OakScript |
| Numpad 4 | Toggle trend |
| Numpad 5 | Horizontal line tool |
| Numpad 6 | Ray / trend line tool |
| Numpad 7 | Rectangle tool |
| Numpad 8 | Fibonacci tool |
| Numpad 9 | Channel tool |
| Numpad + | Text annotation |
| Numpad - | Undo last drawing |
| Numpad * | Clear all drawings |
| Numpad . | Deselect tool |

All hotkeys can be customized in Settings.

---

## 3D Mode

Toggle 3D mode via the **3D button** in the bottom bar or **Numpad 0**.

In 3D mode:
- Candlesticks render as 3D columns
- Volume profile renders as a 3D heatmap
- Rotate the view by clicking and dragging
- Zoom with mouse wheel

Toggle back to 2D for standard charting.

---

## Voice Commands

### Setup

Click the **🎤 Voice** button in the advisor panel. Grant microphone permission when prompted.

### Wake Word

The wake word is **"Advisor"** (customizable). Say it clearly, then speak your question. The advisor will:

1. Transcribe your speech to text
2. Send it to the AI
3. Read the response aloud using text-to-speech

### Continuous Mode

Click **♾️ Free** to enable continuous listening. The advisor listens in the background and responds whenever you say the wake word.

### Voice Preferences

Choose a TTS voice in Settings → Advisor Voice:
- **Auto** — Best available natural voice
- **Natural / Neural** — Windows 11 natural voices
- **Male** — David, Mark, or similar
- **Female** — Zira, Susan, or similar
- **Soft** — Softer-toned voices

---

## Shutting Down

**Method 1 (Recommended):** Go to the main start.bat terminal window and press **ENTER**. All services stop cleanly.

**Method 2:** Close each window individually (llama-server, backend, frontend).

**Method 3:** Run `reset.bat` to force-kill all services and clear caches.
