"""
DAFE Charts — Adaptive model manager.

Single source of truth for:
  * hardware detection (GPU / VRAM / RAM / CPU)
  * model discovery (scan dir, parse real GGUF architecture metadata)
  * adaptive launch-parameter computation (ctx / ngl / batch / threads)
  * model selection (user preference -> best fit for this machine)
  * probing an already-running llama-server for its real context size

Both `start.bat` (via the CLI at the bottom) and `backend/main.py` (via the
functions) use this module, so startup and hot-reload always agree.

No third-party dependencies are required. `psutil` is used if present for a
more accurate RAM reading, otherwise we fall back to the OS.

CLI usage (consumed by start.bat):
    python model_manager.py select            -> "MODEL|CTX|NGL|BATCH|THREADS"
    python model_manager.py select --json     -> full JSON plan
    python model_manager.py hardware           -> JSON hardware report
    python model_manager.py list               -> JSON list of models + plans
"""

from __future__ import annotations

import glob
import json
import os
import struct
import subprocess
import sys
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Paths (overridable via environment so the app stays portable)
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_MODELS_DIR = os.environ.get(
    "DAFE_MODELS_DIR", os.path.abspath(os.path.join(_HERE, "..", "models"))
)
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, ".."))
_HOME = os.path.expanduser("~")


def _llama_dir_guesses() -> list[str]:
    """Candidate directories for llama-server, ordered by preference. Portable."""
    guesses = [
        os.environ.get("LLAMA_DIR", ""),
        # Bundled alongside the repo (most portable for end users)
        os.path.join(_REPO_ROOT, "llama.cpp"),
        os.path.join(_REPO_ROOT, "llama"),
        os.path.join(_REPO_ROOT, "bin"),
        os.path.join(_REPO_ROOT, "llama.cpp", "build", "bin", "Release"),
        os.path.join(_REPO_ROOT, "llama.cpp", "build", "bin"),
        # Common user/system install locations
        os.path.join(_HOME, "llama.cpp"),
        os.path.join(_HOME, ".local", "bin"),
        "/usr/local/bin", "/usr/bin", "/opt/llama.cpp", "/opt/homebrew/bin",
    ]
    if os.name == "nt":
        guesses += [
            "C:\\llama.cpp", "C:\\llama.cpp\\build\\bin\\Release",
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "llama.cpp"),
            os.path.join(os.environ.get("ProgramFiles", ""), "llama.cpp"),
        ]
    return guesses


def find_llama_server() -> Optional[str]:
    """Locate the llama-server executable across common install locations."""
    exe = "llama-server.exe" if os.name == "nt" else "llama-server"
    for d in _llama_dir_guesses():
        if not d:
            continue
        p = os.path.join(d, exe)
        if os.path.exists(p):
            return os.path.abspath(p)
    # Last resort: anything on PATH (handles package-manager installs)
    from shutil import which
    found = which(exe) or which("llama-server")
    return os.path.abspath(found) if found else None


# ===========================================================================
# Hardware detection
# ===========================================================================
def _nvidia_gpus() -> list[dict[str, Any]]:
    """Return a list of NVIDIA GPUs with total + free VRAM (MB)."""
    gpus: list[dict[str, Any]] = []
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            for line in result.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 3:
                    try:
                        gpus.append({
                            "name": parts[0],
                            "vram_total_mb": int(float(parts[1])),
                            "vram_free_mb": int(float(parts[2])),
                        })
                    except ValueError:
                        continue
    except Exception:
        pass
    return gpus


