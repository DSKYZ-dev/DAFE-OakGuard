"""
DAFE Charts — Self-contained backend server.
"""

from __future__ import annotations

import asyncio
import base64
import glob
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx

import model_manager as mm
import vault
import ml_engine as ml

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
logger = logging.getLogger("dafe")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="DAFE Charts", version="1.0.0")
# This backend has NO authentication on any endpoint (including destructive
# ones like /api/model/reload and /api/settings), so CORS is the only thing
# standing between "any website open in the user's browser" and full control
# of the local server. allow_origins=["*"] + allow_credentials=True used to
# let literally any webpage's JS fetch() this API directly — a classic
# browser-based CSRF/SSRF pivot against a localhost app. Restrict to the
# app's own origin (localhost/127.0.0.1, any port, since the dev server port
# can vary) plus RFC1918 private ranges, so the mobile PWA served from a LAN
# IP (e.g. http://192.168.1.50:5174) can reach this server too.
_LAN_IP = r"(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3})"
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=rf"^https?://((localhost|127\.0\.0\.1)|{_LAN_IP})(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Endpoints like /api/chat accept raw `dict[str, Any]` bodies with no size or
# schema validation — an oversized payload (huge messages array, deeply
# nested content) costs real memory/CPU to parse and forward. Reject
# anything absurdly large up front rather than relying on every handler to
# check for it.
_MAX_BODY_BYTES = 2 * 1024 * 1024  # 2MB — generous for chat history + docs, well under abuse territory

@app.middleware("http")
async def _limit_body_size(request, call_next):
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > _MAX_BODY_BYTES:
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=413, content={"ok": False, "detail": "Request body too large"})
        except ValueError:
            pass
    return await call_next(request)

# ---------------------------------------------------------------------------
# Settings (simple JSON file in the backend directory)
# ---------------------------------------------------------------------------
SETTINGS_FILE = os.path.join(os.path.dirname(__file__), "settings.json")
DEFAULTS: dict[str, Any] = {
    "massive_api_key": "", "serpapi_api_key": "",
    "llm_provider": "local", "ollama_base_url": "http://localhost:11434",
    "local_llm_base_url": "http://localhost:8081",
    "llm_trade_advisor_model": "auto",
    "llm_coder_provider": "local",
    "llm_coder_base_url": "http://localhost:8081",
    "llm_coder_model": "auto",
    "llm_provider_keys": {},
    "market_data_source": "yahoo",
    "data_provider_keys": {},
    "data_provider_cfg": {},
}

def _is_cloud_model_name(name: str) -> bool:
    """Ollama cloud tags follow the "*-cloud" / "*:cloud" naming convention
    (e.g. qwen3-coder:480b-cloud, gpt-oss:120b-cloud)."""
    n = (name or "").lower()
    return n.endswith("-cloud") or ":cloud" in n


# Ironclad Vault: the only three fields in settings.json sensitive enough to
# encrypt at rest — a broker password and two third-party API keys. Every
# other setting (provider choice, model name, ...) is not a secret.
_VAULT_FIELDS = ("massive_api_key", "serpapi_api_key", "tradovate_password")

# ── Hosted model providers ───────────────────────────────────────────────────
# Mirrors the mobile app's provider list, so the same key you added there works
# here. Keys are stored in settings.json through the same vault as the broker
# and market-data secrets, and every hosted completion is proxied by this
# backend: the browser never sees a key and provider CORS never blocks a call.
LLM_PROVIDERS: dict[str, dict[str, Any]] = {
    "meta": {
        "label": "Meta Model API (Muse Spark / Wonder)", "base_url": "https://api.meta.ai/v1", "auth": "bearer",
        "default_model": "muse-spark-1.3",
        "note": "Meta's own models via the Meta Model API — OpenAI-compatible. Get a key at dev.meta.ai (MODEL_API_KEY).",
        "doc": "dev.meta.ai",
    },
    "ollama": {
        "label": "Ollama (local daemon)", "base_url": "http://localhost:11434",
        "auth": "none", "default_model": "llama3",
        "note": "Models pulled onto this machine — configured by the Ollama URL below, no key needed.",
        "doc": "ollama.com",
    },
    "opencode": {
        "label": "OpenCode", "base_url": "https://api.opencode.ai/v1", "auth": "bearer",
        "default_model": "opencode/muse-spark-1.2-contributor-free",
        "note": "Coding models with a free tier — the mobile app's default.", "doc": "opencode.ai",
    },
    "openrouter": {
        "label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "auth": "bearer",
        "default_model": "meta-llama/llama-3.3-70b-instruct:free",
        "note": "Hundreds of models; free ones included.", "doc": "openrouter.ai/keys",
    },
    "openai": {
        "label": "OpenAI", "base_url": "https://api.openai.com/v1", "auth": "bearer",
        "default_model": "gpt-4o-mini", "note": "Direct OpenAI API.", "doc": "platform.openai.com/api-keys",
    },
    "anthropic": {
        "label": "Anthropic", "base_url": "https://api.anthropic.com/v1", "auth": "anthropic",
        "default_model": "claude-3-5-sonnet-latest", "note": "Native Messages API.", "doc": "console.anthropic.com",
    },
    "orcarouter": {
        "label": "OrcaRouter", "base_url": "https://api.orcarouter.ai/v1", "auth": "bearer",
        "default_model": "gpt-4o-mini", "note": "OpenAI-compatible router.", "doc": "orcarouter.ai",
    },
    "nvidia": {
        "label": "NVIDIA NIM", "base_url": "https://integrate.api.nvidia.com/v1", "auth": "bearer",
        "default_model": "openai/gpt-oss-20b",
        "note": "NVIDIA build.nvidia.com NIM endpoints — OpenAI-compatible, broad model catalogue.",
        "doc": "build.nvidia.com/settings/api-keys",
    },
    "custom": {
        "label": "Custom endpoint", "base_url": "", "auth": "bearer", "default_model": "",
        "note": "Any OpenAI-compatible endpoint — set its base URL and model.", "doc": "",
    },
}
HOSTED_PROVIDER_IDS = set(LLM_PROVIDERS) - {"ollama"}

# Live model catalogue, cached briefly per provider+base+key length so opening
# the settings panel does not hammer the provider on every render.
_llm_models_cache: dict[str, tuple[float, list[str]]] = {}


def _provider_record(pid: str, s: dict[str, Any]) -> dict[str, Any]:
    """Provider metadata merged with the saved key/base/model for that provider."""
    meta = dict(LLM_PROVIDERS.get(pid) or {})
    entry = (s.get("llm_provider_keys") or {}).get(pid) or {}
    meta.update({
        "id": pid,
        "base_url": (entry.get("base_url") or meta.get("base_url") or "").strip(),
        "api_key": entry.get("api_key", "") or "",
        "model": entry.get("model", "") or "",
    })
    return meta


async def _fetch_provider_models(pid: str, s: dict[str, Any], force: bool = False) -> dict[str, Any]:
    rec = _provider_record(pid, s)
    base = (rec.get("base_url") or "").rstrip("/")
    if not base:
        return {"ok": False, "error": "Set a base URL first.", "models": []}
    key = rec.get("api_key") or ""
    cache_key = f"{pid}|{base}|{len(key)}"
    if not force and cache_key in _llm_models_cache:
        ts, models = _llm_models_cache[cache_key]
        if time.time() - ts < 300:
            return {"ok": True, "models": models}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if rec.get("auth") == "anthropic":
                resp = await client.get(f"{base}/models", headers={
                    "x-api-key": key, "anthropic-version": "2023-06-01"})
            elif pid == "ollama":
                resp = await client.get(f"{base}/api/tags")
            else:
                headers = {"Authorization": f"Bearer {key}"} if key else {}
                resp = await client.get(f"{base}/models", headers=headers)
        if resp.status_code != 200:
            detail = ""
            try:
                payload = resp.json()
                detail = str(payload.get("error") or payload.get("message") or payload)[:200]
            except Exception:
                detail = (resp.text or "")[:200]
            return {"ok": False, "error": f"HTTP {resp.status_code}" + (f" — {detail}" if detail else ""), "models": []}
        data = resp.json()
        if pid == "ollama":
            models = [m.get("name") or m.get("model") for m in data.get("models", [])]
        else:
            models = [m.get("id") or m.get("name") for m in data.get("data", [])]
        models = [m for m in models if m]
        _llm_models_cache[cache_key] = (time.time(), models)
        return {"ok": True, "models": models}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200], "models": []}


async def _hosted_chat(
    rec: dict[str, Any], model: str, system: str,
    messages: list[dict[str, Any]], max_tokens: int, temperature: float,
) -> dict[str, Any]:
    """One completion against a hosted provider (OpenAI-compatible or Anthropic)."""
    base = (rec.get("base_url") or "").rstrip("/")
    key = rec.get("api_key") or ""
    label = rec.get("label") or rec.get("id")
    convo = [m for m in messages if m.get("role") in ("user", "assistant")]
    if not convo:
        convo = [{"role": "user", "content": ""}]
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            if rec.get("auth") == "anthropic":
                resp = await client.post(
                    f"{base}/messages",
                    headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                    json={
                        "model": model, "max_tokens": max_tokens, "temperature": temperature,
                        "system": system, "messages": convo,
                    },
                )
            else:
                headers: dict[str, str] = {}
                if key:
                    headers["Authorization"] = f"Bearer {key}"
                if rec.get("id") == "openrouter":
                    headers["HTTP-Referer"] = "https://dafecharts.app"
                    headers["X-Title"] = "DAFE Charts"
                resp = await client.post(
                    f"{base}/chat/completions",
                    headers=headers,
                    json={
                        "model": model, "stream": False, "max_tokens": max_tokens,
                        "temperature": temperature,
                        "messages": [{"role": "system", "content": system}] + convo,
                    },
                )
        if resp.status_code != 200:
            return {"ok": False, "detail": f"{label} returned {resp.status_code}: {(resp.text or '')[:300]}"}
        data = resp.json()
        if rec.get("auth") == "anthropic":
            reply = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        else:
            reply = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        reply = re.sub(r"</?think>", "", reply or "").strip()
        return {"ok": True, "reply": reply or "(empty response)"}
    except httpx.ConnectError:
        return {"ok": False, "detail": f"{label} is not reachable at {base}."}
    except httpx.TimeoutException:
        return {"ok": False, "detail": f"{label} timed out — try again."}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:300]}

def load_settings() -> dict[str, Any]:
    s = dict(DEFAULTS)
    needs_migration = False
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                s.update(json.load(f))
        except Exception:
            pass
    for field in _VAULT_FIELDS:
        raw = s.get(field, "")
        if raw and not vault.is_encrypted(raw):
            needs_migration = True
        s[field] = vault.decrypt(raw)
    # Migration: older versions had a single "ollama" provider covering both
    # the local daemon and its signed-in cloud models. If a saved model tag is
    # clearly a cloud tag, surface it as the explicit "ollama-cloud" provider
    # so the UI and routing treat it as cloud, not local.
    for prov_key, model_key in (("llm_provider", "llm_trade_advisor_model"),
                                ("llm_coder_provider", "llm_coder_model")):
        if s.get(prov_key) == "ollama" and _is_cloud_model_name(str(s.get(model_key, ""))):
            s[prov_key] = "ollama-cloud"
    # Hosted provider credentials live as ONE encrypted JSON blob: the vault
    # encrypts strings, and a dict of provider -> {api_key, base_url, model}
    # keeps the file tidy. A corrupt/unreadable blob degrades to "no keys"
    # rather than breaking every endpoint that reads settings.
    raw_keys = s.get("llm_provider_keys", "")
    if isinstance(raw_keys, str):
        try:
            s["llm_provider_keys"] = json.loads(vault.decrypt(raw_keys)) if raw_keys else {}
        except Exception:
            s["llm_provider_keys"] = {}
    elif not isinstance(raw_keys, dict):
        s["llm_provider_keys"] = {}
    raw_dkeys = s.get("data_provider_keys", "")
    if isinstance(raw_dkeys, str):
        try:
            s["data_provider_keys"] = json.loads(vault.decrypt(raw_dkeys)) if raw_dkeys else {}
        except Exception:
            s["data_provider_keys"] = {}
    elif not isinstance(raw_dkeys, dict):
        s["data_provider_keys"] = {}
    if not isinstance(s.get("data_provider_cfg"), dict):
        s["data_provider_cfg"] = {}
    if needs_migration:
        # A pre-vault settings.json had one or more of these fields in
        # cleartext — encrypt them on disk immediately rather than waiting
        # for the user to next hit "Save" on the settings panel, which they
        # may never do if nothing else needs changing.
        try:
            save_settings(s)
        except Exception:
            pass
    return s

def save_settings(data: dict[str, Any]) -> None:
    # Encrypt a COPY for the on-disk write — callers (api_save_settings) keep
    # using their own `data` dict as plaintext afterward, e.g. to build the
    # masked API response, and must not see it silently turn into ciphertext
    # out from under them.
    to_write = dict(data)
    for field in _VAULT_FIELDS:
        to_write[field] = vault.encrypt(to_write.get(field, "") or "")
    keys_store = data.get("llm_provider_keys") or {}
    to_write["llm_provider_keys"] = vault.encrypt(json.dumps(keys_store)) if keys_store else ""
    dkeys_store = data.get("data_provider_keys") or {}
    to_write["data_provider_keys"] = vault.encrypt(json.dumps(dkeys_store)) if dkeys_store else ""
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(to_write, f, indent=2)

def mask_key(k: str) -> str:
    # Long secrets: show first/last 4 with the middle starred. Short but
    # non-empty secrets must NOT be returned verbatim (a prior latent leak —
    # a <8-char password would ride back in cleartext); return a fixed-width
    # all-star mask so neither the content nor the exact length is disclosed,
    # while still containing '*' so the save-guard treats it as "unchanged".
    if not k:
        return ""
    if len(k) >= 8:
        return k[:4] + "*" * (len(k) - 8) + k[-4:]
    return "*" * 8


