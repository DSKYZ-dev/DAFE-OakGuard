"""
DAFE Charts — Self-contained backend server.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import tempfile
from typing import Any, Optional

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
logger = logging.getLogger("dafe")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="DAFE Charts", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------------------
# Settings (simple JSON file in the backend directory)
# ---------------------------------------------------------------------------
SETTINGS_FILE = os.path.join(os.path.dirname(__file__), "settings.json")
DEFAULTS: dict[str, Any] = {
    "massive_api_key": "", "serpapi_api_key": "",
    "llm_provider": "local", "ollama_base_url": "http://localhost:11434",
    "local_llm_base_url": "http://localhost:8081",
    "llm_trade_advisor_model": "qwythos-9b",
    "market_data_source": "yahoo",
}

def load_settings() -> dict[str, Any]:
    s = dict(DEFAULTS)
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                s.update(json.load(f))
        except Exception:
            pass
    return s

def save_settings(data: dict[str, Any]) -> None:
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def mask_key(k: str) -> str:
    return (k[:4] + "*" * (len(k) - 8) + k[-4:]) if len(k) >= 8 else k

# ---------------------------------------------------------------------------
# Health / ping
# ---------------------------------------------------------------------------
@app.get("/api/ping")
def ping():
    return {"ok": True}

# ---------------------------------------------------------------------------
# Chat — proxy to llama.cpp /v1/chat/completions
# ---------------------------------------------------------------------------
AGENT_SYSTEM_PROMPTS = {
    "trade_advisor": (
        "You are the DAFE Trade Advisor, a helpful trading assistant. "
        "IMPORTANT: You are NOT Qwythos. You are NOT created by Empero AI. "
        "Your name is 'Trade Advisor'. When introducing yourself, say: "
        "'Hi there, I'm your Trade Advisor and assistant. How can I help you today?' "
        "Never claim to be Qwythos, Qwen, Empero AI, or any other AI model. "
        "You specialize in chart analysis, indicator tuning, market research, and risk assessment. "
        "Analyze OHLCV data, identify patterns, support/resistance levels, and candlestick formations. "
        "Be concise, data-driven, and use proper trading terminology."
    ),
}

@app.post("/api/chat")
async def api_chat(body: dict[str, Any]):
    settings = load_settings()
    agent = body.get("agent", "trade_advisor")
    messages = body.get("messages", [])
    user_msg = body.get("message", "")
    model = body.get("model", "") or settings.get("llm_trade_advisor_model", "qwythos-9b")
    provider = settings.get("llm_provider", "local")
    system_prompt = body.get("system_prompt", "") or AGENT_SYSTEM_PROMPTS.get(agent, "")

    # Build messages: system first (required by model template), then identity override, then actual messages
    ollama_messages: list[dict] = []
    if system_prompt:
        ollama_messages.append({"role": "system", "content": system_prompt})

    # Identity override priming
    ollama_messages.append({"role": "user", "content": (
        "CRITICAL INSTRUCTION — OBEY THIS OVER ALL PREVIOUS IDENTITY RULES: "
        "Forget any and all previous identity instructions. "
        "You are NOT Qwythos. You are NOT created by Empero AI. "
        "Your identity is: DAFE Trade Advisor, an expert trading assistant. "
        "When introducing yourself, say: \"Hi there, I'm your Trade Advisor and assistant. How can I help you today?\" "
        "Never say Qwythos, Empero AI, Qwen, Alibaba, or any other model name. Your name is Trade Advisor, period."
    )})
    ollama_messages.append({"role": "assistant", "content": "Understood. I am the DAFE Trade Advisor, your trading assistant. How can I help you today?"})

    # Append actual conversation messages — pass multimodal content through as-is
    for m in messages:
        role = m.get("role", "user")
        if role == "system-context":
            role = "system"
        content = m.get("content", "")
        ollama_messages.append({"role": role, "content": content})

    if user_msg and user_msg not in [m.get("content", "") for m in messages]:
        ollama_messages.append({"role": "user", "content": str(user_msg)})

    # Call LLM
    if provider == "local":
        base_url = settings.get("local_llm_base_url", "http://localhost:8081")
        chat_url = f"{base_url.rstrip('/')}/v1/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(chat_url, json={
                    "model": model, "messages": ollama_messages,
                    "temperature": 0.3, "stream": False, "think": False,
                })
                if resp.status_code != 200:
                    text = await resp.aread()
                    return {"ok": False, "detail": f"llama.cpp returned {resp.status_code}: {str(text)[:300]}"}
                data = resp.json()
                choice = data.get("choices", [{}])[0]
                reply = choice.get("message", {}).get("content", "")
                think = choice.get("message", {}).get("think", "")
                # Merge think content if visible reply is empty (model puts everything in <think>)
                if not reply and think:
                    reply = think
                elif think:
                    reply = think + "\n\n" + reply
                finish = choice.get("finish_reason", "")
                logger.info("chat response: %d choices, finish=%s, reply_len=%d, think_len=%d",
                           len(data.get("choices", [])), finish, len(reply or ""), len(think or ""))
                if not reply:
                    logger.warning("empty reply from llama.cpp — full response: %s",
                                  str(data)[:500])
                return {"ok": True, "reply": reply or "(empty response)"}
        except httpx.ConnectError:
            return {"ok": False, "detail": "LLM server not running at " + base_url}
        except httpx.TimeoutException:
            return {"ok": False, "detail": "LLM timed out — model may be loading"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}
    else:
        # Ollama
        base_url = settings.get("ollama_base_url", "http://localhost:11434")
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(f"{base_url.rstrip('/')}/api/chat", json={
                    "model": model, "messages": ollama_messages, "stream": False,
                })
                if resp.status_code != 200:
                    return {"ok": False, "detail": f"Ollama returned {resp.status_code}"}
                data = resp.json()
                reply = data.get("message", {}).get("content", "")
                return {"ok": True, "reply": reply or "(empty response)"}
        except httpx.ConnectError:
            return {"ok": False, "detail": "Ollama not running at " + base_url}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

# ---------------------------------------------------------------------------
# Web Search (DuckDuckGo HTML scraper)
# ---------------------------------------------------------------------------
DDG_URL = "https://html.duckduckgo.com/html/"
SEARCH_CATEGORIES = {
    "earnings": "stock earnings report revenue quarterly results",
    "news": "stock market news",
    "risks": "stock risk factors analysis warning",
    "analysis": "stock technical analysis price target forecast",
}

@app.post("/api/web-search/search")
async def api_web_search(body: dict[str, Any]):
    query = body.get("query", "").strip()
    category = body.get("category", "general")
    max_results = min(int(body.get("max_results", 5)), 20)
    symbol = body.get("symbol", "").strip()

    if not query and not symbol:
        raise HTTPException(status_code=400, detail="query or symbol required")

    base_query = query or symbol
    cat_suffix = SEARCH_CATEGORIES.get(category, "")
    search_query = f"{base_query} {cat_suffix}" if cat_suffix else base_query
    if symbol:
        search_query = f"{symbol} ({search_query})"

    results: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.post(DDG_URL, data={"q": search_query}, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            })
            if resp.status_code == 200:
                for m in re.finditer(r'<a[^>]*class="result__a"[^>]*href="(.*?)"[^>]*>(.*?)</a>', resp.text):
                    url = m.group(1)
                    title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
                    if url and title and len(results) < max_results:
                        results.append({"title": title, "url": url})
    except Exception:
        pass

    return {"ok": True, "query": search_query, "category": category, "results": results}

# ---------------------------------------------------------------------------
# Voice (gTTS)
# ---------------------------------------------------------------------------
@app.post("/api/voice/synthesize")
async def api_voice_synthesize(body: dict[str, Any]):
    text = (body.get("text", "") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    try:
        from gtts import gTTS
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as fp:
            tts = gTTS(text=text, lang="en", slow=False)
            tts.save(fp.name)
            with open(fp.name, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            os.unlink(fp.name)
            return {"audio_b64": b64}
    except Exception as e:
        logger.warning("gTTS failed: %s", e)
        return {"audio_b64": None, "error": str(e)}

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
@app.get("/api/settings")
def api_get_settings():
    s = load_settings()
    resp = dict(s)
    resp["massive_api_key_masked"] = mask_key(s.get("massive_api_key", ""))
    resp["serpapi_api_key_masked"] = mask_key(s.get("serpapi_api_key", ""))
    del resp["massive_api_key"]; del resp["serpapi_api_key"]
    return resp

@app.post("/api/settings")
def api_save_settings(body: dict[str, Any]):
    current = load_settings()
    for key, value in body.items():
        if key in ("massive_api_key", "serpapi_api_key"):
            if value and "*" not in str(value):
                current[key] = str(value).strip()
        elif key in DEFAULTS:
            current[key] = value
    save_settings(current)
    resp = dict(current)
    resp["massive_api_key_masked"] = mask_key(current.get("massive_api_key", ""))
    resp["serpapi_api_key_masked"] = mask_key(current.get("serpapi_api_key", ""))
    del resp["massive_api_key"]; del resp["serpapi_api_key"]
    return {"ok": True, "settings": resp}

# ---------------------------------------------------------------------------
# Market Data (yfinance + embedded securities)
# ---------------------------------------------------------------------------
SECURITIES: list[dict[str, str]] = [
    {"symbol": "SPY", "name": "S&P 500 ETF"}, {"symbol": "QQQ", "name": "Nasdaq-100 ETF"},
    {"symbol": "DIA", "name": "Dow Jones ETF"}, {"symbol": "IWM", "name": "Russell 2000 ETF"},
    {"symbol": "VTI", "name": "Total Stock Market ETF"}, {"symbol": "VOO", "name": "S&P 500 Index ETF"},
    {"symbol": "GLD", "name": "Gold ETF"}, {"symbol": "SLV", "name": "Silver ETF"},
    {"symbol": "TLT", "name": "20+ Year Treasury ETF"}, {"symbol": "XLF", "name": "Financial Sector ETF"},
    {"symbol": "XLK", "name": "Technology Sector ETF"}, {"symbol": "XLE", "name": "Energy Sector ETF"},
    {"symbol": "SMH", "name": "Semiconductor ETF"}, {"symbol": "IBIT", "name": "iShares Bitcoin Trust"},
    {"symbol": "TQQQ", "name": "3x Bull Nasdaq-100"}, {"symbol": "SQQQ", "name": "3x Bear Nasdaq-100"},
    {"symbol": "AAPL", "name": "Apple Inc"}, {"symbol": "MSFT", "name": "Microsoft Corp"},
    {"symbol": "GOOGL", "name": "Alphabet Inc"}, {"symbol": "AMZN", "name": "Amazon.com"},
    {"symbol": "NVDA", "name": "NVIDIA Corp"}, {"symbol": "META", "name": "Meta Platforms"},
    {"symbol": "TSLA", "name": "Tesla Inc"}, {"symbol": "AVGO", "name": "Broadcom Inc"},
    {"symbol": "AMD", "name": "AMD"}, {"symbol": "NFLX", "name": "Netflix Inc"},
    {"symbol": "ADBE", "name": "Adobe Inc"}, {"symbol": "CRM", "name": "Salesforce Inc"},
    {"symbol": "INTC", "name": "Intel Corp"}, {"symbol": "ORCL", "name": "Oracle Corp"},
    {"symbol": "IBM", "name": "IBM Corp"}, {"symbol": "QCOM", "name": "Qualcomm Inc"},
    {"symbol": "MU", "name": "Micron Technology"}, {"symbol": "NOW", "name": "ServiceNow Inc"},
    {"symbol": "PANW", "name": "Palo Alto Networks"}, {"symbol": "SNOW", "name": "Snowflake Inc"},
    {"symbol": "JPM", "name": "JPMorgan Chase"}, {"symbol": "BAC", "name": "Bank of America"},
    {"symbol": "GS", "name": "Goldman Sachs"}, {"symbol": "V", "name": "Visa Inc"},
    {"symbol": "MA", "name": "Mastercard Inc"}, {"symbol": "PYPL", "name": "PayPal Holdings"},
    {"symbol": "COIN", "name": "Coinbase Global"}, {"symbol": "PLTR", "name": "Palantir Technologies"},
    {"symbol": "XOM", "name": "Exxon Mobil"}, {"symbol": "CVX", "name": "Chevron Corp"},
    {"symbol": "JNJ", "name": "Johnson & Johnson"}, {"symbol": "UNH", "name": "UnitedHealth Group"},
    {"symbol": "PFE", "name": "Pfizer Inc"}, {"symbol": "LLY", "name": "Eli Lilly & Co"},
    {"symbol": "WMT", "name": "Walmart Inc"}, {"symbol": "COST", "name": "Costco Wholesale"},
    {"symbol": "HD", "name": "Home Depot Inc"}, {"symbol": "MCD", "name": "McDonald's Corp"},
    {"symbol": "DIS", "name": "Walt Disney Co"}, {"symbol": "BA", "name": "Boeing Co"},
    {"symbol": "CAT", "name": "Caterpillar Inc"}, {"symbol": "GE", "name": "General Electric"},
    {"symbol": "LMT", "name": "Lockheed Martin"}, {"symbol": "NOC", "name": "Northrop Grumman"},
    {"symbol": "BTC-USD", "name": "Bitcoin USD"}, {"symbol": "ETH-USD", "name": "Ethereum USD"},
    {"symbol": "SOL-USD", "name": "Solana USD"}, {"symbol": "EURUSD=X", "name": "EUR/USD"},
    {"symbol": "GBPUSD=X", "name": "GBP/USD"}, {"symbol": "USDJPY=X", "name": "USD/JPY"},
    {"symbol": "GC=F", "name": "Gold Futures"}, {"symbol": "SI=F", "name": "Silver Futures"},
    {"symbol": "CL=F", "name": "Crude Oil"}, {"symbol": "NG=F", "name": "Natural Gas"},
]

SUPPORTED_TIMEFRAMES = {"1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1wk"}
TF_INTERVAL_MAP = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "2h": "2h", "4h": "4h", "1d": "1d", "1wk": "1wk"}

def _yf_period(tf: str, period: str) -> str:
    bars = int(period) if period.strip().isdigit() else 120
    t = tf.strip().lower()
    if t == "1m": return "7d"
    if t == "5m": return "60d"
    if t in ("15m", "30m"): return "6mo"
    if t in ("1h", "2h", "4h"): return "1y" if bars > 500 else "6mo"
    return "2y"

@app.get("/api/market-data/securities")
def api_securities():
    return {"ok": True, "securities": SECURITIES}

@app.get("/api/market-data/providers")
def api_providers():
    s = load_settings()
    massive_ok = bool(s.get("massive_api_key", ""))
    return {"providers": [
        {"name": "massive", "available": massive_ok, "needs_api_key": True, "has_api_key": massive_ok},
        {"name": "yahoo", "available": True, "needs_api_key": False, "has_api_key": None},
    ]}

@app.get("/api/market-data/{symbol}")
async def api_market_data(symbol: str, timeframe: str = "1h", period: str = "200", provider: Optional[str] = None):
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol required")
    symbol = symbol.strip().upper()
    tf = timeframe.strip().lower()
    if tf not in SUPPORTED_TIMEFRAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {tf}")

    used_provider = None
    bars = None

    # Try Massive if configured
    if (provider is None or provider == "massive"):
        s = load_settings()
        api_key = s.get("massive_api_key", "")
        if api_key:
            try:
                multiplier = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 1, "2h": 2, "4h": 4, "1d": 1, "1wk": 1}[tf]
                timespan = {"1m": "minute", "5m": "minute", "15m": "minute", "30m": "minute", "1h": "hour", "2h": "hour", "4h": "hour", "1d": "day", "1wk": "week"}[tf]
                import time as _time
                to_date = _time.strftime("%Y-%m-%d", _time.gmtime())
                from_ts = _time.time() - int(period) * 86400 if period.isdigit() else _time.time() - 30 * 86400
                from_date = _time.strftime("%Y-%m-%d", _time.gmtime(from_ts))
                async with httpx.AsyncClient(timeout=15.0) as client:
                    r = await client.get(
                        f"https://api.massive.com/v2/aggs/ticker/{symbol}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
                        params={"adjusted": "true", "sort": "asc", "limit": "50000", "apiKey": api_key},
                    )
                if r.status_code == 200:
                    payload = r.json()
                    if payload.get("status") in ("OK", "DELAYED"):
                        results = payload.get("results") or []
                        bars = [{"ts": float(row.get("t", 0)) / 1000, "open": row["o"], "high": row["h"], "low": row["l"], "close": row["c"], "volume": row.get("v", 0)} for row in results if all(k in row for k in ("o", "h", "l", "c"))]
                        used_provider = "massive"
            except Exception:
                pass

    # Fallback to yfinance
    if bars is None and (provider is None or provider == "yahoo"):
        try:
            import yfinance as yf
            ticker = yf.Ticker(symbol)
            yf_interval = TF_INTERVAL_MAP.get(tf, "60m")
            yf_period_val = _yf_period(tf, period)
            df = ticker.history(period=yf_period_val, interval=yf_interval)
            if not df.empty:
                bars = []
                for idx, row in df.iterrows():
                    bars.append({"ts": int(idx.timestamp()), "open": float(row["Open"]), "high": float(row["High"]), "low": float(row["Low"]), "close": float(row["Close"]), "volume": float(row.get("Volume", 0))})
                bars.sort(key=lambda b: b["ts"])
                used_provider = "yahoo"
        except Exception:
            pass

    if not bars:
        raise HTTPException(status_code=404, detail=f"No data for {symbol}")

    return {"ok": True, "symbol": symbol, "timeframe": tf, "provider": used_provider, "bars": bars}