def _amd_gpus() -> list[dict[str, Any]]:
    """Best-effort AMD VRAM detection via rocm-smi / amd-smi. May be empty."""
    gpus: list[dict[str, Any]] = []
    # Newer tool: amd-smi
    try:
        r = subprocess.run(["amd-smi", "metric", "-m", "--json"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            data = json.loads(r.stdout)
            for g in (data if isinstance(data, list) else [data]):
                mem = g.get("mem_usage") or g.get("vram") or {}
                total = mem.get("total_vram") or mem.get("vram_total")
                used = mem.get("used_vram") or mem.get("vram_used") or 0
                if total:
                    t = int(total); u = int(used)
                    gpus.append({"name": g.get("name", "AMD GPU"),
                                 "vram_total_mb": t, "vram_free_mb": max(0, t - u)})
            if gpus:
                return gpus
    except Exception:
        pass
    # Older tool: rocm-smi
    try:
        r = subprocess.run(["rocm-smi", "--showmeminfo", "vram", "--json"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            data = json.loads(r.stdout)
            for key, g in data.items():
                if not isinstance(g, dict):
                    continue
                total = g.get("VRAM Total Memory (B)") or g.get("vram total")
                used = g.get("VRAM Total Used Memory (B)") or 0
                if total:
                    t = int(int(total) / (1024 ** 2)); u = int(int(used) / (1024 ** 2))
                    gpus.append({"name": "AMD GPU", "vram_total_mb": t,
                                 "vram_free_mb": max(0, t - u)})
    except Exception:
        pass
    return gpus


def _apple_gpu(ram_gb: float) -> Optional[dict[str, Any]]:
    """Apple Silicon: unified memory means the GPU shares system RAM (Metal)."""
    import platform
    if platform.system() != "Darwin" or platform.machine() not in ("arm64", "aarch64"):
        return None
    name = "Apple Silicon GPU"
    try:
        r = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            name = r.stdout.strip()
    except Exception:
        pass
    # Metal can use a large share of unified memory; budget ~70% for the model.
    budget_mb = int(ram_gb * 1024 * 0.70)
    return {"name": name, "vram_total_mb": budget_mb, "vram_free_mb": budget_mb,
            "unified": True}


def detect_hardware() -> dict[str, Any]:
    """
    Detect GPU / VRAM / RAM / CPU across vendors (NVIDIA, AMD, Apple Silicon).

    Environment overrides for undetectable setups (any user can force these):
      DAFE_FORCE_GPU=1     treat as GPU-capable even if no tool reports one
      DAFE_VRAM_MB=8192    declare available VRAM in MB
      DAFE_FORCE_CPU=1     force CPU-only inference
    """
    info: dict[str, Any] = {
        "gpu": False, "gpu_name": "", "gpu_vendor": "",
        "vram_mb": 0, "vram_free_mb": 0, "vram_known": False,
        "ram_gb": 0.0, "cpu_cores": os.cpu_count() or 4,
    }

    # RAM
    try:
        import psutil  # type: ignore
        info["ram_gb"] = round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except Exception:
        try:
            if os.name == "posix" and hasattr(os, "sysconf"):
                pages = os.sysconf("SC_PHYS_PAGES")
                page_size = os.sysconf("SC_PAGE_SIZE")
                info["ram_gb"] = round(pages * page_size / (1024 ** 3), 1)
        except Exception:
            pass

    if os.environ.get("DAFE_FORCE_CPU") == "1":
        info["gpus"] = []
        return info

    # GPU detection by vendor (first hit wins, ordered by how reliably we can size it)
    gpus = _nvidia_gpus()
    vendor = "nvidia"
    if not gpus:
        amd = _amd_gpus()
        if amd:
            gpus, vendor = amd, "amd"
    if not gpus:
        apple = _apple_gpu(info["ram_gb"])
        if apple:
            gpus, vendor = [apple], "apple"

    if gpus:
        primary = max(gpus, key=lambda g: g["vram_total_mb"])
        info.update({
            "gpu": True, "gpu_vendor": vendor, "gpu_name": primary["name"],
            "vram_mb": primary["vram_total_mb"],
            "vram_free_mb": primary.get("vram_free_mb", primary["vram_total_mb"]),
            "vram_known": primary["vram_total_mb"] > 0,
            "unified": primary.get("unified", False),
        })

    # Environment overrides (escape hatch for undetected GPUs / custom rigs)
    if os.environ.get("DAFE_FORCE_GPU") == "1" and not info["gpu"]:
        info["gpu"] = True
        info["gpu_vendor"] = info["gpu_vendor"] or "unknown"
        info["gpu_name"] = info["gpu_name"] or "GPU (forced)"
    try:
        if os.environ.get("DAFE_VRAM_MB"):
            v = int(os.environ["DAFE_VRAM_MB"])
            info["vram_mb"] = v
            info["vram_free_mb"] = v
            info["vram_known"] = True
            info["gpu"] = True
    except Exception:
        pass

    info["gpus"] = gpus
    return info


# ===========================================================================
# GGUF metadata reader (minimal, dependency-free)
# ===========================================================================
# GGUF metadata value type ids
_GGUF_T_UINT8, _GGUF_T_INT8 = 0, 1
_GGUF_T_UINT16, _GGUF_T_INT16 = 2, 3
_GGUF_T_UINT32, _GGUF_T_INT32 = 4, 5
_GGUF_T_FLOAT32 = 6
_GGUF_T_BOOL = 7
_GGUF_T_STRING = 8
_GGUF_T_ARRAY = 9
_GGUF_T_UINT64, _GGUF_T_INT64 = 10, 11
_GGUF_T_FLOAT64 = 12

_SCALAR_FMT = {
    _GGUF_T_UINT8: ("<B", 1), _GGUF_T_INT8: ("<b", 1),
    _GGUF_T_UINT16: ("<H", 2), _GGUF_T_INT16: ("<h", 2),
    _GGUF_T_UINT32: ("<I", 4), _GGUF_T_INT32: ("<i", 4),
    _GGUF_T_FLOAT32: ("<f", 4), _GGUF_T_BOOL: ("<?", 1),
    _GGUF_T_UINT64: ("<Q", 8), _GGUF_T_INT64: ("<q", 8),
    _GGUF_T_FLOAT64: ("<d", 8),
}


def _read_str(f) -> str:
    (n,) = struct.unpack("<Q", f.read(8))
    return f.read(n).decode("utf-8", errors="replace")


def _read_value(f, vtype: int):
    if vtype in _SCALAR_FMT:
        fmt, size = _SCALAR_FMT[vtype]
        return struct.unpack(fmt, f.read(size))[0]
    if vtype == _GGUF_T_STRING:
        return _read_str(f)
    if vtype == _GGUF_T_ARRAY:
        (elem_type,) = struct.unpack("<I", f.read(4))
        (count,) = struct.unpack("<Q", f.read(8))
        # We never need array *contents* — skip them as cheaply as possible.
        if elem_type in _SCALAR_FMT:
            _, size = _SCALAR_FMT[elem_type]
            f.seek(size * count, os.SEEK_CUR)
        elif elem_type == _GGUF_T_STRING:
            for _ in range(count):
                (n,) = struct.unpack("<Q", f.read(8))
                f.seek(n, os.SEEK_CUR)
        return None  # arrays are not used by our sizing maths
    # Unknown type — bail.
    raise ValueError(f"unknown GGUF value type {vtype}")


def read_gguf_metadata(path: str, max_kv: int = 4096) -> dict[str, Any]:
    """Read scalar metadata from a GGUF file. Returns {} on any failure."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"GGUF":
                return {}
            struct.unpack("<I", f.read(4))  # version
            struct.unpack("<Q", f.read(8))  # tensor count
            (kv_count,) = struct.unpack("<Q", f.read(8))
            md: dict[str, Any] = {}
            for _ in range(min(kv_count, max_kv)):
                key = _read_str(f)
                (vtype,) = struct.unpack("<I", f.read(4))
                val = _read_value(f, vtype)
                if val is not None:
                    md[key] = val
            return md
    except Exception:
        return {}


# ===========================================================================
# Model discovery + architecture
# ===========================================================================
_QUANT_TOKENS = (
    "IQ1", "IQ2", "IQ3", "IQ4", "Q2_K", "Q3_K", "Q4_K", "Q5_K", "Q6_K",
    "Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q8_0", "F16", "BF16", "F32",
)


def _quant_from_name(name: str) -> str:
    up = name.upper()
    for q in _QUANT_TOKENS:
        if q in up:
            return q
    return "unknown"


def describe_model(path: str) -> dict[str, Any]:
    """Return file + architecture facts for one .gguf model."""
    name = os.path.basename(path)
    size = os.path.getsize(path)
    md = read_gguf_metadata(path)
    arch = md.get("general.architecture", "")

    def a(key: str):
        return md.get(f"{arch}.{key}") if arch else None

    n_layer = a("block_count")
    n_embd = a("embedding_length")
    n_head = a("attention.head_count")
    n_head_kv = a("attention.head_count_kv") or n_head
    train_ctx = a("context_length")

    return {
        "name": name,
        "path": os.path.abspath(path),
        "size": size,
        "size_mb": round(size / (1024 ** 2), 1),
        "size_gb": round(size / (1024 ** 3), 2),
        "arch": arch,
        "quant": _quant_from_name(name),
        "n_layer": n_layer,
        "n_embd": n_embd,
        "n_head": n_head,
        "n_head_kv": n_head_kv,
        "train_ctx": train_ctx,
        "metadata_ok": bool(arch and n_layer and n_embd),
    }


def list_models(models_dir: str = DEFAULT_MODELS_DIR) -> list[dict[str, Any]]:
    models = []
    if os.path.isdir(models_dir):
        for path in glob.glob(os.path.join(models_dir, "*.gguf")):
            try:
                models.append(describe_model(path))
            except Exception:
                continue
    models.sort(key=lambda m: m["name"].lower())
    return models


# ===========================================================================
# Adaptive launch-parameter computation
# ===========================================================================
_CTX_STEPS = [512, 1024, 1536, 2048, 3072, 4096, 6144, 8192,
              12288, 16384, 24576, 32768, 49152, 65536]
# Fixed VRAM reserve for the driver / CUDA context + base compute buffer.
_GPU_OVERHEAD_MB = 650
# The llama.cpp compute buffer grows with context + batch and fragmentation
# eats a little more, so we only spend this fraction of the KV budget on cache.
# This is the guard against the VRAM-exhaustion OOM that crashes model loads.
_KV_SAFETY = 0.85


def _snap_ctx(value: float, train_ctx: Optional[int]) -> int:
    """Snap a raw context budget to the nearest sane step.
    Rounds UP when within 15% of the next step — don't waste context."""
    cap = train_ctx if (train_ctx and train_ctx > 0) else _CTX_STEPS[-1]
    value = min(value, cap)
    best = _CTX_STEPS[0]
    for i, step in enumerate(_CTX_STEPS):
        if step > cap:
            break
        if step <= value:
            best = step
            # Check if next step is within 15% — round up
            if i + 1 < len(_CTX_STEPS):
                nxt = _CTX_STEPS[i + 1]
                if nxt <= cap and value >= nxt * 0.85:
                    best = nxt
    return min(best, cap)


def _ctx_floor_from_ram(ram_gb: float) -> int:
    """Context floor based on system RAM — llama.cpp spills KV cache to RAM."""
    if ram_gb >= 32:
        return 32768
    elif ram_gb >= 16:
        return 16384
    elif ram_gb >= 8:
        return 8192
    else:
        return 4096


def _kv_bytes_per_token(m: dict[str, Any]) -> Optional[float]:
    """KV-cache bytes per token assuming f16 cache. None if arch unknown."""
    n_layer = m.get("n_layer")
    n_embd = m.get("n_embd")
    n_head = m.get("n_head")
    n_head_kv = m.get("n_head_kv") or n_head
    if not (n_layer and n_embd and n_head and n_head_kv):
        return None
    n_embd_kv = n_embd * (n_head_kv / n_head)   # GQA shrinks the cache
    # 2 tensors (K and V) * 2 bytes (f16)
    return 4.0 * n_layer * n_embd_kv


def _cpu_threads(cpu_cores: int) -> int:
    return max(2, min(16, cpu_cores // 2 if cpu_cores >= 4 else cpu_cores))


def compute_launch_params(model: dict[str, Any],
                          hw: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """
    Compute optimal llama-server flags for `model` on `hw`.

    Returns: {ctx, ngl, batch, threads, mode, reason}
      ngl = -1 means "offload all layers".
    """
    hw = hw or detect_hardware()
    size_mb = model["size_mb"]
    train_ctx = model.get("train_ctx")
    kv_per_tok = _kv_bytes_per_token(model)
    threads = _cpu_threads(hw["cpu_cores"])

    # ---- No usable GPU -> CPU inference -------------------------------------
    if not hw.get("gpu"):
        ram = hw.get("ram_gb", 0)
        if ram >= 32:
            ctx = min(train_ctx or 32768, 32768)
        elif ram >= 16:
            ctx = min(train_ctx or 16384, 16384)
        elif ram >= 8:
            ctx = min(train_ctx or 8192, 8192)
        else:
            ctx = min(train_ctx or 4096, 4096)
        ctx = _snap_ctx(ctx, train_ctx)
        return {
            "ctx": ctx, "ngl": 0, "batch": 256, "threads": threads,
            "mode": "cpu",
            "reason": f"CPU-only ({hw['cpu_cores']} cores, {ram}GB RAM)",
        }

    # ---- GPU path -----------------------------------------------------------
    free = hw.get("vram_free_mb") or 0
    total = hw.get("vram_mb") or 0

    # GPU present but VRAM size unknown (forced GPU, some AMD/Intel setups):
    # offload all layers and pick a context tiered by model size + trained ctx.
    if not hw.get("vram_known") and total <= 256:
        if size_mb < 3000:
            raw = min(train_ctx or 32768, 16384)
        elif size_mb < 8000:
            raw = min(train_ctx or 16384, 8192)
        else:
            raw = min(train_ctx or 8192, 4096)
        ctx = _snap_ctx(max(raw, _ctx_floor_from_ram(hw.get("ram_gb", 0) or 0)), train_ctx)
        return {
            "ctx": ctx, "ngl": -1, "batch": 256, "threads": threads,
            "mode": "gpu-unsized",
            "reason": (f"{hw.get('gpu_name','GPU')} (VRAM unknown) — full offload, "
                       f"{ctx} ctx (set DAFE_VRAM_MB to tune)"),
        }

    # Prefer measured free VRAM; fall back to 90% of total if free is unknown.
    avail = free if free > 256 else int(total * 0.90)
    usable = max(0, avail - _GPU_OVERHEAD_MB)

    # Weights fit fully on the GPU -> offload everything, size ctx to fit KV.
    if size_mb <= usable * 0.95:
        kv_budget_mb = (usable - size_mb) * _KV_SAFETY
        if kv_per_tok:
            raw_ctx = (kv_budget_mb * 1024 * 1024) / kv_per_tok
        else:
            # No arch metadata: tier the ctx off remaining VRAM headroom.
            raw_ctx = 16384 if kv_budget_mb > 3000 else 8192 if kv_budget_mb > 1500 else 4096
        # Floor: llama.cpp spills KV cache to system RAM, so context must not be
        # starved just because VRAM headroom is tight.
        ram_floor = _ctx_floor_from_ram(hw.get("ram_gb", 0) or 0)
        ctx = _snap_ctx(max(raw_ctx, ram_floor), train_ctx)
        batch = 512 if usable - size_mb > 2000 else 256
        return {
            "ctx": ctx, "ngl": -1, "batch": batch, "threads": threads,
            "mode": "gpu-full",
            "reason": (f"{hw['gpu_name']} {avail}MB free — full offload, "
                       f"{ctx} ctx (VRAM-KV: ~{int(raw_ctx)}, spills to RAM)"),
        }

    # Weights exceed VRAM -> partial offload. Size context from remaining VRAM.
    n_layer = model.get("n_layer") or 32
    layer_mb = size_mb / n_layer
    layer_budget = usable
    ngl = int(max(0, layer_budget // layer_mb)) if layer_mb > 0 else 0
    ngl = min(ngl, n_layer)

    # KV cache lives on GPU for offloaded layers — budget from leftover VRAM
    kv_reserve_mb = max(128, (usable - (ngl * layer_mb)) * _KV_SAFETY)
    if kv_per_tok and kv_reserve_mb > 0:
        target_ctx = (kv_reserve_mb * 1024 * 1024) / kv_per_tok
    else:
        target_ctx = 16384 if kv_reserve_mb > 2000 else 8192 if kv_reserve_mb > 800 else 4096 if kv_reserve_mb > 300 else 2048
    ram_floor = _ctx_floor_from_ram(hw.get("ram_gb", 0) or 0)
    target_ctx = _snap_ctx(max(target_ctx, ram_floor), train_ctx)

    if ngl <= 0:
        # Nothing fits on the GPU — run on CPU but keep ctx modest.
        return {
            "ctx": _snap_ctx(4096, train_ctx), "ngl": 0,
            "batch": 256, "threads": threads, "mode": "cpu-fallback",
            "reason": (f"{hw['gpu_name']} {avail}MB free too small for "
                       f"{size_mb:.0f}MB model — CPU fallback"),
        }

    return {
        "ctx": target_ctx, "ngl": ngl, "batch": 256, "threads": threads,
        "mode": "gpu-partial",
        "reason": (f"{hw['gpu_name']} {avail}MB free — partial offload "
                   f"{ngl}/{n_layer} layers"),
    }


# ===========================================================================
# Model selection
# ===========================================================================
def _matches_preference(model: dict[str, Any], pref: str) -> bool:
    if not pref or pref == "auto":
        return False
    stem = pref.replace(".gguf", "").lower()
    return stem in model["name"].replace(".gguf", "").lower()


def pick_model(models_dir: str = DEFAULT_MODELS_DIR,
               preference: str = "auto",
               hw: Optional[dict[str, Any]] = None) -> Optional[dict[str, Any]]:
    """
    Choose the best model for this machine.

    Order of preference:
      1. A model matching the user's saved `preference`.
      2. Otherwise, the largest model whose weights fully fit in VRAM/RAM
         (most capable that still runs fast), else the smallest available.
    """
    models = list_models(models_dir)
    if not models:
        return None

    if preference and preference != "auto":
        for m in models:
            if _matches_preference(m, preference):
                return m

    hw = hw or detect_hardware()
    if hw.get("gpu"):
        free = hw.get("vram_free_mb") or 0
        total = hw.get("vram_mb") or 0
        budget = (free if free > 256 else int(total * 0.90)) - _GPU_OVERHEAD_MB
    else:
        budget = hw.get("ram_gb", 0) * 1024 * 0.6  # leave RAM for the OS/app

    fits = [m for m in models if m["size_mb"] <= budget]
    if fits:
        # Largest that still fits = most capable without spilling.
        return max(fits, key=lambda m: m["size"])
    # Nothing fits cleanly — pick the smallest so it at least loads.
    return min(models, key=lambda m: m["size"])


def plan_for(models_dir: str = DEFAULT_MODELS_DIR,
             preference: str = "auto") -> Optional[dict[str, Any]]:
    """Full launch plan: chosen model + computed params for this machine."""
    hw = detect_hardware()
    model = pick_model(models_dir, preference, hw)
    if not model:
        return None
    params = compute_launch_params(model, hw)
    return {"model": model, "params": params, "hardware": hw}


# ===========================================================================
# Probe an already-running llama-server (so the backend can "adopt" it)
# ===========================================================================
def probe_running(port: int, timeout: float = 2.0) -> Optional[dict[str, Any]]:
    """
    Query a live llama-server for its real model + context size.
    Returns {model_name, ctx, port} or None if nothing is answering.
    """
    import urllib.request

    base = f"http://127.0.0.1:{port}"
    # Must be healthy first.
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=timeout) as r:
            if b"ok" not in r.read():
                return None
    except Exception:
        return None

    model_name, ctx = "", 0
    supports_thinking = False
    try:
        with urllib.request.urlopen(f"{base}/props", timeout=timeout) as r:
            props = json.loads(r.read().decode("utf-8", errors="replace"))
        mp = props.get("model_path") or props.get("model") or ""
        if mp:
            model_name = os.path.basename(str(mp))
        gen = props.get("default_generation_settings") or {}
        ctx = int(gen.get("n_ctx") or props.get("n_ctx") or 0)
        # Detect thinking/reasoning capability from the model's OWN chat
        # template instead of guessing from its filename — works for any
        # model family (Qwen3, DeepSeek-R1, QwQ, future reasoning models)
        # rather than only ones with "qwen"/"think" in the name.
        chat_template = str(props.get("chat_template", ""))
        supports_thinking = any(marker in chat_template for marker in (
            "<think>", "enable_thinking", "reasoning_content", "</think>",
        ))
    except Exception:
        pass
    return {"model_name": model_name, "ctx": ctx, "port": port, "supports_thinking": supports_thinking}


def server_health(port: int, timeout: float = 2.0) -> str:
    """
    Liveness probe that distinguishes loading from ready.
    Returns 'ready', 'loading' (HTTP 503 while weights load), or 'down'.
    """
    import urllib.request
    import urllib.error
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            return "ready" if b"ok" in r.read() else "loading"
    except urllib.error.HTTPError as e:
        # llama.cpp returns 503 with {"status":"loading model"} during load.
        return "loading" if e.code in (503, 500) else "down"
    except Exception:
        return "down"


def kill_llama_server(port: Optional[int] = None,
                      pid: Optional[int] = None,
                      wait_release: float = 0.0) -> None:
    """
    Robustly stop a running llama-server AND its host console window.

    This handles BOTH ways the server gets launched:
      * start.bat:  `start "llama-server" cmd /k "... llama-server.exe ..."`
        -> a cmd.exe wrapper whose window survives after the child dies, and
           whose title llama-server overwrites (so title-matching fails). We
           match it by command line instead.
      * hot-reload: `Popen(llama-server.exe, CREATE_NEW_CONSOLE)`
        -> we know its exact PID, so kill the whole tree.
    """
    def _run(args):
        try:
            subprocess.run(args, capture_output=True, timeout=12)
        except Exception:
            pass

    if os.name == "nt":
        # 1. Exact PID tree (covers hot-reload-launched console + child).
        if pid:
            _run(["taskkill", "/F", "/T", "/PID", str(pid)])
        # 2. The cmd.exe wrapper from start.bat — matched by command line, not
        #    by window title (llama-server overwrites the title).
        _run(["powershell", "-NoProfile", "-Command",
              "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | "
              "Where-Object { $_.CommandLine -like '*llama-server*' } | "
              "ForEach-Object { Stop-Process -Id $_.ProcessId -Force "
              "-ErrorAction SilentlyContinue }"])
        # 3. Any remaining llama-server.exe instances.
        _run(["taskkill", "/F", "/IM", "llama-server.exe"])
        # 4. Whatever still owns the port.
        if port:
            _run(["powershell", "-NoProfile", "-Command",
                  f"Get-NetTCPConnection -LocalPort {port} -State Listen "
                  "-ErrorAction SilentlyContinue | ForEach-Object { Stop-Process "
                  "-Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"])
    else:
        if pid:
            _run(["kill", "-9", str(pid)])
        _run(["pkill", "-9", "-f", "llama-server"])

    if wait_release:
        import time as _t
        _t.sleep(wait_release)


# ===========================================================================
# CLI (consumed by start.bat / start-llama.bat)
# ===========================================================================
def _saved_preference() -> str:
    """Read the saved trade-advisor model preference from settings.json."""
    path = os.path.join(_HERE, "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f).get("llm_trade_advisor_model", "auto") or "auto"
    except Exception:
        return "auto"


def _cli(argv: list[str]) -> int:
    cmd = argv[0] if argv else "select"
    want_json = "--json" in argv
    models_dir = DEFAULT_MODELS_DIR
    # Optional preference passed positionally: `select <pref>`.
    # If omitted, fall back to the saved settings.json preference.
    pref = ""
    for a in argv[1:]:
        if not a.startswith("--"):
            pref = a
    if not pref:
        pref = _saved_preference()

    if cmd == "hardware":
        print(json.dumps(detect_hardware(), indent=2 if want_json else None))
        return 0

    if cmd == "llama-path":
        exe = find_llama_server()
        print(exe or "")
        return 0 if exe else 1

    if cmd == "models-dir":
        print(DEFAULT_MODELS_DIR)
        return 0

    if cmd == "list":
        hw = detect_hardware()
        out = [{"model": m, "params": compute_launch_params(m, hw)}
               for m in list_models(models_dir)]
        print(json.dumps({"hardware": hw, "models": out}, indent=2))
        return 0

    # default: select
    plan = plan_for(models_dir, pref)
    if not plan:
        # Pipe-delimited sentinel that start.bat understands.
        if not want_json:
            print("NONE|0|0|0|0")
        else:
            print(json.dumps({"ok": False, "detail": "no models found"}))
        return 1

    p = plan["params"]
    m = plan["model"]
    if want_json:
        print(json.dumps(plan, indent=2))
    else:
        # MODEL|CTX|NGL|BATCH|THREADS  — single line, batch-friendly.
        print(f"{m['name']}|{p['ctx']}|{p['ngl']}|{p['batch']}|{p['threads']}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