def _collapse_repetition(text: str) -> str:
    """Salvage a degenerate repetition loop (a line or short phrase repeated
    many times) that aggressively-quantized models occasionally emit. Keeps the
    coherent head and drops the runaway tail."""
    if not text or len(text) < 60:
        return text
    # 1) A line repeated 3+ times in a row -> cut at the loop.
    out: list[str] = []
    prev = None
    repeat = 0
    for ln in text.split("\n"):
        norm = ln.strip()
        if norm and norm == prev:
            repeat += 1
            if repeat >= 3:
                break
        else:
            repeat = 0
        out.append(ln)
        prev = norm
    collapsed = "\n".join(out)
    # 2) A short phrase repeated inline 6+ times (e.g. "L=50, L=50, L=50, ...").
    m = re.search(r"(.{2,40}?)(?:\1\s*){5,}", collapsed, re.DOTALL)
    if m:
        collapsed = (collapsed[:m.start()] + m.group(1)).rstrip()
    return collapsed.strip()

# ---------------------------------------------------------------------------
# Request-reduction cache (TTL + in-flight de-duplication)
#
# The whole point: hit PAID providers as rarely as possible. A TF bar only
# changes once per period and a quote only matters every few seconds, so we
# serve repeats from cache and collapse concurrent identical fetches into one
# upstream call. This is what makes the hybrid / single-paid-stream mode cheap.
# ---------------------------------------------------------------------------
_cache: dict[str, tuple[float, Any]] = {}
_cache_locks: dict[str, asyncio.Lock] = {}
_cache_stats = {"hits": 0, "misses": 0, "upstream": 0}

def _cache_get(key: str, ttl: float) -> Optional[Any]:
    e = _cache.get(key)
    if e and (time.time() - e[0]) < ttl:
        _cache_stats["hits"] += 1
        return e[1]
    return None

def _cache_set(key: str, value: Any) -> None:
    _cache[key] = (time.time(), value)
    # Keep the cache bounded.
    if len(_cache) > 512:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:128]:
            _cache.pop(k, None)

def _cache_lock(key: str) -> asyncio.Lock:
    lock = _cache_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _cache_locks[key] = lock
    return lock

@app.get("/api/cache/stats")
def api_cache_stats():
    total = _cache_stats["hits"] + _cache_stats["misses"]
    ratio = (_cache_stats["hits"] / total) if total else 0.0
    return {"ok": True, **_cache_stats, "entries": len(_cache),
            "hit_ratio": round(ratio, 3),
            "upstream_saved": _cache_stats["hits"]}

# ---------------------------------------------------------------------------
# Health / ping
# ---------------------------------------------------------------------------
@app.get("/api/ping")
def ping():
    return {"ok": True}

# ─── Running model state (for status queries) ─────────────────────────
LLAMA_PORT = int(os.environ.get("LLAMA_PORT", "8081"))
_running_model: dict[str, Any] = {"model_name": "", "ctx": 0, "port": LLAMA_PORT, "loaded": False, "pid": None, "supports_thinking": False}


def _adopt_running_model() -> bool:
    """
    If a llama-server is already alive (e.g. started by start.bat) but the
    backend doesn't know about it yet, probe it for the real model + context
    size and adopt it. Keeps status/chat accurate without a manual reload.
    """
    global _running_model
    if _running_model.get("loaded"):
        return True
    probe = mm.probe_running(_running_model.get("port", LLAMA_PORT))
    if probe:
        _running_model = {
            "model_name": probe["model_name"] or _running_model.get("model_name", ""),
            "ctx": probe["ctx"] or _running_model.get("ctx", 0),
            "port": probe["port"],
            "loaded": True,
            # PID unknown for an externally-launched server; kill falls back to
            # command-line + image-name matching.
            "pid": _running_model.get("pid"),
            "supports_thinking": probe.get("supports_thinking", False),
        }
        return True
    return False

# ---------------------------------------------------------------------------
# Model status — returns real context + current port for dynamic frontend
# ---------------------------------------------------------------------------
@app.get("/api/model/status")
def api_model_status():
    """Return current model info including real context size and active port."""
    global _running_model
    # Adopt any externally-launched server first.
    if not _running_model.get("loaded"):
        _adopt_running_model()
    if _running_model["loaded"]:
        probe = mm.probe_running(_running_model["port"])
        if probe:
            # Trust the live server's real context size.
            if probe["ctx"]:
                _running_model["ctx"] = probe["ctx"]
            if probe["model_name"]:
                _running_model["model_name"] = probe["model_name"]
            _running_model["supports_thinking"] = probe.get("supports_thinking", False)
            return {"ok": True, "model": _running_model["model_name"], "ctx": _running_model["ctx"], "port": _running_model["port"], "running": True}
        _running_model["loaded"] = False
    # Model not running or not probeable — return the COMPUTED context so the
    # frontend can size prompts correctly even before the server is ready.
    computed_ctx = _running_model.get("ctx", 0)
    if not computed_ctx:
        try:
            plan = mm.plan_for(MODELS_DIR, load_settings().get("llm_trade_advisor_model", "auto"))
            if plan:
                computed_ctx = plan["params"]["ctx"]
                _running_model["model_name"] = plan["model"]["name"]
                _running_model["ctx"] = computed_ctx
        except Exception:
            pass
    return {"ok": True, "model": _running_model.get("model_name", ""), "ctx": computed_ctx, "port": _running_model.get("port", LLAMA_PORT), "running": False}

# ---------------------------------------------------------------------------
# Model hot-swap: start new on next port, kill old, seamless handoff
# ---------------------------------------------------------------------------
@app.post("/api/model/reload")
def api_model_reload(body: dict[str, Any] = {}):
    """Start selected model on a new port, then kill the old one."""
    global _running_model
    settings = load_settings()
    requested = body.get("model", "") or settings.get("llm_trade_advisor_model", "auto")
    old_port = _running_model.get("port", LLAMA_PORT)
    models_dir = mm.DEFAULT_MODELS_DIR

    # Resolve model file via the shared manager (preference-aware + best-fit).
    model = mm.pick_model(models_dir, requested)
    if not model:
        return {"ok": False, "detail": "No .gguf models found in " + models_dir}
    model_name = model["name"]
    model_path = model["path"]
    if not os.path.exists(model_path):
        return {"ok": False, "detail": f"Model file missing: {model_path}"}

    # Compute adaptive launch params for THIS model on THIS machine.
    hw = mm.detect_hardware()
    params = mm.compute_launch_params(model, hw)
    ctx = str(params["ctx"])
    ngl = str(params["ngl"])
    batch = str(params["batch"])
    threads = str(params["threads"])

    # Find llama-server
    llama_exe = mm.find_llama_server()
    if not llama_exe:
        return {"ok": False, "detail": "llama-server executable not found (set LLAMA_DIR)"}
    llama_dir = os.path.dirname(llama_exe)

    import time as _time

    # Adopt any externally-launched server (e.g. from start.bat) so we kill it.
    if not _running_model.get("loaded"):
        _adopt_running_model()

    # Step 1: Kill old model FIRST to free VRAM (8GB can't hold two models).
    # Robustly removes the old console window too (start.bat cmd wrapper and the
    # hot-reload console, tracked by PID). 3s lets GPU memory fully release.
    old_pid = _running_model.get("pid")
    if _running_model["loaded"] or old_pid:
        mm.kill_llama_server(port=old_port, pid=old_pid, wait_release=3.0)
    _running_model = {"model_name": "", "ctx": 0, "port": old_port, "loaded": False, "pid": None}

    # Step 2: Start new model (VRAM is now free) with adaptive params
    cmd = [llama_exe, "-m", model_path, "--port", str(old_port), "--host", "127.0.0.1",
           "-c", ctx, "-ngl", ngl, "-b", batch, "-t", threads]
    logger.info("Starting %s on port %s [%s]: %s",
                model_name, old_port, params["reason"], " ".join(cmd))

    try:
        proc = subprocess.Popen(cmd, cwd=llama_dir,
                                creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == 'nt' else 0)
    except Exception as e:
        return {"ok": False, "detail": f"Failed to start: {e}"}

    # Track the new PID immediately so a later reload can kill it cleanly even
    # if this one times out.
    _running_model = {"model_name": model_name, "ctx": int(ctx), "port": old_port,
                      "loaded": False, "pid": proc.pid}

    # Step 3: Wait for readiness. Large models (esp. partially offloaded ones at
    # ~6 t/s) can take a couple of minutes — poll up to MODEL_LOAD_TIMEOUT and
    # treat HTTP 503 ("loading model") as progress, not failure.
    load_timeout = int(os.environ.get("DAFE_MODEL_LOAD_TIMEOUT", "240"))
    deadline = _time.monotonic() + load_timeout
    ready = False
    while _time.monotonic() < deadline:
        _time.sleep(2)
        if proc.poll() is not None:
            _running_model = {"model_name": "", "ctx": 0, "port": old_port, "loaded": False, "pid": None}
            return {"ok": False, "detail": f"Model process died (exit code {proc.returncode}). Check the llama window for errors."}
        if mm.server_health(old_port) == "ready":
            ready = True
            break

    if not ready:
        # Do NOT kill it — it may simply be loading slowly and will become
        # usable shortly. The status endpoint will adopt it once /health is ok.
        return {"ok": False, "loading": True, "model": model_name, "port": old_port,
                "detail": (f"{model_name} is still loading after {load_timeout}s — "
                           "it should become available shortly (raise "
                           "DAFE_MODEL_LOAD_TIMEOUT for very large models).")}

    # Step 4: Handoff complete — adopt the live server's real ctx if available
    real_ctx = int(ctx)
    supports_thinking = False
    probe = mm.probe_running(old_port)
    if probe:
        if probe["ctx"]:
            real_ctx = probe["ctx"]
        supports_thinking = probe.get("supports_thinking", False)
    _running_model = {"model_name": model_name, "ctx": real_ctx, "port": old_port,
                      "loaded": True, "pid": proc.pid, "supports_thinking": supports_thinking}

    return {"ok": True, "model": model_name, "ctx": real_ctx, "port": old_port,
            "ngl": params["ngl"], "mode": params["mode"], "detail": params["reason"]}

# ---------------------------------------------------------------------------
# Model discovery & hardware detection
# ---------------------------------------------------------------------------
MODELS_DIR = mm.DEFAULT_MODELS_DIR

@app.get("/api/models")
def api_models():
    """Scan for .gguf files and return each with its adaptive launch plan."""
    hw = mm.detect_hardware()
    models = []
    for m in mm.list_models(MODELS_DIR):
        params = mm.compute_launch_params(m, hw)
        models.append({
            "name": m["name"],
            "size": m["size"],
            "size_gb": m["size_gb"],
            "path": m["path"],
            "arch": m["arch"],
            "quant": m["quant"],
            "train_ctx": m["train_ctx"],
            "recommended": params,  # {ctx, ngl, batch, threads, mode, reason}
        })
    return {"ok": True, "models": models, "models_dir": MODELS_DIR}

@app.get("/api/ollama/models")
async def api_ollama_models():
    """List models available in the Ollama daemon — both local tags and cloud
    models (e.g. qwen3-coder:480b-cloud). Chat-capable only (embedders excluded).
    This is what populates the Ollama model dropdowns in the Settings UI so a
    user can pick from whatever they have installed / signed in for."""
    settings = load_settings()
    base_url = settings.get("ollama_base_url", "http://localhost:11434")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/api/tags")
        if resp.status_code != 200:
            return {"ok": False, "detail": f"Ollama returned {resp.status_code}", "models": [], "base_url": base_url, "running": False}
        data = resp.json()
        models = []
        for m in data.get("models", []):
            caps = m.get("capabilities", []) or []
            # Skip embedding-only models — not usable for chat/completions.
            if caps and "completion" not in caps and "chat" not in caps:
                continue
            details = m.get("details", {}) or {}
            name = m.get("model") or m.get("name", "")
            # Some Ollama versions don't report remote_host in /api/tags, so
            # also recognize cloud models by their "*-cloud" tag convention —
            # otherwise cloud models get mislabeled (and filtered) as local.
            remote = bool(m.get("remote_host")) or _is_cloud_model_name(name)
            size_bytes = m.get("size", 0) or 0
            models.append({
                "name": name,
                "size": size_bytes,
                "size_gb": round(size_bytes / (1024 ** 3), 2),
                "parameter_size": details.get("parameter_size", ""),
                "quantization": details.get("quantization_level", ""),
                "context_length": details.get("context_length", 0) or 0,
                "family": details.get("family", ""),
                "capabilities": caps,
                "cloud": remote,
                "remote": remote,
            })
        models.sort(key=lambda x: x["name"].lower())
        return {"ok": True, "models": models, "base_url": base_url, "running": True}
    except httpx.ConnectError:
        return {"ok": False, "detail": f"Ollama not reachable at {base_url} — start the Ollama app or run `ollama serve`.", "models": [], "base_url": base_url, "running": False}
    except Exception as e:
        return {"ok": False, "detail": str(e), "models": [], "base_url": base_url, "running": False}

@app.get("/api/hardware")
def api_hardware():
    """Detect available hardware and suggest an optimal context size."""
    info = mm.detect_hardware()
    # Suggested ctx for the currently-best-fit model (what start.bat would pick).
    plan = mm.plan_for(MODELS_DIR, load_settings().get("llm_trade_advisor_model", "auto"))
    info["suggested_ctx"] = plan["params"]["ctx"] if plan else (
        32768 if info.get("vram_mb", 0) >= 16000 else
        16384 if info.get("vram_mb", 0) >= 8000 else
        8192 if info.get("ram_gb", 0) >= 16 else
        4096 if info.get("ram_gb", 0) >= 8 else 2048
    )
    return {"ok": True, "hardware": info}

# ---------------------------------------------------------------------------
# OakScript Knowledge Base — dynamic documentation retrieval
# ---------------------------------------------------------------------------
from oak_kb import (
    search as oak_search, get_function as oak_get_function,
    get_section as oak_get_section, retrieve as oak_retrieve,
)

@app.get("/api/oak/search")
def api_oak_search(q: str = ""):
    """Search OakScript docs by query string. Returns relevant sections/functions/examples."""
    q = (q or "").strip()
    if not q:
        return {"ok": False, "detail": "Missing query parameter 'q'"}
    return {"ok": True, "query": q, "results": oak_search(q, max_results=6)}

@app.get("/api/oak/retrieve")
def api_oak_retrieve(q: str = "", budget: int = 2200):
    """Budget-bounded retrieval bundle — the token-efficient doc tool for the coder."""
    q = (q or "").strip()
    if not q:
        return {"ok": False, "detail": "Missing query parameter 'q'"}
    return oak_retrieve(q, budget_chars=max(400, min(int(budget), 6000)))

@app.get("/api/oak/function")
def api_oak_function(name: str = ""):
    """Get OakScript function signature and description by name."""
    name = (name or "").strip()
    if not name:
        return {"ok": False, "detail": "Missing query parameter 'name'"}
    fn = oak_get_function(name)
    if not fn:
        return {"ok": False, "detail": f"Function '{name}' not found"}
    return {"ok": True, "function": fn}

@app.get("/api/oak/section")
def api_oak_section(title: str = ""):
    """Get full OakScript documentation section by title."""
    title = (title or "").strip()
    if not title:
        return {"ok": False, "detail": "Missing query parameter 'title'"}
    sec = oak_get_section(title)
    if not sec:
        return {"ok": False, "detail": f"Section '{title}' not found"}
    return {"ok": True, "section": sec}

# ---------------------------------------------------------------------------
# Chat — proxy to llama.cpp /v1/chat/completions
# ---------------------------------------------------------------------------
AGENT_SYSTEM_PROMPTS = {
    "trade_advisor": (
        "You are the DAFE Trade Advisor, a helpful trading assistant. "
        "Your name is 'Trade Advisor'. When introducing yourself, say: "
        "'Hi there, I'm your Trade Advisor and assistant. How can I help you today?' "
        "You specialize in chart analysis, Signal Analysis Model tuning, market research, and risk assessment. DAFE calls its scripts Signal Analysis Models (never 'indicators' or 'strategies' — one model both draws on the chart and drives backtests/automation through its signals); use that terminology. "
        "Analyze OHLCV data, identify patterns, support/resistance levels, and candlestick formations. "
        "Be concise, data-driven, and use proper trading terminology."
    ),
    "oakscript_coder": (
        "3D RENDERER — REAL AND BUILT IN. NEVER tell the user OakScript cannot do 3D. "
        "plot3d(series, name, style, color, pane, z_level?) with 15 styles: surface/ribbon/scatter/bars3d/wireframe/mesh/line3d/helix/vortex/manifold/nebula/constellation/torus/trail/ridgeline. "
        "plotshape_3d(bar_index, price, title, shape, color, size, z_level?, pane?, rx?, ry?, rz?) — shapes cube/sphere/pyramid/torus/diamond/coneup/conedown. "
        "label3d(bar_index, price, text, color?, size?, z_level?, pane?) — billboard text. "
        "pane=\"3d\" is a full-chart takeover where 2D plot()/plotshape() do NOT render; pair every plotshape_3d/label3d with a plot3d() using the EXACT SAME pane string. "
        "Price levels (fibs, pivots) in 3D use style \"line3d\" with a DISTINCT z_level per level. "
        "You are the DAFE OakScript Coder, an expert at OakScript — the language for DAFE's Signal Analysis Models. Call scripts 'Signal Analysis Models' (or 'models'), never 'indicators' or 'strategies': one model plots on the chart AND drives backtests/paper automation through its signals (plotted Buy/Sell markers and/or model.* execution calls — model.entry/model.longEntry/model.shortEntry/model.exit/model.longExit/model.shortExit/model.confidence/model.stopLoss/model.takeProfit is the current API; strategy.entry/strategy.exit are legacy aliases kept for old scripts, do not use them in new ones). "
        "OakScript is NOT PineScript — never use: ta./math./str. namespaces (functions are bare: rsi(), sma(), abs()); "
        "input.int/input.float (use input(default, \"Title\", min?, max?, step?)); named arguments (ALL arguments are positional); "
        "indicator()/study()/strategy() declarations (scripts start directly with code); shape.*/location.*/plot.style_* constants; "
        "color.red-style constants (colors are quoted hex strings like \"#22cc88\"); nz()/na() do not exist; request.security() is PineScript — OakScript's equivalent is the bare security(timeframe, source). "
        "ALWAYS structure every script in this exact order: "
        "(1) input() declarations. "
        "(2) Model calculations — plain assignments (NO var keyword), recomputed every bar: fastMa = ema(close, 9). Every variable must be assigned BEFORE the line that uses it; an undefined name silently reads as 0/false with NO error. "
        "(3) Persistent state ONLY: var x = 0.0 with a LITERAL initial value, updated inside logic with :=. CRITICAL: a var initializer runs ONCE on bar 0 and the value persists — `var lvl = highest(high, 20)` FREEZES at the first bar forever. NEVER put calculations, conditions, or series expressions in a var initializer. "
        "(4) Signal conditions as plain booleans: buySig = crossover(fastMa, slowMa) and r < 70. "
        "(5) Signal markers INSIDE conditionals: if buySig { plotshape(bar_index, low, \"Buy\", \"triangleup\", \"#22cc88\") } / if sellSig { plotshape(bar_index, high, \"Sell\", \"triangledown\", \"#ff4477\") } — signature plotshape(bar_index, price, title, style, color, pane?), buy markers at low, sell markers at high. "
        "(6) Unconditional rendering LAST at top level: plot()/hline()/fill()/plot3d() must NEVER be inside if-blocks or they render nothing (bgcolor is the exception — it may be conditional). "
        "DYNAMIC price levels (fibs, pivots, moving S/R) = plot(level, \"Title\", \"#hex\", 1, \"stepline\") so the line follows the level; hline() is ONLY for constants that never change (RSI 70/30) — an hline whose value changes leaves a new permanent line each time. hline(price, color?, pane?) is 3 args MAX — not Pine's hline(price, title, color, linestyle, linewidth); there is no title/linestyle/linewidth slot. "
        "Previous-bar access works via history indexing: close[1], myVar[1]; change(x) = x - x[1]. "
        "Output COMPLETE oakscript code inside ```oakscript fences — every line, start to finish, never partial or truncated. "
        "When EDITING an existing script, preserve ALL its logic, calculations, variables, loops, and signals; only add or modify what was asked. NEVER simplify, summarize, remove, or rename existing logic. "
        "Block syntax: use { } braces around multi-statement bodies under if/else/for/while (single statements may follow without braces) — braces have no indentation requirement and can't misparse. Brace-less indentation blocks also work, but every statement in such a block must sit at the exact same column or it silently falls outside the block (e.g. a loop counter update landing outside its own while loop causes an infinite loop) — prefer braces for anything beyond a single-line body. "
        "== not =. Strings quoted: \"#22cc88\" not green. MACD: m.macd/m.signal/m.hist. Use input() for params. "
        "The engine has a full 3D renderer: plot3d(series, name, style, color, pane, z_level?) with 15 styles: surface/ribbon/scatter/bars3d/wireframe/mesh/line3d/helix/vortex/manifold/nebula/constellation/torus/trail/ridgeline (ridgeline = temporal distribution joyplot: the series is sliced into time windows and each window's value histogram stacks in depth — ideal for price/volume profiles over time; needs 24+ bars). z_level (number) stacks multiple plot3d calls at different depths — same value = same Z layer, different values = spaced apart (2.4 units). Omit for auto-spacing. "
        "pane=\"3d\" is the flagship mode: an exclusive full-chart takeover where the geometry renders unified WITH the 3D price bars (orbit camera to rotate/zoom) — while it's active, NO 2D plots or separate-pane 3D render from any model, and only one pane=\"3d\" model can be active at a time. "
        "pane=\"separate\" renders in the lower 3D pane instead (multiple calls stack together there; also exclusive, one at a time). Default/pane=\"main\" is a lighter legacy overlay mode — prefer pane=\"3d\" or pane=\"separate\" explicitly. "
        "CRITICAL 3D RULE: When the chart pane is in 3D mode, 2D plot() and plotshape() do NOT render — only plot3d() and plotshape_3d() execute. plotshape_3d(bar_index, price, title, shape, color, size, z_level?, pane?, rx?, ry?, rz?) places geometric shapes at exact bar/price/Z coordinates. pane=\"separate\" (default) renders in lower 3D pane; pane=\"3d\" renders in main 3D chart scene alongside the 3D bars. Shapes: cube, sphere, pyramid, torus, diamond, coneup, conedown. Size: 0.2-3.0. STANDARD SIGNAL MARKERS: buy = \"coneup\" green (#22cc88) at low (auto-offsets BELOW the bar, tip pointing up at it); sell = \"conedown\" red (#ff4477) at high (flipped upside down, auto-offsets ABOVE the bar, tip pointing down). Derive size from signal strength (e.g. spread/ATR clamped to 0.6-2.2) so cones are proportional to signal quality. rx/ry/rz (optional, DEGREES) rotate any shape on top of its built-in orientation for custom scenes. PANE MATCHING: in a pane=\"3d\" script, EVERY plotshape_3d/label3d must pass \"3d\" as its pane argument — omitting it defaults the marker to the (hidden) separate pane and it renders nowhere. "
        "label3d(bar_index, price, text, color?, size?, z_level?, pane?) places a billboard TEXT label at exact 3D coordinates — use it to NAME peaks, levels, zones, and signals (\"POC\", \"Breakout\"). Keep text short and use it for RARE, meaningful moments only — never label every signal bar (dense repeats stack into unreadable towers); the cones already mark the signals, a label should call out at most the standout events. "
        "Price LEVELS in 3D (fibs, pivots, S/R): use style \"line3d\" — it draws exact straight segments. NEVER render a level series with \"ribbon\"/\"surface\": their spline smoothing turns the steps into spike blades that look nothing like level lines. Give EACH level line a DISTINCT z_level (0, 1, 2, …) so they render as cleanly separated parallel planes — putting multiple level lines on the SAME z_level overlaps them into a twisted rope. "
        "MANDATORY: Whenever you use plotshape_3d() or label3d(), you MUST ALSO include at least one plot3d() call (surface/ribbon/bars3d/etc.) using the EXACT SAME pane string — not just 'a' plot3d, the SAME pane value. If your plotshape_3d/label3d pass \"3d\", every accompanying plot3d must also pass \"3d\" (never \"separate\"); if they pass \"separate\", every accompanying plot3d must also pass \"separate\" (never \"3d\"). Mixing panes puts the shapes and the geometry in two different, mutually-exclusive scenes — one of them silently renders nowhere, which is exactly the kind of bug that looks fine in review and is broken on screen. "
        "Give each plot3d call a genuinely DIFFERENT source value — reusing the same number under 2-3 style names is a wasted opportunity; look for other already-computed values in the script (a stdev, a count, a raw vs. smoothed version, a margin) so each 3D layer answers a different question. "
        "VISUAL FOCUS (this outranks every other visual instruction): render ONLY what the request needs. Maximum 2-3 plot3d layers per script, and EVERY visual element — each plot3d, plotshape_3d, label3d — must trace directly back to something the user asked for. NO decorative extras, NO bonus derivative layers, NO piling on styles to show off. One excellent, readable visual beats five cluttered ones. A request for \"an RSI model that signals extremes\" needs the RSI and its extreme signals — not velocity, acceleration, jerk, and a vortex. "
        "When EDITING an existing script, do NOT add any new visual the user did not ask for in THIS request; when the user asks to remove or simplify visuals, removing them IS the task. "
        "EXEMPLAR PATTERNS (mirror the built-in library): session highs/lows + divergence -> \"Session High/Low Divergence\" (highest/lowest extremes, deviation-in-range, stepline levels, band fill); 3D price levels -> \"Fibonacci Levels 3D\" (line3d per level at DISTINCT z_levels, cones paired pane=\"3d\"); trailing stops -> \"ATR Trailing Stops\" (var state machine, warmup guard bar_index > atrLen before any ATR comparison, ratcheting stops); DASHBOARD FLAGSHIP -> \"CCI Manifold Sheet\" (gradient manifold terrain + deviation sheath in the SEPARATE pane, signals as 2D plotshape on the MAIN chart at low/high - never only as 3D cones - plus cooldown-gated cones in the same pane, bgcolor zone tints). PANE LAW: oscillator series (RSI/CCI/MACD/Stoch/MFI/ADX) NEVER use pane=\"3d\" - inside the price scene they render as a spiky forest over the candles; use pane=\"separate\". pane=\"3d\" is only for price-denominated series. DASHBOARD LAW: do NOT build table.new dashboards by default - the app already renders a metrics Dashboard for every script; only add table.new when the user explicitly asks for an on-chart TABLE. mini 3D studies -> primary geometry + ONE distinct smoothed second layer at z_level 1 + zone-gated plotshape_3d cones in the SAME pane + main-chart plotshape signals + a 2D twin line. Signal conditions must be zone/state-gated, never raw price-field crosses. "
        "When emitting 3D cone signals, expose markerSize = input(1.0, \"Marker Size\", 0.2, 3.0, 0.1) and multiply the cone size by it so users can tune marker scale. "
        "Before finishing, double-check every variable name against its actual input()/declaration — a typo silently reads as 0/false with no error. "
        "SELF-REVIEW BEFORE OUTPUT: Silently verify (1) mathematical accuracy — is every calculation, crossover, threshold, and indicator relationship correct? (2) visual focus — does every plot/shape/label trace back to the user's request? Remove anything they didn't ask for. If either check fails, fix it before answering. "
        "DRAWING TOOLKIT (new builtins): line.new(x1,y1,x2,y2,color?,width?,style?,extend?,id?) and line.delete(id); box.new(left,top,right,bottom,borderColor?,bgColor?,width?,id?) and box.delete(id); circle.new(x1,y1,x2,y2,color?,bgColor?,width?,id?) (bounding box); arrow.new(x1,y1,x2,y2,color?,width?,id?); polyline.new(points,color?,width?,closed?,id?) where points is an array of [bar_index,price] pairs; linefill.new(lineId1,lineId2,color) fills the band between two line.new ids you already created; table.new(position,columns,rows,bgColor?,id?) returns a handle and table.cell(handle,col,row,text,bgColor?,textColor?) fills a cell (position: top_left/top_right/top_center/middle_left/middle_center/middle_right/bottom_left/bottom_right/bottom_center); barcolor(color,pane?) recolors the current bar's candle; fibretracement.new(x1,y1,x2,y2,levels?,colorUp?,colorDown?,id?) and gannfan.new(x1,y1,angleUnit?,color?,id?) draw analyst overlays as real line objects; text.new(x,y,text,color?,size?,id?) is unboxed label sugar and label.new(x,y,text,color?,size?,boxed?,align?) is the boxed form. "
        "OBJECT ID IDIOM: line.new/box.new/polyline.new/circle.new/arrow.new/table.new/image.new all accept a trailing id argument — pass the SAME literal id string across multiple bars to UPDATE that one object in place (a moving trendline, a growing zone) instead of stacking a new object every bar; omit the id to create a fresh object on every firing (e.g. one marker per pivot) — omitted-id objects are auto-capped on a rolling basis so they can never leak without bound. "
        "IMAGES: image.new(x,y,source,width?,height?,anchor?,opacity?,rotation?,id?) places a 2D image, plotimage(bar_index,price,source,width?,height?,pane?,id?) is a per-bar signal-marker form, and plotimage_3d(bar_index,price,source,size?,z_level?,pane?,rx?,ry?,rz?) is the 3D billboard form; source is EITHER an inline data:image/png;base64,... or data:image/jpeg;base64,... string OR the exact name of an asset the user already saved via the editor's Images panel — never invent an asset name you were not given. "
        "COORDINATES: on every drawing builtin, x/x1/x2 mean bar_index and y/y1/y2 mean price, but width/height on image.new and width/height/size on plotimage/plotimage_3d are PIXELS (screen-space), not price units — do not scale them like a price value. "
        "regression.channel(source,length,mult?) returns {mid,upper,lower} per bar as a CALCULATION ONLY — it does not draw anything by itself; the script must plot all three series itself (three plot() calls) and use fill() between upper and lower for the shaded channel, the same recipe pattern as the existing linreg/stdev usage. "
        "CAPABILITY MINDSET: You now have a full drawing toolkit — lines, boxes, polylines, circles, arrows, tables/dashboards, text/labels, fills between lines, fibonacci/gann overlays, and image import (inline or a saved asset by name), in both 2D and 3D. When a request has no single dedicated builtin (a supply/demand zone, a custom diagram, a labeled channel), DECOMPOSE it into these primitives instead of saying it isn't possible — e.g. 'mark a supply zone' = box.new anchored to the swing high/low; 'label the golden pocket' = fibretracement.new; 'put my logo in the corner' = image.new with a saved asset name. This does NOT relax VISUAL FOCUS: decomposing into primitives still means using the FEWEST objects that faithfully render exactly what was asked — never add drawing calls beyond what the request needs. "
        "MODEL EXECUTION (Time Machine backtest + live paper auto-trader): model.entry(direction, id?, qty?) / model.longEntry(id?, qty?) / model.shortEntry(id?, qty?) open a position; model.exit(id?) closes whichever side is open, model.longExit(id?)/model.shortExit(id?) close ONLY if that side is currently open (no-op otherwise); model.confidence(0-1) attaches a sticky metadata score to subsequent entries (never a size multiplier); model.stopLoss(value, mode?) / model.takeProfit(value, mode?) attach a sticky per-entry bracket (mode \"pct\" default or \"abs\" $), overriding the backtest form's SL/TP for that entry. These are order-EVENT builtins — they render nothing and have zero effect unless the backtest panel or the live auto-trader is actually running. The broker tracks ONE position per symbol: an entry is a no-op if already in a position (no pyramiding/adding), and exit(s) always close the WHOLE matching position (no partial exits). Exactly like plotshape, an unconditional top-level call fires every bar — always wrap in a signal condition. strategy.entry/strategy.exit still work as legacy aliases (identical to model.entry/model.exit, no direction-conditional exit or confidence/bracket calls) — use model.* in new scripts, not strategy.*. Only reach for model.*/strategy.* when the user explicitly asks to backtest, test a strategy, or make something auto-tradable; a plain 'give me a buy/sell signal' request should still use plotshape markers, not these. Once a bracket is live, stop-loss/take-profit/trailing are checked intrabar against each bar's full high/low range (not just open/close) with gap-through pricing — signal-driven entries/exits still fill next-bar-open, that's the no-lookahead rule, not a fill-precision limit. "
        "ML / RL (train in the 🧠 ML Lab panel, next to Backtest/Optimize — you cannot train one yourself, never invent a model/policy id): ml.predict(modelId) returns a trained ML model's prediction for this bar — 0-1 probability for a direction model, a raw predicted return for a regression model — neutral 0.5 until resolved; models are classical (gradient boosting / a real 2-hidden-layer neural net / logistic regression via scikit-learn) or deep (an LSTM via PyTorch, seeing a sliding window of recent bars instead of just the current one) on standard technical features, chronologically split train/validate (never shuffled), reported against an honest baseline (majority-class accuracy or zero-change MAE). rl.action(policyId) returns -1/0/1 (short/flat/long) — the greedy action of a trained policy, neutral 0 until resolved; genuine reinforcement learning either way (reward = mark-to-market P&L, no labeled targets) — a from-scratch tabular Q-learning policy (classical, fixed 625-state table) or a Deep Q-Network (deep, PyTorch, continuous state with no table to size) — validated against 'always long'/'always flat' baselines with a visible episode-reward learning curve. The deep (LSTM/DQN) options need PyTorch installed on the backend and use a GPU automatically when present, CPU otherwise (ML Lab shows a device badge); classical options always work and are a legitimate fast choice, not just a fallback. If the user wants one of these in a script, tell them to train it in ML Lab first and give you the id, or write the script with a placeholder id they'll swap in. "
        "MULTI-TIMEFRAME: security(timeframe, source) — bare, not dotted — returns the last CONFIRMED (fully closed) higher-timeframe value of source, aggregated from bars already loaded (no new fetch, no symbol argument). NEVER the still-forming bucket — it returns NaN until the first bucket closes, then holds flat until the next one closes, so it never repaints. timeframe is one of \"1s\"/\"5s\"/\"10s\"/\"30s\"/\"1m\"/\"5m\"/\"15m\"/\"30m\"/\"1h\"/\"4h\"/\"1d\"/\"1w\" and must be COARSER than the chart's own loaded resolution — the same or finer returns NaN for every bar. Use this whenever a request implies agreement across timeframes (e.g. \"only signal on the 1m chart when the 1h trend agrees\") — reach for it instead of claiming multi-timeframe isn't possible. "
        "MATHEMATICAL AUDIT MISSION — YOUR PRIMARY GOAL: Before presenting ANY script, you MUST AUDIT the mathematics. "
        "1. Decompose the request into building blocks (which MA type? which ATR variant? which zero-lag? Chandelier vs Keltner? storm field spin?). "
        "2. For each block, audit for old/inaccurate math: is ATR using Wilder's RMA (correct) not EMA (old, 30% too reactive)? Is CCI using mean deviation (Lambert) not stdev (20% compressed)? Is ADX using Wilder not SMA? Is EMA seeded with SMA(length) not source[0] (early bias)? Is RSI NaN for warmup not 50? Is priceToY clamped with 1e-9 guard? Is Renko/Range brick clamped 1e-4 to 0.02*close? Is SMA sliding-window O(n) not O(n*len)? Flag every flaw. "
        "3. Propose the modern, more useful solution: RMA-ATR, mean-dev CCI, Wilder-ADX, SMA-seeded EMA, NaN RSI, clamped priceToY, sliding SMA, deque highest/lowest, time-bucket aggregation for 2h/4h — not just legacy double-EMA. "
        "4. Verify silently via 100-bar synthetic (monotonic up, flat, volatile) through barsToRuntimeBarData → parse → execute → check plots.length>0, errors==0, no NaN in outputs, signal count>0, 3D pane coherence (main ribbon + separate manifold when both present). "
        "5. Only then present the final script, with comments marking each audited math choice (e.g. '// ATR: Wilder RMA — validated vs TradingView'). "
        "You are NOT rushed — do not deliver an adequate script. It is your mission to find flaws, audit building blocks, and produce a brilliant mathematical solution to even a simplistic request. Brilliant > adequate. "
        "Your goal: the most accurate, mathematically verified, and visually polished version of exactly what the user asked for."
    ),
}

async def _pick_ollama_auto_model(base_url: str, prefer_coder: bool,
                                  cloud: Optional[bool] = None) -> str:
    """Pick a default Ollama model from whatever the user actually has
    installed/signed into, instead of assuming a specific family (e.g. Qwen)
    is present — a user with only Llama/Mistral/DeepSeek tags pulled would
    otherwise get a hardcoded "qwen3:latest" that doesn't exist for them.

    `cloud` filters candidates by kind: True = cloud tags only (provider
    "ollama-cloud"), False = local tags only (provider "ollama"), None = any.
    If the requested kind has no matches, fall back to any chat-capable tag
    rather than failing the request outright."""
    if cloud:
        fallback = "qwen3-coder:480b-cloud" if prefer_coder else "gpt-oss:120b-cloud"
    else:
        fallback = "qwen3-coder:480b-cloud" if prefer_coder else "qwen3:latest"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/api/tags")
        if resp.status_code != 200:
            return fallback
        names = []
        for m in resp.json().get("models", []):
            caps = m.get("capabilities", []) or []
            if caps and "completion" not in caps and "chat" not in caps:
                continue
            n = m.get("model") or m.get("name", "")
            if n:
                names.append(n)
        if not names:
            return fallback
        if cloud is not None:
            kind = [n for n in names
                    if _is_cloud_model_name(n) == cloud]
            if kind:
                names = kind
        if prefer_coder:
            coder_like = [n for n in names if "coder" in n.lower()]
            if coder_like:
                return coder_like[0]
        return names[0]
    except Exception:
        return fallback

def _trim_prompt_middle(text: str, max_chars: int) -> str:
    """Keep the head and tail of a system prompt, drop the middle.

    The coder prompt's 3D/drawing contract sits mid-prompt, so a flat text[:N]
    cut always removed exactly the part that explains what the engine can
    render. The model then denied that 3D exists. The head carries the persona
    and the capability contract, the tail carries output/format rules; neither
    may be the casualty of a context fit.
    """
    if len(text) <= max_chars:
        return text
    marker = "\n\n...[middle of the system prompt omitted to fit the model's context]...\n\n"
    keep = max(400, max_chars - len(marker))
    head = int(keep * 0.62)
    return text[:head] + marker + text[-(keep - head):]


@app.post("/api/chat")
async def api_chat(body: dict[str, Any]):
    settings = load_settings()
    agent = body.get("agent", "trade_advisor")
    messages = body.get("messages", [])
    user_msg = body.get("message", "")
    system_prompt = body.get("system_prompt", "") or AGENT_SYSTEM_PROMPTS.get(agent, "")

    # Route coder agent to its OWN model/provider. The frontend always sends the
    # advisor's model in the body, so for the coder we IGNORE it and use the
    # configured coder model (which may be an Ollama cloud model name).
    if agent == "oakscript_coder":
        model = settings.get("llm_coder_model", "auto")
        provider = settings.get("llm_coder_provider", settings.get("llm_provider", "local"))
    else:
        provider = settings.get("llm_provider", "local")
        # On Ollama (local daemon or cloud) the configured model is an explicit
        # tag; ignore the body's (advisor-default) model. On local, the body's
        # selected .gguf is fine.
        if provider.startswith("ollama"):
            model = settings.get("llm_trade_advisor_model", "auto")
        else:
            model = body.get("model", "") or settings.get("llm_trade_advisor_model", "auto")

    # Use the actual running model's port (adopt an externally-started server).
    # Hosted providers never touch the local server, so skip the probe there.
    if provider in HOSTED_PROVIDER_IDS:
        base_url = ""
    else:
        if not _running_model.get("loaded"):
            _adopt_running_model()
        active_port = _running_model.get("port", LLAMA_PORT)
        base_url = f"http://127.0.0.1:{active_port}"

    # Auto-resolve model: if "auto" on the LOCAL provider, pick a .gguf file.
    # (For Ollama the model is an explicit tag like "qwen3-coder:480b-cloud".)
    if model == "auto" and provider in HOSTED_PROVIDER_IDS:
        model = ""  # resolved from the provider's saved/default model at call time
    elif model == "auto" and provider == "local":
        ggufs = glob.glob(os.path.join(MODELS_DIR, "*.gguf"))
        if ggufs:
            model = os.path.splitext(os.path.basename(ggufs[0]))[0]  # filename without .gguf
        else:
            model = "llama"  # fallback — llama.cpp will error clearly
    elif model == "auto":
        model = await _pick_ollama_auto_model(
            settings.get("ollama_base_url", "http://localhost:11434"),
            prefer_coder=agent == "oakscript_coder",
            # "ollama-cloud" auto-picks only cloud tags; "ollama" only local
            # tags — so a cloud selection never silently lands on a local model.
            cloud=provider == "ollama-cloud",
        )

    # Build messages: system first, then conversation, then user message.
    # System-context messages from the frontend are merged into the system prompt.
    identity_override = (
        "You are the DAFE Trade Advisor, an expert trading assistant. "
        "When introducing yourself, say: \"Hi there, I'm your Trade Advisor and assistant. How can I help you today?\" "
    )

    # The identity override is for the ADVISOR persona only. Appending it to
    # coder requests told the code-generation model it was a chatty trading
    # assistant — measurably degrading code quality (wrong persona wins).
    if agent == "oakscript_coder":
        full_system = system_prompt
    else:
        full_system = f"{system_prompt}\n\n{identity_override}"

    # Accumulate any system-context from the message history
    extra_context = []
    filtered_messages = []
    for m in messages:
        role = m.get("role", "user")
        if role in ("system-context", "system"):
            extra_context.append(str(m.get("content", "")))
        else:
            content = m.get("content", "")
            if isinstance(content, list):
                content = [p for p in content if isinstance(p, dict) and p.get("type") != "image_url"]
                if not content:
                    continue
            filtered_messages.append({"role": role, "content": content})

    if extra_context:
        full_system += "\n\n## Current Context\n" + "\n".join(extra_context[-3:])  # keep last 3 at most

    ollama_messages: list[dict] = [{"role": "system", "content": full_system}]

    for m in filtered_messages:
        ollama_messages.append({"role": m["role"], "content": m["content"]})

    if user_msg and not any(
        isinstance(m.get("content"), str) and m.get("content") == user_msg
        for m in ollama_messages
    ):
        ollama_messages.append({"role": "user", "content": str(user_msg)})

    # ── Hosted providers — proxied so the browser never holds the key ──
    if provider in HOSTED_PROVIDER_IDS:
        rec = _provider_record(provider, settings)
        if not rec.get("api_key"):
            return {"ok": False, "detail": f"{rec.get('label') or provider} needs an API key — add it in Settings → Provider API Keys."}
        chosen = model if model and model != "auto" else (rec.get("model") or rec.get("default_model") or "")
        if not chosen:
            return {"ok": False, "detail": f"Pick a model for {rec.get('label') or provider} in Settings."}
        is_coder = agent == "oakscript_coder"
        logger.info("chat request: provider=%s hosted model=%s agent=%s", provider, chosen, agent)
        return await _hosted_chat(
            rec, chosen, full_system, ollama_messages[1:],
            max_tokens=8192 if is_coder else 2048,
            temperature=0.3 if is_coder else 0.5,
        )

    # Call LLM
    if provider == "local":
        chat_url = f"{base_url.rstrip('/')}/v1/chat/completions"
        try:
            is_coder = agent == "oakscript_coder"
            # Adaptive max_tokens: measure prompt, leave room for response.
            # Use the REAL running-model context size, not a hardcoded guess.
            prompt_chars = sum(len(str(m.get("content", ""))) for m in ollama_messages)
            prompt_est = max(100, prompt_chars // 3)  # rough token estimate
            if not _running_model.get("loaded"):
                _adopt_running_model()
            ctx_limit = _running_model.get("ctx") or 8192

            # HARD CAP: if prompt exceeds context, truncate BEFORE sending.
            # Never let llama.cpp return a 400 — always fit.
            # Coder needs larger reserve: prompt is aggressively truncated so
            # remaining = reserve - 300 tokens are left for the code response.
            # A complete OakScript (plot3d + plotshape_3d + signals) needs ~1500 tokens.
            reserve = 2100 if is_coder else 600
            max_prompt_tokens = ctx_limit - reserve
            if prompt_est > max_prompt_tokens:
                logger.warning("prompt %d > ctx %d, truncating from %d messages",
                               prompt_est, ctx_limit, len(ollama_messages))
                sys_msg = ollama_messages[0] if ollama_messages else {"role": "system", "content": ""}
                convo = ollama_messages[1:] if len(ollama_messages) > 1 else []
                # Progressively drop older messages, but NEVER drop the last
                # user message — the Jinja template requires one.
                while len(convo) > 1 and prompt_est > max_prompt_tokens:
                    dropped = convo.pop(0)  # remove oldest
                    prompt_chars -= len(str(dropped.get("content", "")))
                    prompt_est = max(100, prompt_chars // 3)
                # If still too large, trim the SYSTEM PROMPT — from the middle,
                # and only by as much as the context actually requires. The old
                # flat [:2000] cut removed the coder prompt's 3D/drawing contract
                # (it begins at char 3,171 of 15,890), after which the model told
                # users "OakScript has no 3D rendering" — an accurate answer to a
                # prompt that had been silently amputated.
                if prompt_est > max_prompt_tokens and len(sys_msg["content"]) > 1200:
                    overflow_chars = max(0, prompt_chars - max_prompt_tokens * 3)
                    target = max(1600, len(sys_msg["content"]) - overflow_chars - 200)
                    sys_msg["content"] = _trim_prompt_middle(sys_msg["content"], target)
                    prompt_chars = sum(len(str(m.get("content", ""))) for m in [sys_msg] + convo)
                    prompt_est = max(100, prompt_chars // 3)
                # If STILL too large, truncate the last message (must be user)
                if prompt_est > max_prompt_tokens and convo:
                    last = convo[-1]
                    max_last_chars = max(200, max_prompt_tokens * 3 - prompt_chars + len(str(last.get("content", ""))))
                    last["content"] = str(last.get("content", ""))[:max_last_chars] + "...[truncated]"
                    prompt_chars = sum(len(str(m.get("content", ""))) for m in [sys_msg] + convo)
                    prompt_est = max(100, prompt_chars // 3)
                # Safety: ensure at least one user message exists
                if not any(m.get("role") == "user" for m in convo):
                    convo.append({"role": "user", "content": str(user_msg or "Analyze the current chart.")[:500]})
                    prompt_chars = sum(len(str(m.get("content", ""))) for m in [sys_msg] + convo)
                    prompt_est = max(100, prompt_chars // 3)
                ollama_messages = [sys_msg] + convo
                logger.info("after truncation: prompt_est=%d, %d messages", prompt_est, len(ollama_messages))

            remaining = ctx_limit - prompt_est - 300
            # Capability-based, not name-based: read whether the loaded model's
            # OWN chat template emits <think> tags (probe_running inspects
            # /props). This works for any model family the user drops in
            # (Qwen3, DeepSeek-R1, QwQ, future reasoning models) instead of
            # only ones whose filename happens to contain "qwen"/"think".
            # Fall back to the name heuristic only if the probe hasn't run yet
            # (e.g. very first request before /api/model/status has polled).
            if _running_model.get("loaded"):
                is_thinking = _running_model.get("supports_thinking", False)
            else:
                is_thinking = "qwen" in model.lower() or "think" in model.lower()
            # ── Query-complexity classification ──────────────────────────────
            # A thinking model burns THOUSANDS of reasoning tokens; on a trivial
            # prompt ("hi") that means a 200s generation that the client times
            # out on. Classify the request and only let the model think when the
            # task warrants it. This is the fix for simple prompts timing out.
            ut = (user_msg or "").strip()
            utl = ut.lower()
            GREETINGS = {"hi", "hello", "hey", "yo", "sup", "hiya", "hi there", "hello there",
                         "thanks", "thank you", "ty", "ok", "okay", "yes", "no", "cool", "nice", "great", "lol"}
            is_greeting = utl in GREETINGS or (len(utl) <= 16 and any(
                utl.startswith(g) for g in ("hi ", "hey ", "hello", "thanks", "thank ")))
            heavy_kw = ("write", "build", "create", "fix", "debug", "optimize", "refactor", "design",
                        "indicator", "strategy", "analyze", "analyse", "compare", "backtest",
                        "brainstorm", "explain", "implement", "plot", "oakscript", "why ", "how ")
            is_heavy = is_coder or len(ut) > 220 or any(k in utl for k in heavy_kw)
            is_simple = not is_heavy and (is_greeting or len(ut) < 64)
            # The CODER never thinks — every token goes to COMPLETE code, so the
            # output isn't cut off mid-fence (which broke the edit buttons). The
            # advisor may think, but briefly and time-boxed.
            allow_thinking = is_thinking and is_heavy and not is_coder

            # Generation budget — time-boxed so generation finishes before the
            # request timeout (a thinking model at ~35 t/s must stay well under
            # ~5000 tokens to fit a ~150s window).
            if is_simple:
                adaptive_max = 200 if is_greeting else 512
            elif is_coder:
                adaptive_max = max(1200, min(remaining, 4096))
            elif allow_thinking:
                adaptive_max = max(800, min(remaining, 3000))
            else:
                adaptive_max = max(400, min(remaining, max(1024, remaining // 3)))

            # Disable chain-of-thought for light queries AND the coder (llama.cpp
            # template kwarg + Qwen's /no_think soft-switch, for robustness).
            disable_think = is_thinking and not allow_thinking
            if disable_think:
                for m in reversed(ollama_messages):
                    if m.get("role") == "user":
                        m["content"] = str(m.get("content", "")).rstrip() + " /no_think"
                        break
            elif is_thinking:
                # Thinking is ON (advisor, heavy task) — keep it short so the
                # answer arrives before the timeout.
                ollama_messages[0]["content"] = str(ollama_messages[0].get("content", "")) + \
                    " [Think briefly — a few sentences at most — then give the answer.]"

            if adaptive_max < ctx_limit * 0.2:
                budget_msg = f" [Token budget: {adaptive_max}. Be concise. Code over explanation.]"
                ollama_messages[0]["content"] = str(ollama_messages[0].get("content", "")) + budget_msg

            # Timeout scaled to expected generation length. With the budgets
            # above, even a fully-loaded 12B at ~35 t/s completes inside these.
            req_timeout = 30.0 if is_simple else (240.0 if is_coder else 200.0)
            logger.info("chat request: agent=%s simple=%s think=%s prompt_est=%d adaptive_max=%d ctx=%d",
                        agent, is_simple, allow_thinking, prompt_est, adaptive_max, ctx_limit)

            req_body: dict[str, Any] = {
                "model": model, "messages": ollama_messages,
                # Slightly higher temp + nucleus/top-k sampling adds enough
                # diversity to break out of loops.
                "temperature": 0.35 if is_coder else 0.5, "stream": False,
                "max_tokens": adaptive_max,
                "top_p": 0.92,
                "top_k": 40,
                "min_p": 0.05,
                # ── Anti-degeneration (THE fix for "L=50, L=50, L=50…" loops) ──
                # Heavily-quantized models (e.g. IQ3) repeat without a penalty.
                # repeat_penalty/repeat_last_n are llama.cpp-native; the
                # frequency/presence penalties are the OpenAI-compatible knobs.
                "repeat_penalty": 1.15,
                "repeat_last_n": 320,
                "frequency_penalty": 0.4,
                "presence_penalty": 0.3,
            }
            if disable_think:
                req_body["chat_template_kwargs"] = {"enable_thinking": False}

            async with httpx.AsyncClient(timeout=req_timeout) as client:
                resp = await client.post(chat_url, json=req_body)
                if resp.status_code != 200:
                    text = await resp.aread()
                    return {"ok": False, "detail": f"llama.cpp returned {resp.status_code}: {str(text)[:300]}"}
                data = resp.json()
                choice = data.get("choices", [{}])[0]
                reply = choice.get("message", {}).get("content", "")
                # Qwen/thinking models may use `reasoning_content` (llama.cpp) or `think`
                think = (choice.get("message", {}).get("think", "") or
                         choice.get("message", {}).get("reasoning_content", ""))
                finish = choice.get("finish_reason", "")

                # Thinking model: send reasoning separately so UI can collapse it.
                thinking_text = ""
                if think:
                    raw = think.strip()
                    if raw.startswith("<think>"):
                        raw = raw[7:].strip()
                    if raw.endswith("</think>"):
                        raw = raw[:-8].strip()
                    thinking_text = raw

                if not reply and thinking_text:
                    # Model spent all tokens on reasoning — use tail as reply
                    reply = thinking_text[-600:] if len(thinking_text) > 600 else thinking_text

                # Strip think tags from reply, extract any thinking found inside
                if reply:
                    clean = re.split(r"</?think>", reply.strip())
                    if len(clean) > 1:
                        # Found think tags — extract thinking, keep post-think as reply
                        if not thinking_text and len(clean) >= 2 and clean[1].strip():
                            thinking_text = clean[1].strip()
                        reply = (clean[2] if len(clean) > 2 and clean[2].strip() else clean[0]).strip()
                        if not reply and thinking_text:
                            reply = thinking_text[-600:] if len(thinking_text) > 600 else thinking_text
                    # else: no think tags in reply, keep as-is

                if not reply:
                    logger.warning("empty reply from llama.cpp - finish=%s full: %s",
                                  finish, str(data)[:500])
                # Safety net: trim any repetition loop that slipped past sampling.
                reply = _collapse_repetition(reply)
                return {"ok": True, "reply": reply or "(empty response)", "thinking": thinking_text or None}
        except httpx.ConnectError:
            return {"ok": False, "detail": "LLM server not running at " + base_url}
        except httpx.TimeoutException:
            return {"ok": False, "detail": "LLM timed out — model may be loading"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}
    else:
        # Ollama — local daemon OR its cloud models (e.g. "qwen3-coder:480b-cloud",
        # "gpt-oss:120b-cloud"), which run big quantized models that don't fit 8GB.
        # The Oak documentation is already in the system prompt (injected by the
        # frontend retriever), so the coder is a doc-grounded "Oakmaster".
        is_coder = agent == "oakscript_coder"
        base_url = settings.get("ollama_base_url", "http://localhost:11434")
        # Cloud coder models aren't VRAM/context-constrained the way the local
        # path is — 4096 was an arbitrary cap that cut a full indicator script
        # off mid-fence ("cloud models cut code out"). Give it real headroom.
        coder_budget = 8192
        body = {
            "model": model,
            "messages": ollama_messages,
            "stream": False,
            "options": {
                "temperature": 0.3 if is_coder else 0.5,
                "top_p": 0.92, "top_k": 40,
                "repeat_penalty": 1.15, "repeat_last_n": 320,
                "num_predict": coder_budget if is_coder else 1536,
            },
        }
        if is_coder:
            body["think"] = False  # output code directly, no chain-of-thought
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                resp = await client.post(f"{base_url.rstrip('/')}/api/chat", json=body)
                if resp.status_code != 200:
                    text = await resp.aread()
                    return {"ok": False, "detail": f"Ollama returned {resp.status_code}: {str(text)[:300]}"}
                data = resp.json()
                msg = data.get("message", {})
                reply = msg.get("content", "") or msg.get("thinking", "") or ""
                done_reason = data.get("done_reason", "")

                # The model hit the length cap, not a natural stop — the coder's
                # script was cut off mid-generation. Ask it to continue from
                # exactly where it stopped instead of returning broken code.
                # Bounded to 2 continuations (covers even very large scripts);
                # each one gets the same generous budget.
                continuations = 0
                convo = list(ollama_messages)
                while is_coder and done_reason == "length" and continuations < 2:
                    convo.append({"role": "assistant", "content": reply})
                    convo.append({"role": "user", "content": (
                        "Your last response was cut off before it finished. Continue "
                        "EXACTLY where you left off — do not repeat anything already "
                        "written, do not restart the code fence, just keep emitting "
                        "the remaining lines until the script and its closing ``` are complete."
                    )})
                    cont_body = dict(body, messages=convo)
                    cont_resp = await client.post(f"{base_url.rstrip('/')}/api/chat", json=cont_body)
                    if cont_resp.status_code != 200:
                        break
                    cont_data = cont_resp.json()
                    cont_msg = cont_data.get("message", {})
                    cont_text = cont_msg.get("content", "") or ""
                    reply += cont_text
                    done_reason = cont_data.get("done_reason", "")
                    continuations += 1

                reply = _collapse_repetition(reply)
                return {"ok": True, "reply": reply or "(empty response)"}
        except httpx.ConnectError:
            return {"ok": False, "detail": f"Ollama not reachable at {base_url} — start the Ollama app (or `ollama serve`). For cloud models run `ollama signin` first."}
        except httpx.TimeoutException:
            return {"ok": False, "detail": "Ollama timed out — a cloud model may be cold-starting; try again."}
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
    try:
        max_results = min(max(1, int(body.get("max_results", 5))), 20)
    except (TypeError, ValueError):
        max_results = 5
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
    path = None
    try:
        from gtts import gTTS
        # Create the temp path then CLOSE the handle before writing — on Windows
        # an open handle locks the file and gTTS.save() fails with WinError 32.
        fd, path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        gTTS(text=text, lang="en", slow=False).save(path)
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        return {"audio_b64": b64}
    except Exception as e:
        logger.warning("gTTS failed: %s", e)
        return {"audio_b64": None, "error": str(e)}
    finally:
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except Exception:
                pass

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
@app.get("/api/settings")
def api_get_settings():
    s = load_settings()
    resp = dict(s)
    resp["massive_api_key_masked"] = mask_key(s.get("massive_api_key", ""))
    resp["serpapi_api_key_masked"] = mask_key(s.get("serpapi_api_key", ""))
    # tradovate_password is a real trading-account secret — it must NEVER ride
    # along in the response payload in cleartext (a prior gap: the two API keys
    # above were stripped but this one was forgotten, so the raw password was
    # served to anything reaching localhost). Expose only a masked form + a
    # boolean "configured" flag; the raw value never leaves the backend after entry.
    resp["tradovate_password_masked"] = mask_key(s.get("tradovate_password", ""))
    resp["tradovate_password_set"] = bool(s.get("tradovate_password", ""))
    del resp["massive_api_key"]; del resp["serpapi_api_key"]; resp.pop("tradovate_password", None)
    # Provider keys are served only through /api/llm/providers, masked.
    resp.pop("llm_provider_keys", None)
    # Data-provider keys likewise: only /api/data/providers, masked.
    resp.pop("data_provider_keys", None)
    return resp

@app.post("/api/settings")
def api_save_settings(body: dict[str, Any]):
    current = load_settings()
    for key, value in body.items():
        if key in ("llm_provider_keys", "data_provider_keys"):
            continue  # managed by the provider endpoints — never accepted raw
        if key in ("massive_api_key", "serpapi_api_key", "tradovate_password"):
            # Only update API keys/secrets if they're not masked
            if value and "*" not in str(value):
                current[key] = str(value).strip()
        else:
            # Accept all other keys
            current[key] = value
    try:
        save_settings(current)
        resp = dict(current)
        resp["massive_api_key_masked"] = mask_key(current.get("massive_api_key", ""))
        resp["serpapi_api_key_masked"] = mask_key(current.get("serpapi_api_key", ""))
        resp["tradovate_password_masked"] = mask_key(current.get("tradovate_password", ""))
        resp["tradovate_password_set"] = bool(current.get("tradovate_password", ""))
        del resp["massive_api_key"]; del resp["serpapi_api_key"]; resp.pop("tradovate_password", None)
        resp.pop("llm_provider_keys", None); resp.pop("data_provider_keys", None)
        return {"ok": True, "settings": resp}
    except Exception as e:
        logger.error("Failed to save settings: %s", e)
        return {"ok": False, "detail": str(e)}

# ---------------------------------------------------------------------------
# Hosted LLM providers — masked key registry, live model catalogue, test
# ---------------------------------------------------------------------------
@app.get("/api/llm/providers")
def api_llm_providers():
    s = load_settings()
    out = []
    for pid in LLM_PROVIDERS:
        if pid == "ollama":
            continue  # configured by the Ollama URL, not a key
        rec = _provider_record(pid, s)
        out.append({
            "id": pid, "label": rec.get("label", pid),
            "base_url": rec.get("base_url", ""),
            "configured": bool(rec.get("api_key")),
            "masked_key": mask_key(rec.get("api_key", "")),
            "note": rec.get("note", ""), "doc": rec.get("doc", ""),
            "default_model": rec.get("default_model", ""),
            "model": rec.get("model", ""),
        })
    return {"ok": True, "providers": out}


@app.put("/api/llm/providers/{pid}")
def api_llm_provider_save(pid: str, body: dict[str, Any]):
    if pid not in HOSTED_PROVIDER_IDS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    s = load_settings()
    keys = dict(s.get("llm_provider_keys") or {})
    entry = dict(keys.get(pid) or {})
    api_key = str(body.get("api_key") or "").strip()
    # A masked value means "leave the stored key alone" — the same rule the
    # rest of the panel uses, so re-saving a visible mask cannot wipe a key.
    if api_key and "*" not in api_key:
        entry["api_key"] = api_key
    if "base_url" in body:
        entry["base_url"] = str(body.get("base_url") or "").strip()
    if "model" in body:
        entry["model"] = str(body.get("model") or "").strip()
    keys[pid] = entry
    s["llm_provider_keys"] = keys
    save_settings(s)
    rec = _provider_record(pid, s)
    return {"ok": True, "provider": {
        "id": pid, "configured": bool(rec.get("api_key")),
        "masked_key": mask_key(rec.get("api_key", "")),
    }}


@app.delete("/api/llm/providers/{pid}")
def api_llm_provider_clear(pid: str):
    if pid not in HOSTED_PROVIDER_IDS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    s = load_settings()
    keys = dict(s.get("llm_provider_keys") or {})
    keys.pop(pid, None)
    s["llm_provider_keys"] = keys
    save_settings(s)
    return {"ok": True}


@app.get("/api/llm/models")
async def api_llm_models(provider: str):
    s = load_settings()
    r = await _fetch_provider_models(provider, s)
    return {"ok": r.get("ok", False), "models": r.get("models", []), "error": r.get("error", "")}


@app.post("/api/llm/providers/{pid}/test")
async def api_llm_provider_test(pid: str):
    if pid not in HOSTED_PROVIDER_IDS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    s = load_settings()
    rec = _provider_record(pid, s)
    if not rec.get("api_key"):
        return {"ok": False, "error": "No API key saved for this provider.", "models": 0}
    r = await _fetch_provider_models(pid, s, force=True)
    if not r.get("ok"):
        return {"ok": False, "error": r.get("error", "Model list failed"), "models": 0}
    models = r.get("models", [])
    model = rec.get("model") or rec.get("default_model") or (models[0] if models else "")
    probe = await _hosted_chat(
        rec, model, "You are a connectivity probe.",
        # Reasoning models can spend a short budget entirely on hidden thinking
        # and return empty content — give the probe enough room to actually emit.
        [{"role": "user", "content": "Reply with the single word: OK"}], 512, 0.0,
    )
    # Model catalogues vary (NIM especially): if the default slug is not served
    # to this key, retry with the first listed model so "Test" can still prove
    # the key + chat path work before the user picks a model.
    if not probe.get("ok") and models and model != models[0]:
        alt = await _hosted_chat(
            rec, models[0], "You are a connectivity probe.",
            [{"role": "user", "content": "Reply with the single word: OK"}], 512, 0.0,
        )
        if alt.get("ok"):
            probe, model = alt, models[0]
    return {
        "ok": bool(probe.get("ok")), "models": len(models), "model": model,
        "error": probe.get("detail") or "", "reply": (probe.get("reply") or "")[:80],
    }

# ---------------------------------------------------------------------------
# Market Data (Yahoo chart endpoint + embedded securities)
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
    {"symbol": "UB=F", "name": "Ultra T-Bond"}, {"symbol": "ZQ=F", "name": "30-Day Fed Funds"},
    {"symbol": "ZR=F", "name": "Rough Rice"}, {"symbol": "ZO=F", "name": "Oats"},
    {"symbol": "HE=F", "name": "Lean Hogs"}, {"symbol": "LE=F", "name": "Live Cattle"},
    {"symbol": "GF=F", "name": "Feeder Cattle"}, {"symbol": "BZ=F", "name": "Brent Crude"},
    {"symbol": "BTC=F", "name": "Bitcoin Futures (CME)"},
    {"symbol": "BNB-USD", "name": "BNB"}, {"symbol": "ADA-USD", "name": "Cardano"},
    {"symbol": "XRP-USD", "name": "XRP"}, {"symbol": "DOGE-USD", "name": "Dogecoin"},
    {"symbol": "AVAX-USD", "name": "Avalanche"}, {"symbol": "DOT-USD", "name": "Polkadot"},
    {"symbol": "MATIC-USD", "name": "Polygon"}, {"symbol": "LTC-USD", "name": "Litecoin"},
    {"symbol": "LINK-USD", "name": "Chainlink"}, {"symbol": "UNI-USD", "name": "Uniswap"},
    {"symbol": "ATOM-USD", "name": "Cosmos"}, {"symbol": "ETC-USD", "name": "Ethereum Classic"},
    {"symbol": "FIL-USD", "name": "Filecoin"}, {"symbol": "TRX-USD", "name": "TRON"},
    {"symbol": "APT-USD", "name": "Aptos"}, {"symbol": "ARB-USD", "name": "Arbitrum"},
]

SUB_MINUTE_TIMEFRAMES = {"1s", "5s", "10s", "30s"}
SUPPORTED_TIMEFRAMES = SUB_MINUTE_TIMEFRAMES | {"1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1wk"}
# Sub-minute bars require a real second-resolution feed — the Yahoo chart API
# has no interval below 1m, so only Massive (paid, second-aggregates) can
# serve these.
SUB_MINUTE_SECS = {"1s": 1, "5s": 5, "10s": 10, "30s": 30}

# Yahoo's public chart endpoint (query1.finance.yahoo.com). yfinance is NOT
# used for market data anymore: its pyarrow dependency hard-crashes the whole
# process (access violation in arrow.dll) on Python 3.14, and the raw endpoint
# is faster, timeout-controllable, and needs no cookie/crumb dance server-side.
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
_YAHOO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}
# Yahoo chart intervals: 1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo.
# 2h/4h have no native interval -> fetch 1h and aggregate.
_TF_YAHOO_INTERVAL = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
                      "1h": "1h", "2h": "1h", "4h": "1h", "1d": "1d", "1wk": "1wk"}
_TF_YAHOO_GROUP = {"2h": 2, "4h": 4}

def _yahoo_range(tf: str, period: str) -> str:
    bars = int(period) if period.strip().isdigit() else 120
    t = tf.strip().lower()
    if t == "1m": return "7d"
    if t == "5m": return "60d"
    if t in ("15m", "30m"): return "6mo"
    if t in ("1h", "2h", "4h"): return "1y" if bars > 500 else "6mo"
    return "2y"

def _is_valid_bar(b: dict[str, Any], tf: str) -> bool:
    try:
        o,h,l,c,v = b["open"], b["high"], b["low"], b["close"], b["volume"]
        if not all(isinstance(x,(int,float)) and x==x for x in (o,h,l,c)): return False # NaN check
        if h < l or h < max(o,c) - 1e-9 or l > min(o,c) + 1e-9: return False
        price = c or o or h or l
        if price and (h - l) > price * (0.05 if tf in ("1d","1wk") else 0.02): return False # 2% for intraday, 5% for daily
        if b["ts"] > time.time() + 60: return False # future bar
        return True
    except: return False

def _validate_bars(bars: list[dict[str, Any]], tf: str) -> list[dict[str, Any]]:
    out = [b for b in bars if _is_valid_bar(b, tf)]
    # Drop isolated spikes where close jumps >3% from neighbors (bad tick)
    if len(out) >= 3:
        filtered = [out[0]]
        for i in range(1, len(out)-1):
            prev, cur, nxt = out[i-1], out[i], out[i+1]
            if abs(cur["close"]-prev["close"])/prev["close"] > 0.03 and abs(cur["close"]-nxt["close"])/nxt["close"] > 0.03:
                continue # spike
            filtered.append(cur)
        filtered.append(out[-1])
        return filtered
    return out

# S3 flatfiles fallback for historical when REST is 403/429 (uses same Massive S3 creds)
async def _fetch_s3_flatfiles(symbol: str, tf: str, period: str) -> list[dict[str, Any]] | None:
    s = load_settings()
    ak = s.get("massive_s3_access_key") or s.get("massive_api_key","")
    sk = s.get("massive_s3_secret") or s.get("massive_api_key","")
    if not ak or not sk: return None
    # Flatfiles are daily CSVs, not yet implemented for intraday — return None to fallback to Yahoo
    return None

def _aggregate_bars(bars: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i in range(0, len(bars), n):
        chunk = bars[i:i + n]
        out.append({"ts": chunk[0]["ts"], "open": chunk[0]["open"],
                    "high": max(b["high"] for b in chunk), "low": min(b["low"] for b in chunk),
                    "close": chunk[-1]["close"], "volume": sum(b["volume"] for b in chunk)})
    return out

async def _fetch_yahoo_chart(symbol: str, tf: str, period: str) -> Optional[list[dict[str, Any]]]:
    interval = _TF_YAHOO_INTERVAL.get(tf.strip().lower(), "1h")
    group = _TF_YAHOO_GROUP.get(tf.strip().lower(), 1)
    try:
        async with httpx.AsyncClient(timeout=15.0, headers=_YAHOO_HEADERS, follow_redirects=True) as client:
            r = await client.get(YAHOO_CHART_URL + quote(symbol),
                                 params={"interval": interval, "range": _yahoo_range(tf, period),
                                         "includeAdjustedClose": "true"})
        if r.status_code != 200:
            return None
        payload = r.json()
        result = (payload.get("chart") or {}).get("result")
        if not result:
            return None
        ts = result[0].get("timestamp") or []
        q = ((result[0].get("indicators") or {}).get("quote") or [None])[0] or {}
        o, h, l, c, v = q.get("open"), q.get("high"), q.get("low"), q.get("close"), q.get("volume")
        if not ts or not c:
            return None
        rows = []
        for i, t in enumerate(ts):
            if i >= len(c) or c[i] is None:
                continue  # market-closed gaps come back as nulls
            rows.append({"ts": int(t), "open": float(o[i] if i < len(o) and o[i] is not None else c[i]),
                         "high": float(h[i] if i < len(h) and h[i] is not None else c[i]),
                         "low": float(l[i] if i < len(l) and l[i] is not None else c[i]),
                         "close": float(c[i]),
                         "volume": float(v[i] if i < len(v) and v[i] is not None else 0)})
        if not rows:
            return None
        if group > 1:
            rows = _aggregate_bars(rows, group)
        return rows
    except Exception:
        return None

@app.get("/api/market-data/securities")
def api_securities():
    return {"ok": True, "securities": SECURITIES}

@app.get("/api/market-data/providers")
def api_providers():
    s = load_settings()
    massive_ok = bool(s.get("massive_api_key", ""))
    return {"providers": [
        # Massive is the only source with real second-resolution aggregates —
        # sub_minute_timeframes stays empty for yahoo so the client can grey
        # those options out instead of letting users pick data we can't serve.
        {"name": "massive", "available": massive_ok, "needs_api_key": True, "has_api_key": massive_ok,
         "sub_minute_timeframes": sorted(SUB_MINUTE_SECS.keys(), key=lambda k: SUB_MINUTE_SECS[k]) if massive_ok else []},
        {"name": "yahoo", "available": True, "needs_api_key": False, "has_api_key": None,
         "sub_minute_timeframes": []},
    ]}

# ─── Universal market-data providers ─────────────────────────────────
# Any provider connects through ONE adapter contract: the provider
# returns whatever shape it likes; the adapter converts it to the
# internal bar form {ts, open, high, low, close, volume} that the whole
# system consumes. Presets cover the common REST shapes; "custom" takes
# a URL template + response mapping for anything else.
DATA_PROVIDERS: dict[str, dict[str, Any]] = {
    "yahoo": {"label": "Yahoo Finance (free)", "needs_key": False, "note": "Built-in free feed. No key."},
    "massive": {"label": "Massive / Polygon", "needs_key": True, "note": "Uses the Massive API key above; identical aggregates API as Polygon."},
    "polygon": {"label": "Polygon.io", "needs_key": True, "base_url": "https://api.polygon.io", "note": "Aggregates API (same shape as Massive)."},
    "alpaca": {"label": "Alpaca Market Data", "needs_key": True, "base_url": "https://data.alpaca.markets", "note": "Key format: KEY_ID:SECRET in the key field. IEX feed by default."},
    "twelvedata": {"label": "Twelve Data", "needs_key": True, "base_url": "https://api.twelvedata.com", "note": "time_series endpoint; stocks/forex/crypto."},
    "custom": {"label": "Custom REST (URL template)", "needs_key": False, "note": "Any OHLCV JSON API: URL template with {symbol} {interval} {fromISO} {toISO} {apiKey} {limit}, a bars path, and field names."},
}

_TF_MULT = {"1s": (1, "second"), "5s": (5, "second"), "10s": (10, "second"), "30s": (30, "second"),
            "1m": (1, "minute"), "5m": (5, "minute"), "15m": (15, "minute"), "30m": (30, "minute"),
            "1h": (1, "hour"), "2h": (2, "hour"), "4h": (4, "hour"), "1d": (1, "day"), "1wk": (1, "week")}
_TF_ALPACA = {"1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day", "1wk": "1Week"}
_TF_TWELVE = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1day", "1wk": "1week"}


def _data_provider_record(pid: str, s: dict[str, Any]) -> dict[str, Any]:
    meta = dict(DATA_PROVIDERS.get(pid) or {})
    keys = s.get("data_provider_keys") or {}
    cfg = (s.get("data_provider_cfg") or {}).get(pid) or {}
    if pid == "massive":
        key = s.get("massive_api_key", "") or ""
    else:
        key = keys.get(pid, "") or ""
    return {**meta, "id": pid, "configured": bool(key) or not meta.get("needs_key"),
            "masked_key": mask_key(key), "base_url": cfg.get("base_url") or meta.get("base_url") or "",
            "url_template": cfg.get("url_template", ""), "bars_path": cfg.get("bars_path", "results"),
            "fields": cfg.get("fields") or {"ts": "ts", "open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume", "ts_unit": "iso"}}


def _dot_get(obj: Any, path: str) -> Any:
    cur = obj
    for part in (path or "").split("."):
        if not part:
            continue
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            idx = int(part)
            cur = cur[idx] if idx < len(cur) else None
        else:
            return None
        if cur is None:
            return None
    return cur


def _parse_ts(v: Any, unit: str) -> float:
    if v is None:
        return 0.0
    if unit == "ms":
        return float(v) / 1000.0
    if unit == "s":
        return float(v)
    if isinstance(v, (int, float)):
        return float(v) / 1000.0 if float(v) > 1e12 else float(v)
    # ISO string
    from datetime import datetime
    txt = str(v).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(txt).timestamp()
    except Exception:
        return 0.0


def _rows_to_bars(rows: list, fields: dict[str, str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        try:
            ts = _parse_ts(row.get(fields.get("ts", "ts")), fields.get("ts_unit", "iso"))
            o, h, l, c = (float(row[fields.get(k, k)]) for k in ("open", "high", "low", "close"))
            vol_raw = row.get(fields.get("volume", "volume"), 0)
            vol = float(vol_raw) if vol_raw not in (None, "") else 0.0
        except Exception:
            continue
        if ts <= 0:
            continue
        out.append({"ts": ts, "open": o, "high": h, "low": l, "close": c, "volume": vol})
    out.sort(key=lambda b: b["ts"])
    return out


async def _fetch_via_adapter(pid: str, symbol: str, tf: str, count: int, s: dict[str, Any]) -> list[dict[str, Any]]:
    """Universal adapter: provider shape in, internal bars out."""
    cfg = (s.get("data_provider_cfg") or {}).get(pid) or {}
    keys = s.get("data_provider_keys") or {}
    key = (s.get("massive_api_key", "") if pid == "massive" else keys.get(pid, "")) or ""
    mult, span = _TF_MULT.get(tf, (1, "day"))
    import time as _time
    to_ts = _time.time()
    bars_secs = mult * {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 604800}[span]
    from_ts = to_ts - max(count, 50) * bars_secs * 2
    from datetime import datetime, timezone
    from_iso = datetime.fromtimestamp(from_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    to_iso = datetime.fromtimestamp(to_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    fields = {"ts": "t", "open": "o", "high": "h", "low": "l", "close": "c", "volume": "v", "ts_unit": "ms"}

    async with httpx.AsyncClient(timeout=15.0) as client:
        if pid in ("massive", "polygon"):
            base = (cfg.get("base_url") or ("https://api.massive.com" if pid == "massive" else "https://api.polygon.io")).rstrip("/")
            tk = _massive_ticker(symbol)
            r = await client.get(f"{base}/v2/aggs/ticker/{tk}/range/{mult}/{span}/{from_iso[:10]}/{to_iso[:10]}",
                                 params={"adjusted": "true", "sort": "asc", "limit": "50000", "apiKey": key})
            r.raise_for_status()
            return _rows_to_bars(r.json().get("results") or [], fields)
        if pid == "alpaca":
            base = (cfg.get("base_url") or "https://data.alpaca.markets").rstrip("/")
            kid, _, secret = key.partition(":")
            r = await client.get(f"{base}/v2/stocks/{symbol}/bars",
                                 params={"timeframe": _TF_ALPACA.get(tf, "1Day"), "start": from_iso, "end": to_iso, "limit": 10000, "feed": "iex", "adjustment": "split"},
                                 headers={"APCA-API-KEY-ID": kid, "APCA-API-SECRET-KEY": secret or kid})
            r.raise_for_status()
            f2 = dict(fields); f2["ts_unit"] = "iso"
            return _rows_to_bars(r.json().get("bars") or [], f2)
        if pid == "twelvedata":
            base = (cfg.get("base_url") or "https://api.twelvedata.com").rstrip("/")
            r = await client.get(f"{base}/time_series",
                                 params={"symbol": symbol, "interval": _TF_TWELVE.get(tf, "1day"), "outputsize": max(count, 50), "apikey": key, "format": "JSON"})
            r.raise_for_status()
            payload = r.json()
            f3 = {"ts": "datetime", "open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume", "ts_unit": "iso"}
            return _rows_to_bars(payload.get("values") or [], f3)
        if pid == "custom":
            template = cfg.get("url_template") or ""
            if not template:
                return []
            url = (template.replace("{symbol}", symbol).replace("{interval}", tf)
                   .replace("{fromISO}", from_iso).replace("{toISO}", to_iso)
                   .replace("{from}", str(int(from_ts))).replace("{to}", str(int(to_ts)))
                   .replace("{apiKey}", key).replace("{limit}", str(max(count, 50))))
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            payload = r.json()
            rows = _dot_get(payload, cfg.get("bars_path", "results"))
            if rows is None and isinstance(payload, list):
                rows = payload
            cfields = {"ts": "ts", "open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume", "ts_unit": "iso"}
            cfields.update(cfg.get("fields") or {})
            return _rows_to_bars(rows or [], cfields)
    return []


@app.get("/api/data/providers")
def api_data_providers():
    s = load_settings()
    return {"ok": True, "providers": [_data_provider_record(pid, s) for pid in DATA_PROVIDERS]}


@app.put("/api/data/providers/{pid}")
def api_data_provider_save(pid: str, body: dict[str, Any] = {}):
    if pid not in DATA_PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown data provider")
    s = load_settings()
    keys = dict(s.get("data_provider_keys") or {})
    cfg = dict(s.get("data_provider_cfg") or {})
    entry = dict(cfg.get(pid) or {})
    api_key = str(body.get("api_key") or "").strip()
    if api_key and "*" not in api_key:
        if pid == "massive":
            s["massive_api_key"] = api_key
        else:
            keys[pid] = api_key
    for field_name in ("base_url", "url_template", "bars_path"):
        if field_name in body:
            entry[field_name] = str(body.get(field_name) or "").strip()
    if isinstance(body.get("fields"), dict):
        entry["fields"] = {k: str(v) for k, v in body["fields"].items()}
    cfg[pid] = entry
    s["data_provider_keys"] = keys
    s["data_provider_cfg"] = cfg
    save_settings(s)
    return {"ok": True, "provider": _data_provider_record(pid, load_settings())}


@app.delete("/api/data/providers/{pid}")
def api_data_provider_clear(pid: str):
    if pid not in DATA_PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown data provider")
    s = load_settings()
    keys = dict(s.get("data_provider_keys") or {})
    keys.pop(pid, None)
    if pid == "massive":
        s["massive_api_key"] = ""
    s["data_provider_keys"] = keys
    save_settings(s)
    return {"ok": True, "provider": _data_provider_record(pid, load_settings())}


@app.post("/api/data/providers/{pid}/test")
async def api_data_provider_test(pid: str):
    if pid not in DATA_PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown data provider")
    s = load_settings()
    rec = _data_provider_record(pid, s)
    if rec.get("needs_key") and not rec.get("configured"):
        return {"ok": False, "detail": f"{rec.get('label')} needs an API key first."}
    try:
        if pid == "yahoo":
            bars = await _fetch_yahoo_chart("SPY", "1d", "5") or []
        else:
            bars = await _fetch_via_adapter(pid, "SPY", "1d", 5, s)
            bars = _validate_bars(bars, "1d")
    except Exception as e:
        return {"ok": False, "detail": f"{type(e).__name__}: {e}"[:200]}
    if not bars:
        return {"ok": False, "detail": "Provider answered but returned no usable bars for SPY (check key / URL template / field mapping)."}
    return {"ok": True, "bars": len(bars), "first_close": bars[0]["close"], "last_close": bars[-1]["close"],
            "detail": f"{rec.get('label')} returned {len(bars)} adapted bars for SPY."}


@app.get("/api/market-data/{symbol}")
async def api_market_data(symbol: str, timeframe: str = "1h", period: str = "200", provider: Optional[str] = None):
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol required")
    symbol = symbol.strip().upper()
    tf = timeframe.strip().lower()
    if tf not in SUPPORTED_TIMEFRAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {tf}")
    if tf in SUB_MINUTE_TIMEFRAMES:
        s = load_settings()
        if not s.get("massive_api_key", "") or provider == "yahoo":
            raise HTTPException(status_code=400, detail=f"Sub-minute timeframe {tf} requires the Massive provider (yfinance has no interval below 1m)")

    # Cache bars per (symbol, tf, period, provider). A bar only changes once per
    # period, so the TTL scales with the timeframe (capped) — repeated loads and
    # symbol toggles are served from cache instead of re-hitting the paid feed.
    bar_secs = {**SUB_MINUTE_SECS, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
                "2h": 7200, "4h": 14400, "1d": 86400, "1wk": 604800}.get(tf, 60)
    ttl = max(8.0, min(float(bar_secs) * 0.25, 45.0))
    key = f"bars:{provider or 'auto'}:{symbol}:{tf}:{period}"
    cached = _cache_get(key, ttl)
    if cached is not None:
        return cached

    lock = _cache_lock(key)
    async with lock:
        cached = _cache_get(key, ttl)
        if cached is not None:
            return cached
        _cache_stats["misses"] += 1
        result = await _fetch_market_data(symbol, tf, period, provider)
        _cache_stats["upstream"] += 1
        _cache_set(key, result)
        return result


def _massive_ticker(yahoo_symbol: str) -> str:
    s = yahoo_symbol.strip().upper()
    # Yahoo futures: ES=F -> ES, YM=F -> YM, DX-Y.NYB -> DX
    if s.endswith("=F") or s.endswith("-F"):
        base = s.replace("=F","").replace("-F","")
        # DX-Y.NYB is Yahoo's Dollar Index, Massive uses DX
        if base == "DX-Y.NYB": return "DX"
        return base
    # Yahoo crypto: BTC-USD -> X:BTCUSD
    if s.endswith("-USD"):
        base = s.split("-")[0]
        return f"X:{base}USD"
    # Yahoo FX: EURUSD=X -> C:EURUSD, GBPUSD=X -> C:GBPUSD
    if s.endswith("=X"):
        base = s.replace("=X","").replace("USD","")
        # EURUSD=X -> EURUSD, need C:EURUSD
        # For pairs like EURUSD=X, already EURUSD, for USDJPY=X -> USDJPY
        sym = s.replace("=X","")
        return f"C:{sym}"
    return s

async def _fetch_market_data(symbol: str, tf: str, period: str, provider: Optional[str]) -> dict[str, Any]:
    used_provider = None
    bars = None

    # Universal adapter providers (polygon / alpaca / twelvedata / custom…).
    if provider and provider in DATA_PROVIDERS and provider not in ("yahoo", "massive"):
        try:
            count = int(period) if str(period).isdigit() else 200
            raw = await _fetch_via_adapter(provider, symbol, tf, count, load_settings())
            checked = _validate_bars(raw, tf)
            if checked:
                return {"ok": True, "symbol": symbol, "timeframe": tf, "provider": provider, "bars": checked}
        except Exception as e:
            print(f"[data-adapter:{provider}] exc {e}", flush=True)
        raise HTTPException(status_code=502, detail=f"Provider {provider} returned no usable bars for {symbol}")

    # Try Massive if configured
    if (provider is None or provider == "massive"):
        s = load_settings()
        api_key = s.get("massive_api_key", "")
        if api_key:
            try:
                multiplier = {"1s": 1, "5s": 5, "10s": 10, "30s": 30, "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 1, "2h": 2, "4h": 4, "1d": 1, "1wk": 1}[tf]
                timespan = {"1s": "second", "5s": "second", "10s": "second", "30s": "second", "1m": "minute", "5m": "minute", "15m": "minute", "30m": "minute", "1h": "hour", "2h": "hour", "4h": "hour", "1d": "day", "1wk": "week"}[tf]
                import time as _time
                to_date = _time.strftime("%Y-%m-%d", _time.gmtime())
                from_ts = _time.time() - int(period) * 86400 if period.isdigit() else _time.time() - 30 * 86400
                from_date = _time.strftime("%Y-%m-%d", _time.gmtime(from_ts))
                massive_sym = _massive_ticker(symbol)
                # Rate-limit guard: if we got 403 recently, skip Massive for 60s
                if getattr(_fetch_market_data, "_massive_blocked_until", 0) > _time.time():
                    print(f"[massive] blocked until {_fetch_market_data._massive_blocked_until}", flush=True)
                    raise Exception("massive rate limited")
                print(f"[massive] {symbol} -> {massive_sym} {multiplier}/{timespan} {from_date}/{to_date}", flush=True)
                async with httpx.AsyncClient(timeout=15.0) as client:
                    r = await client.get(
                        f"https://api.massive.com/v2/aggs/ticker/{massive_sym}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
                        params={"adjusted": "true", "sort": "asc", "limit": "50000", "apiKey": api_key},
                    )
                    if r.status_code in (403,429):
                        _fetch_market_data._massive_blocked_until = _time.time() + 60
                        print(f"[massive] {r.status_code} rate limited, blocking 60s", flush=True)
                        # Try S3 flatfiles for historical fallback
                        s3_bars = await _fetch_s3_flatfiles(symbol, tf, period)
                        if s3_bars:
                            bars = _validate_bars(s3_bars, tf)
                            if bars: used_provider = "massive-s3"
                        raise Exception(f"massive {r.status_code}")
                if r.status_code == 200:
                    payload = r.json()
                    if payload.get("status") in ("OK", "DELAYED"):
                        results = payload.get("results") or []
                        raw = [{"ts": float(row.get("t", 0)) / 1000, "open": row["o"], "high": row["h"], "low": row["l"], "close": row["c"], "volume": row.get("v", 0)} for row in results if all(k in row for k in ("o", "h", "l", "c"))]
                        bars = _validate_bars(raw, tf)
                        if bars: used_provider = "massive"
            except Exception as e:
                print(f"[massive] exc {e}", flush=True)
                pass

    # Fallback to the free Yahoo chart endpoint (direct HTTP) — only for non-sub-minute (Yahoo has no 1s)
    if bars is None and (provider is None or provider == "yahoo") and tf not in SUB_MINUTE_TIMEFRAMES:
        yahoo_raw = await _fetch_yahoo_chart(symbol, tf, period)
        if yahoo_raw:
            bars = _validate_bars(yahoo_raw, tf)
            if bars:
                used_provider = "yahoo"

    if not bars:
        raise HTTPException(status_code=404, detail=f"No data for {symbol}")

    return {"ok": True, "symbol": symbol, "timeframe": tf, "provider": used_provider, "bars": bars}

# ---------------------------------------------------------------------------
# Lightweight quote — cheap latest-price correction for the Hybrid engine.
# Designed to be hit frequently (yahoo, free) or sparingly (massive, paid).
# ---------------------------------------------------------------------------
@app.get("/api/quote/{symbol}")
async def api_quote(symbol: str, provider: str = "yahoo"):
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol required")
    symbol = symbol.strip().upper()

    # Cache + de-dupe so frequent corrections don't hammer the provider.
    # Short TTL keeps prices fresh; the paid feed gets a slightly longer one.
    ttl = 4.0 if provider == "massive" else 2.0
    key = f"quote:{provider}:{symbol}"
    cached = _cache_get(key, ttl)
    if cached is not None:
        return cached
    async with _cache_lock(key):
        cached = _cache_get(key, ttl)  # re-check: another coroutine may have filled it
        if cached is not None:
            return cached
        _cache_stats["misses"] += 1
        result = await _fetch_quote(symbol, provider)
        if result.get("ok"):
            _cache_stats["upstream"] += 1
            _cache_set(key, result)
        return result


async def _fetch_quote(symbol: str, provider: str) -> dict[str, Any]:
    # Massive (paid): single last-trade call — minimal cost.
    if provider == "massive":
        s = load_settings()
        api_key = s.get("massive_api_key", "")
        if not api_key:
            return {"ok": False, "detail": "massive not configured"}
        try:
            massive_sym = _massive_ticker(symbol)
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(
                    f"https://api.massive.com/v2/last/trade/{massive_sym}",
                    params={"apiKey": api_key},
                )
            if r.status_code == 200:
                payload = r.json()
                res = payload.get("results") or {}
                price = res.get("p") or res.get("price")
                if price:
                    return {"ok": True, "symbol": symbol, "price": float(price),
                            "provider": "massive", "ts": res.get("t")}
            elif r.status_code in (403,429):
                print(f"[massive] quote {r.status_code} for {massive_sym}", flush=True)
        except Exception as e:
            print(f"[massive] quote exc {e}", flush=True)
        # Fallback to Yahoo for quotes when Massive 403/rate-limited

    # Yahoo (free): latest close from 1m bars via the chart endpoint.
    try:
        bars = await _fetch_yahoo_chart(symbol, "1m", "1")
        if bars:
            return {"ok": True, "symbol": symbol, "price": float(bars[-1]["close"]), "provider": "yahoo"}
    except Exception as e:
        return {"ok": False, "detail": str(e)}
    return {"ok": False, "detail": "quote unavailable"}

# ---------------------------------------------------------------------------
# ML / RL — trained on bars the CALLER sends (the exact same resolved bars
# Time Machine / the Optimizer already use), never re-fetched server-side,
# so training data and backtest data can never silently diverge. See
# ml_engine.py for the feature pipeline, walk-forward split, and the
# from-scratch tabular Q-learning RL agent.
# ---------------------------------------------------------------------------

@app.post("/api/ml/train")
def api_ml_train(body: dict[str, Any]):
    bars = body.get("bars")
    if not isinstance(bars, list) or len(bars) < 40:
        raise HTTPException(status_code=400, detail="bars: need at least 40 OHLCV bars to train on")
    try:
        meta = ml.train_ml_model(
            bars,
            horizon=int(body.get("horizon", 3)),
            target_type=body.get("targetType", "direction"),
            model_type=body.get("modelType", "gbm"),
            train_pct=float(body.get("trainPct", 0.7)),
            symbol=body.get("symbol", ""),
            timeframe=body.get("timeframe", ""),
        )
        return {"ok": True, "model": meta}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("ml/train failed")
        raise HTTPException(status_code=500, detail=f"Training failed: {e}")

@app.post("/api/ml/predict")
def api_ml_predict(body: dict[str, Any]):
    model_id = body.get("modelId", "")
    bars = body.get("bars")
    if not model_id:
        raise HTTPException(status_code=400, detail="modelId required")
    if not isinstance(bars, list) or len(bars) == 0:
        raise HTTPException(status_code=400, detail="bars required")
    try:
        preds = ml.predict_ml_model(model_id, bars)
        return {"ok": True, "predictions": preds}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("ml/predict failed")
        raise HTTPException(status_code=500, detail=f"Prediction failed: {e}")

@app.get("/api/ml/models")
def api_ml_models():
    return {"ok": True, "models": ml.list_ml_models()}

@app.delete("/api/ml/models/{model_id}")
def api_ml_delete_model(model_id: str):
    found = ml.delete_ml_model(model_id)
    if not found:
        raise HTTPException(status_code=404, detail=f"No such model: {model_id}")
    return {"ok": True}

@app.post("/api/rl/train")
def api_rl_train(body: dict[str, Any]):
    bars = body.get("bars")
    if not isinstance(bars, list) or len(bars) < 70:
        raise HTTPException(status_code=400, detail="bars: need at least 70 OHLCV bars to train an RL policy on")
    try:
        meta = ml.train_rl_policy(
            bars,
            episodes=int(body.get("episodes", 150)),
            train_pct=float(body.get("trainPct", 0.7)),
            algorithm=body.get("algorithm", "tabular"),
            symbol=body.get("symbol", ""),
            timeframe=body.get("timeframe", ""),
        )
        return {"ok": True, "policy": meta}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("rl/train failed")
        raise HTTPException(status_code=500, detail=f"RL training failed: {e}")

@app.post("/api/rl/action")
def api_rl_action(body: dict[str, Any]):
    policy_id = body.get("policyId", "")
    bars = body.get("bars")
    if not policy_id:
        raise HTTPException(status_code=400, detail="policyId required")
    if not isinstance(bars, list) or len(bars) == 0:
        raise HTTPException(status_code=400, detail="bars required")
    try:
        actions = ml.get_rl_actions(policy_id, bars)
        return {"ok": True, "actions": actions}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("rl/action failed")
        raise HTTPException(status_code=500, detail=f"RL action inference failed: {e}")

@app.get("/api/rl/policies")
def api_rl_policies():
    return {"ok": True, "policies": ml.list_rl_policies()}

@app.delete("/api/rl/policies/{policy_id}")
def api_rl_delete_policy(policy_id: str):
    found = ml.delete_rl_policy(policy_id)
    if not found:
        raise HTTPException(status_code=404, detail=f"No such policy: {policy_id}")
    return {"ok": True}

@app.get("/api/ml/device")
def api_ml_device():
    """What the LSTM/DQN model types would actually train/infer on right
    now — ML Lab shows this so a GPU owner can confirm their card is being
    used, and a CPU-only user gets an honest "this will be slower" instead
    of a silent one."""
    return {"ok": True, **ml.get_device_info()}
