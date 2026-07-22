"""
DAFE Charts — ML / RL Engine.

Four genuine, from-real-data capabilities, sharing one feature pipeline:

  1. Supervised ML signal models — gradient boosting / a real 2-hidden-layer
     MLP / logistic regression (scikit-learn), OR a real LSTM (PyTorch) —
     predicting next-H-bar direction or return from OHLCV-derived features.
     Exposed to OakScript as ml.predict(modelId).
  2. Reinforcement learning trading policies — a from-scratch tabular
     Q-learning agent, OR a real Deep Q-Network (PyTorch) — genuine RL
     either way: the agent never sees a labeled "correct" action, only a
     reward signal (mark-to-market P&L) from acting against the SAME
     historical bars the backtester replays. Exposed as rl.action(policyId).

Every model/policy type splits data chronologically (train = first
train_pct of bars, validate = the rest) — never shuffled, which would leak
future bars into training the same way it would corrupt the backtester's
in-sample/out-of-sample split — and reports every metric next to a naive
baseline (majority-class accuracy, zero-change MAE, always-flat/always-long
return) so a model that learned nothing real is visible as such, not
dressed up by a lonely number.

TIERED BY DESIGN, not GPU-gated: gradient boosting / MLP / logistic /
tabular Q-learning are classical, CPU-fast, and often just as accurate as a
deep model on this much tabular data — legitimate choices on any machine,
not merely "fallbacks" for underpowered ones. The LSTM and DQN are real
PyTorch neural nets (sequence-aware windowing for the LSTM; a continuous,
undiscretized state for the DQN, removing the tabular agent's fixed
state-space ceiling) that benefit from a CUDA GPU when one is present —
device is picked automatically (see get_device_info()/_device()) and both
still train and run correctly, just slower, on CPU-only machines. torch is
imported behind a TORCH_AVAILABLE guard so a backend without it installed
keeps every classical/tabular path fully working; only the two deep model
types become unavailable, with a clear error instead of a crash.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Literal, Optional

import numpy as np

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml_models")
POLICIES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rl_policies")
os.makedirs(MODELS_DIR, exist_ok=True)
os.makedirs(POLICIES_DIR, exist_ok=True)

FEATURE_NAMES = [
    "ret_1", "ret_3", "ret_5", "ret_10",
    "vol_10", "vol_20",
    "rsi_14", "macd_hist", "ema_spread",
    "vol_ratio", "hl_range", "close_pos",
]

# ---------------------------------------------------------------------------
# Deep learning setup — guarded torch import + device selection.
# Every deep code path below checks TORCH_AVAILABLE (and raises a clear,
# actionable error if it's False) before touching `torch`/`nn` at all, so a
# backend that never installed torch never sees a raw ImportError/NameError
# — it just can't offer the two deep model types.
# ---------------------------------------------------------------------------
try:
    import torch
    import torch.nn as nn
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False


def get_device_info() -> dict[str, Any]:
    """What the deep (LSTM/DQN) paths would train/infer on right now — the
    UI surfaces this directly so a user on a lower-end machine sees an
    honest "CPU, will be slower" note instead of a silent slowdown, and a
    GPU owner sees confirmation their card is actually being used."""
    if not TORCH_AVAILABLE:
        return {"torchAvailable": False, "device": "cpu", "deviceName": "PyTorch not installed on this backend"}
    if torch.cuda.is_available():
        return {"torchAvailable": True, "device": "cuda", "deviceName": torch.cuda.get_device_name(0)}
    return {"torchAvailable": True, "device": "cpu", "deviceName": "CPU (no CUDA GPU detected)"}


def _device():
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _require_torch(feature: str) -> None:
    if not TORCH_AVAILABLE:
        raise ValueError(
            f"{feature} requires PyTorch, which isn't installed on this backend. "
            "Use one of the classical options instead (Gradient Boosting / Neural "
            "Net (MLP) / Logistic-Ridge for ml.predict, Tabular Q-Learning for "
            "rl.action) — they need no extra dependency and are often just as "
            "accurate on this much data. To enable the deep options, `pip install "
            "torch` (see backend/requirements.txt)."
        )


if TORCH_AVAILABLE:
    class LSTMPredictor(nn.Module):
        """A real backprop-trained recurrent net: consumes a sliding window
        of the last N bars' feature vectors (not just the current bar, the
        way the classical models do) and predicts from the window's final
        hidden state. Returns a raw logit — callers apply sigmoid for
        direction models, use the value as-is for return models."""

        def __init__(self, input_size: int, hidden_size: int = 32):
            super().__init__()
            self.lstm = nn.LSTM(input_size, hidden_size, num_layers=1, batch_first=True)
            self.head = nn.Linear(hidden_size, 1)

        def forward(self, x):
            _, (h_n, _) = self.lstm(x)
            return self.head(h_n[-1])

    class DQNNet(nn.Module):
        """Small feed-forward Q(s,a) approximator. Unlike the tabular
        agent, the state is the full continuous feature vector — no
        quantile binning, so no fixed state-space ceiling to size."""

        def __init__(self, input_size: int, n_actions: int, hidden_size: int = 64):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(input_size, hidden_size), nn.ReLU(),
                nn.Linear(hidden_size, hidden_size), nn.ReLU(),
                nn.Linear(hidden_size, n_actions),
            )

        def forward(self, x):
            return self.net(x)

    class _ReplayBuffer:
        """Fixed-capacity ring buffer of (s, a, r, s', done) transitions —
        sampling random past transitions to train on (instead of only the
        most recent one) is what makes DQN training stable."""

        def __init__(self, capacity: int, seed: int = 42):
            self.capacity = capacity
            self.buf: list[tuple] = []
            self.pos = 0
            self.rng = np.random.default_rng(seed)

        def push(self, s, a, r, s_next, done) -> None:
            item = (s, a, r, s_next, done)
            if len(self.buf) < self.capacity:
                self.buf.append(item)
            else:
                self.buf[self.pos] = item
            self.pos = (self.pos + 1) % self.capacity

        def sample(self, batch_size: int) -> list[tuple]:
            idx = self.rng.integers(0, len(self.buf), size=min(batch_size, len(self.buf)))
            return [self.buf[i] for i in idx]

        def __len__(self) -> int:
            return len(self.buf)


# ---------------------------------------------------------------------------
# Shared feature engineering
# ---------------------------------------------------------------------------

def _ema(values: np.ndarray, span: int) -> np.ndarray:
    alpha = 2.0 / (span + 1.0)
    out = np.empty_like(values, dtype=np.float64)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def _rsi(close: np.ndarray, length: int = 14) -> np.ndarray:
    n = len(close)
    out = np.full(n, 50.0)
    if n < length + 1:
        return out
    deltas = np.diff(close)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = np.mean(gains[:length])
    avg_loss = np.mean(losses[:length])
    for i in range(length, n):
        if i > length:
            g = gains[i - 1]
            l = losses[i - 1]
            avg_gain = (avg_gain * (length - 1) + g) / length
            avg_loss = (avg_loss * (length - 1) + l) / length
        rs = avg_gain / avg_loss if avg_loss > 1e-12 else np.inf
        out[i] = 100.0 - (100.0 / (1.0 + rs)) if np.isfinite(rs) else 100.0
    return out


def build_features(bars: list[dict[str, Any]]) -> tuple[np.ndarray, list[str], int]:
    """Returns (features[n_bars, n_features], feature_names, warmup_bars).

    Rows before `warmup_bars` are computed from whatever partial history is
    available (not NaN) — good enough as a neutral-ish signal, but callers
    doing TRAINING should drop them (see build_targets/split) so the model
    never learns from noisy warmup rows.
    """
    n = len(bars)
    close = np.array([float(b["close"]) for b in bars], dtype=np.float64)
    high = np.array([float(b["high"]) for b in bars], dtype=np.float64)
    low = np.array([float(b["low"]) for b in bars], dtype=np.float64)
    volume = np.array([float(b.get("volume", 0) or 0) for b in bars], dtype=np.float64)

    feats = np.zeros((n, len(FEATURE_NAMES)), dtype=np.float64)

    def pct_ret(lag: int) -> np.ndarray:
        out = np.zeros(n)
        if n > lag:
            prev = close[:-lag] if lag > 0 else close
            out[lag:] = (close[lag:] - close[:-lag]) / np.where(close[:-lag] != 0, close[:-lag], 1.0)
        return out

    feats[:, 0] = pct_ret(1)
    feats[:, 1] = pct_ret(3)
    feats[:, 2] = pct_ret(5)
    feats[:, 3] = pct_ret(10)

    ret1 = feats[:, 0]
    for i, win in enumerate((10, 20)):
        col = 4 + i
        for t in range(n):
            lo = max(0, t - win + 1)
            feats[t, col] = float(np.std(ret1[lo:t + 1])) if t - lo >= 1 else 0.0

    feats[:, 6] = (_rsi(close, 14) - 50.0) / 50.0  # normalized to roughly [-1, 1]
    ema12 = _ema(close, 12)
    ema26 = _ema(close, 26)
    macd_line = ema12 - ema26
    macd_signal = _ema(macd_line, 9)
    macd_hist = macd_line - macd_signal
    feats[:, 7] = np.divide(macd_hist, close, out=np.zeros(n), where=close != 0)

    ema9 = _ema(close, 9)
    ema21 = _ema(close, 21)
    feats[:, 8] = np.divide(ema9 - ema21, close, out=np.zeros(n), where=close != 0)

    vol_avg20 = np.zeros(n)
    for t in range(n):
        lo = max(0, t - 19)
        vol_avg20[t] = float(np.mean(volume[lo:t + 1]))
    feats[:, 9] = np.divide(volume, vol_avg20, out=np.ones(n), where=vol_avg20 > 1e-9)

    hl = high - low
    feats[:, 10] = np.divide(hl, close, out=np.zeros(n), where=close != 0)
    feats[:, 11] = np.divide(close - low, hl, out=np.full(n, 0.5), where=hl > 1e-9)

    warmup = min(n, 26)  # MACD's slowest EMA needs the most bars to be meaningful
    return feats, FEATURE_NAMES, warmup


def build_targets(close: np.ndarray, horizon: int, target_type: Literal["direction", "return"]) -> np.ndarray:
    """NaN for the last `horizon` rows (no future bar to grade against yet)."""
    n = len(close)
    out = np.full(n, np.nan)
    if n <= horizon:
        return out
    fwd_ret = (close[horizon:] - close[:-horizon]) / np.where(close[:-horizon] != 0, close[:-horizon], 1.0)
    out[:-horizon] = (fwd_ret > 0).astype(np.float64) if target_type == "direction" else fwd_ret
    return out


def _chrono_split(n_valid_rows: int, train_pct: float) -> int:
    return max(1, min(n_valid_rows - 1, int(round(n_valid_rows * train_pct))))


# ---------------------------------------------------------------------------
# Supervised ML models
# ---------------------------------------------------------------------------

def _make_ml_estimator(model_type: str, target_type: str):
    if target_type == "direction":
        if model_type == "gbm":
            from sklearn.ensemble import GradientBoostingClassifier
            return GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=42)
        if model_type == "mlp":
            from sklearn.neural_network import MLPClassifier
            return MLPClassifier(hidden_layer_sizes=(32, 16), max_iter=500, random_state=42, early_stopping=True)
        from sklearn.linear_model import LogisticRegression
        return LogisticRegression(max_iter=1000)
    else:
        if model_type == "gbm":
            from sklearn.ensemble import GradientBoostingRegressor
            return GradientBoostingRegressor(n_estimators=100, max_depth=3, random_state=42)
        if model_type == "mlp":
            from sklearn.neural_network import MLPRegressor
            return MLPRegressor(hidden_layer_sizes=(32, 16), max_iter=500, random_state=42, early_stopping=True)
        from sklearn.linear_model import Ridge
        return Ridge()


# Bars of lookback the LSTM sees per prediction, on top of the usual
# feature warmup (see build_features) — the entire reason to reach for an
# LSTM instead of a classical model is this window: a classical model only
# ever sees the CURRENT bar's feature snapshot.
LSTM_WINDOW = 20
LSTM_HIDDEN_SIZE = 32
LSTM_MAX_EPOCHS = 60
LSTM_PATIENCE = 8
LSTM_BATCH_SIZE = 64


def _train_lstm_model(
    bars: list[dict[str, Any]], horizon: int, target_type: str, train_pct: float,
    symbol: str, timeframe: str,
) -> dict[str, Any]:
    _require_torch("The LSTM model type")
    from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, r2_score, mean_absolute_error

    close = np.array([float(b["close"]) for b in bars], dtype=np.float64)
    feats, names, base_warmup = build_features(bars)
    targets = build_targets(close, horizon, target_type)
    window = LSTM_WINDOW
    warmup = max(base_warmup, window - 1)

    valid = np.arange(warmup, len(bars) - horizon)
    if len(valid) < 60:
        raise ValueError(
            f"Not enough bars after warmup/horizon to train an LSTM (have {len(valid)}, "
            f"need >=60 — the LSTM needs a {window}-bar lookback window on top of the usual warmup)."
        )
    split = _chrono_split(len(valid), train_pct)
    train_idx, val_idx = valid[:split], valid[split:]
    if len(val_idx) < 5:
        raise ValueError("Validation slice too small — use more bars or a lower train %.")

    feat_mean = feats[train_idx].mean(axis=0)
    feat_std = feats[train_idx].std(axis=0)
    feat_std[feat_std < 1e-8] = 1.0
    feats_n = (feats - feat_mean) / feat_std

    def make_sequences(idxs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        X = np.stack([feats_n[t - window + 1: t + 1] for t in idxs]).astype(np.float32)
        y = targets[idxs].astype(np.float32)
        return X, y

    X_train, y_train = make_sequences(train_idx)
    X_val, y_val = make_sequences(val_idx)

    device = _device()
    model = LSTMPredictor(input_size=len(FEATURE_NAMES), hidden_size=LSTM_HIDDEN_SIZE).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.BCEWithLogitsLoss() if target_type == "direction" else nn.MSELoss()

    Xt, yt = torch.tensor(X_train, device=device), torch.tensor(y_train, device=device)
    Xv, yv = torch.tensor(X_val, device=device), torch.tensor(y_val, device=device)

    best_val_loss, best_state, bad_epochs = float("inf"), None, 0
    gen = torch.Generator().manual_seed(42)
    n_train = Xt.shape[0]
    for _epoch in range(LSTM_MAX_EPOCHS):
        model.train()
        perm = torch.randperm(n_train, generator=gen)  # SGD batch order only — the
        # chronological train/val SPLIT above is what prevents lookahead; shuffling
        # which training window a batch sees next doesn't expose validation-period data.
        for i in range(0, n_train, LSTM_BATCH_SIZE):
            idx = perm[i:i + LSTM_BATCH_SIZE]
            opt.zero_grad()
            loss = loss_fn(model(Xt[idx]).squeeze(-1), yt[idx])
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            val_loss = loss_fn(model(Xv).squeeze(-1), yv).item()
        if val_loss < best_val_loss - 1e-5:
            best_val_loss, best_state, bad_epochs = val_loss, {k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            bad_epochs += 1
            if bad_epochs >= LSTM_PATIENCE:
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()

    def score_fn(X_batch: np.ndarray) -> tuple[float, np.ndarray]:
        with torch.no_grad():
            raw = model(torch.tensor(X_batch, device=device)).squeeze(-1)
            if target_type == "direction":
                pred = (torch.sigmoid(raw).cpu().numpy() >= 0.5).astype(np.float64)
                return float(np.mean(pred != y_val)), pred
            pred = raw.cpu().numpy()
            return float(np.mean(np.abs(pred - y_val))), pred

    base_score, val_pred = score_fn(X_val)

    metrics: dict[str, Any] = {}
    if target_type == "direction":
        majority = 1.0 if np.mean(y_train) >= 0.5 else 0.0
        baseline_acc = float(np.mean(y_val == majority))
        metrics = {
            "accuracy": float(accuracy_score(y_val, val_pred)),
            "precision": float(precision_score(y_val, val_pred, zero_division=0)),
            "recall": float(recall_score(y_val, val_pred, zero_division=0)),
            "f1": float(f1_score(y_val, val_pred, zero_division=0)),
            "baselineAccuracy": baseline_acc,
            "baselineLabel": "majority class",
        }
    else:
        baseline_mae = float(np.mean(np.abs(y_val)))
        metrics = {
            "r2": float(r2_score(y_val, val_pred)),
            "mae": float(mean_absolute_error(y_val, val_pred)),
            "baselineMae": baseline_mae,
            "baselineLabel": "always predict 0% change",
        }

    # Manual permutation importance — sklearn's helper needs a fit/predict
    # estimator; this shuffles one feature across the whole window/batch and
    # measures how much the (unshuffled) baseline score degrades.
    rng = np.random.default_rng(42)
    importances = []
    for fi in range(len(names)):
        drops = []
        for _ in range(4):
            Xp = X_val.copy()
            perm = rng.permutation(Xp.shape[0])
            Xp[:, :, fi] = Xp[perm, :, fi]
            drops.append(score_fn(Xp)[0] - base_score)
        importances.append(float(np.mean(drops)))
    feature_importances = sorted(
        [{"feature": n, "importance": imp} for n, imp in zip(names, importances)],
        key=lambda r: -abs(r["importance"]),
    )

    model_id = f"ml_{uuid.uuid4().hex[:10]}"
    torch.save(model.state_dict(), os.path.join(MODELS_DIR, f"{model_id}.pt"))
    meta = {
        "id": model_id, "symbol": symbol, "timeframe": timeframe,
        "horizon": horizon, "targetType": target_type, "modelType": "lstm",
        "trainPct": train_pct, "trainRows": int(len(train_idx)), "valRows": int(len(val_idx)),
        "warmupBars": int(warmup), "createdAt": time.time(),
        "metrics": metrics, "featureImportances": feature_importances,
        "lstmWindow": window, "lstmHiddenSize": LSTM_HIDDEN_SIZE,
        "featMean": feat_mean.tolist(), "featStd": feat_std.tolist(),
        "device": get_device_info()["device"],
    }
    with open(os.path.join(MODELS_DIR, f"{model_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def _predict_lstm_model(model_id: str, bars: list[dict[str, Any]], meta: dict[str, Any]) -> list[float]:
    _require_torch("This model")
    window = meta["lstmWindow"]
    warmup = meta["warmupBars"]
    target_type = meta["targetType"]
    feat_mean = np.array(meta["featMean"])
    feat_std = np.array(meta["featStd"])

    feats, _, _ = build_features(bars)
    n = len(bars)
    out = [0.5 if target_type == "direction" else 0.0] * n
    if n <= warmup:
        return out

    device = _device()
    model = LSTMPredictor(input_size=len(FEATURE_NAMES), hidden_size=meta["lstmHiddenSize"]).to(device)
    model.load_state_dict(torch.load(os.path.join(MODELS_DIR, f"{model_id}.pt"), map_location=device))
    model.eval()

    feats_n = (feats - feat_mean) / feat_std
    idxs = list(range(warmup, n))
    X = np.stack([feats_n[t - window + 1: t + 1] for t in idxs]).astype(np.float32)
    with torch.no_grad():
        raw = model(torch.tensor(X, device=device)).squeeze(-1)
        preds = (torch.sigmoid(raw) if target_type == "direction" else raw).cpu().numpy()
    for i, t in enumerate(idxs):
        out[t] = float(preds[i])
    return out


def train_ml_model(
    bars: list[dict[str, Any]],
    horizon: int = 3,
    target_type: Literal["direction", "return"] = "direction",
    model_type: Literal["gbm", "mlp", "logistic", "lstm"] = "gbm",
    train_pct: float = 0.7,
    symbol: str = "",
    timeframe: str = "",
) -> dict[str, Any]:
    if model_type == "lstm":
        return _train_lstm_model(bars, horizon, target_type, train_pct, symbol, timeframe)

    from sklearn.preprocessing import StandardScaler
    from sklearn.inspection import permutation_importance
    from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, r2_score, mean_absolute_error

    close = np.array([float(b["close"]) for b in bars], dtype=np.float64)
    feats, names, warmup = build_features(bars)
    targets = build_targets(close, horizon, target_type)

    valid = np.arange(warmup, len(bars) - horizon)
    if len(valid) < 30:
        raise ValueError(f"Not enough bars after warmup/horizon to train (have {len(valid)}, need >=30).")

    X = feats[valid]
    y = targets[valid]
    split = _chrono_split(len(valid), train_pct)
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]
    if len(X_val) < 5:
        raise ValueError("Validation slice too small — use more bars or a lower train %.")

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_val_s = scaler.transform(X_val)

    model = _make_ml_estimator(model_type, target_type)
    model.fit(X_train_s, y_train)

    metrics: dict[str, Any] = {}
    if target_type == "direction":
        pred = model.predict(X_val_s)
        majority = 1.0 if np.mean(y_train) >= 0.5 else 0.0
        baseline_acc = float(np.mean(y_val == majority))
        metrics = {
            "accuracy": float(accuracy_score(y_val, pred)),
            "precision": float(precision_score(y_val, pred, zero_division=0)),
            "recall": float(recall_score(y_val, pred, zero_division=0)),
            "f1": float(f1_score(y_val, pred, zero_division=0)),
            "baselineAccuracy": baseline_acc,
            "baselineLabel": "majority class",
        }
    else:
        pred = model.predict(X_val_s)
        baseline_mae = float(np.mean(np.abs(y_val)))  # MAE of always predicting 0 change
        metrics = {
            "r2": float(r2_score(y_val, pred)),
            "mae": float(mean_absolute_error(y_val, pred)),
            "baselineMae": baseline_mae,
            "baselineLabel": "always predict 0% change",
        }

    try:
        pi = permutation_importance(model, X_val_s, y_val, n_repeats=8, random_state=42)
        importances = [float(v) for v in pi.importances_mean]
    except Exception:
        importances = [0.0] * len(names)
    feature_importances = sorted(
        [{"feature": n, "importance": imp} for n, imp in zip(names, importances)],
        key=lambda r: -abs(r["importance"]),
    )

    model_id = f"ml_{uuid.uuid4().hex[:10]}"
    import joblib
    joblib.dump({"scaler": scaler, "model": model, "feature_names": names}, os.path.join(MODELS_DIR, f"{model_id}.joblib"))
    meta = {
        "id": model_id, "symbol": symbol, "timeframe": timeframe,
        "horizon": horizon, "targetType": target_type, "modelType": model_type,
        "trainPct": train_pct, "trainRows": int(len(X_train)), "valRows": int(len(X_val)),
        "warmupBars": int(warmup), "createdAt": time.time(),
        "metrics": metrics, "featureImportances": feature_importances,
        "device": "cpu",
    }
    with open(os.path.join(MODELS_DIR, f"{model_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def predict_ml_model(model_id: str, bars: list[dict[str, Any]]) -> list[float]:
    json_path = os.path.join(MODELS_DIR, f"{model_id}.json")
    if not os.path.exists(json_path):
        raise FileNotFoundError(f"No such model: {model_id}")
    with open(json_path) as f:
        meta = json.load(f)
    if meta.get("modelType") == "lstm":
        return _predict_lstm_model(model_id, bars, meta)

    import joblib
    path = os.path.join(MODELS_DIR, f"{model_id}.joblib")
    bundle = joblib.load(path)
    scaler, model, names = bundle["scaler"], bundle["model"], bundle["feature_names"]
    warmup = meta["warmupBars"]
    target_type = meta["targetType"]

    feats, _, _ = build_features(bars)
    n = len(bars)
    out = [0.5 if target_type == "direction" else 0.0] * n
    if n <= warmup:
        return out
    X = feats[warmup:]
    X_s = scaler.transform(X)
    if target_type == "direction" and hasattr(model, "predict_proba"):
        preds = model.predict_proba(X_s)[:, 1]
    else:
        preds = model.predict(X_s)
    for i, v in enumerate(preds):
        out[warmup + i] = float(v)
    return out


def list_ml_models() -> list[dict[str, Any]]:
    out = []
    for fn in sorted(os.listdir(MODELS_DIR)):
        if fn.endswith(".json"):
            with open(os.path.join(MODELS_DIR, fn)) as f:
                out.append(json.load(f))
    out.sort(key=lambda m: -m.get("createdAt", 0))
    return out


def delete_ml_model(model_id: str) -> bool:
    found = False
    for ext in (".joblib", ".pt", ".json"):
        p = os.path.join(MODELS_DIR, f"{model_id}{ext}")
        if os.path.exists(p):
            os.remove(p)
            found = True
    return found


# ---------------------------------------------------------------------------
# Reinforcement learning — tabular Q-learning, or a Deep Q-Network
# ---------------------------------------------------------------------------
# Genuine RL either way: the agent is never told the "right" action. It only
# ever sees a per-step reward (mark-to-market P&L on the position its action
# implies, minus a small transaction-cost penalty on flipping) and learns
# purely from that via the standard Q-learning Bellman update — the same
# trial-and-error loop every RL textbook describes, not supervised learning
# wearing an RL name.

RL_STATE_FEATURES = ["ret_5", "vol_10", "rsi_14", "ema_spread"]  # indices 2, 4, 6, 8 in FEATURE_NAMES
RL_STATE_FEATURE_IDX = [FEATURE_NAMES.index(n) for n in RL_STATE_FEATURES]
RL_BINS_PER_FEATURE = 5
RL_ACTIONS = [-1, 0, 1]  # short, flat, long
TXN_COST = 0.0005


def _quantile_bin_edges(col: np.ndarray, n_bins: int) -> np.ndarray:
    qs = np.linspace(0, 1, n_bins + 1)[1:-1]
    edges = np.quantile(col, qs)
    return np.unique(edges) if len(edges) else np.array([0.0])


def _discretize_state(feat_row: np.ndarray, bin_edges: list[np.ndarray]) -> int:
    idx = 0
    for i, edges in enumerate(bin_edges):
        b = int(np.searchsorted(edges, feat_row[i]))
        idx = idx * (len(edges) + 1) + b
    return idx


def _state_space_size(bin_edges: list[np.ndarray]) -> int:
    size = 1
    for edges in bin_edges:
        size *= (len(edges) + 1)
    return size


DQN_HIDDEN_SIZE = 64
DQN_REPLAY_CAPACITY = 5000
DQN_BATCH_SIZE = 64
DQN_TARGET_SYNC_EVERY = 200  # environment steps between target-network syncs


def _train_dqn_policy(
    feats: np.ndarray, close: np.ndarray, warmup: int, episodes: int, train_pct: float,
    symbol: str, timeframe: str,
) -> dict[str, Any]:
    _require_torch("The Deep Q-Network (DQN) algorithm")
    n = len(close)
    valid = np.arange(warmup, n - 1)
    if len(valid) < 60:
        raise ValueError(f"Not enough bars after warmup to train an RL policy (have {len(valid)}, need >=60).")
    split = _chrono_split(len(valid), train_pct)
    train_idx, val_idx = valid[:split], valid[split:]
    if len(val_idx) < 10:
        raise ValueError("Validation slice too small — use more bars or a lower train %.")

    # DQN needs no discretization — it consumes the full continuous feature
    # vector directly, so its state isn't capped by a fixed bin count the
    # way the tabular agent's is. Standardize using TRAINING rows only, same
    # anti-lookahead discipline as the scikit-learn models' StandardScaler.
    feat_mean = feats[train_idx].mean(axis=0)
    feat_std = feats[train_idx].std(axis=0)
    feat_std[feat_std < 1e-8] = 1.0

    def norm(row: np.ndarray) -> np.ndarray:
        return ((row - feat_mean) / feat_std).astype(np.float32)

    device = _device()
    n_actions = len(RL_ACTIONS)
    q_net = DQNNet(len(FEATURE_NAMES), n_actions, DQN_HIDDEN_SIZE).to(device)
    target_net = DQNNet(len(FEATURE_NAMES), n_actions, DQN_HIDDEN_SIZE).to(device)
    target_net.load_state_dict(q_net.state_dict())
    target_net.eval()
    opt = torch.optim.Adam(q_net.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss()
    buffer = _ReplayBuffer(DQN_REPLAY_CAPACITY)

    gamma = 0.95
    epsilon_start, epsilon_end = 1.0, 0.05
    episode_rewards: list[float] = []
    rng = np.random.default_rng(42)
    step_count = 0

    for ep in range(episodes):
        epsilon = epsilon_start + (epsilon_end - epsilon_start) * (ep / max(1, episodes - 1))
        total_reward = 0.0
        prev_action_idx = 1  # start flat
        q_net.eval()
        for k, t in enumerate(train_idx):
            s = norm(feats[t])
            if rng.random() < epsilon:
                a_idx = int(rng.integers(0, n_actions))
            else:
                with torch.no_grad():
                    qvals = q_net(torch.tensor(s, device=device).unsqueeze(0))
                    a_idx = int(torch.argmax(qvals, dim=1).item())
            position = RL_ACTIONS[a_idx]
            step_ret = (close[t + 1] - close[t]) / close[t] if close[t] != 0 else 0.0
            cost = TXN_COST * abs(RL_ACTIONS[a_idx] - RL_ACTIONS[prev_action_idx])
            reward = position * step_ret - cost
            total_reward += reward

            if k + 1 < len(train_idx):
                s_next, done = norm(feats[train_idx[k + 1]]), False
            else:
                s_next, done = s, True
            buffer.push(s, a_idx, reward, s_next, done)
            prev_action_idx = a_idx
            step_count += 1

            if len(buffer) >= DQN_BATCH_SIZE:
                batch = buffer.sample(DQN_BATCH_SIZE)
                bs = torch.tensor(np.array([b[0] for b in batch]), device=device)
                ba = torch.tensor([b[1] for b in batch], dtype=torch.int64, device=device)
                br = torch.tensor([b[2] for b in batch], dtype=torch.float32, device=device)
                bsn = torch.tensor(np.array([b[3] for b in batch]), device=device)
                bd = torch.tensor([b[4] for b in batch], dtype=torch.float32, device=device)

                q_net.train()
                q_pred = q_net(bs).gather(1, ba.unsqueeze(1)).squeeze(1)
                with torch.no_grad():
                    q_next = target_net(bsn).max(dim=1)[0]
                    q_target = br + gamma * q_next * (1.0 - bd)
                loss = loss_fn(q_pred, q_target)
                opt.zero_grad()
                loss.backward()
                opt.step()
                q_net.eval()

            if step_count % DQN_TARGET_SYNC_EVERY == 0:
                target_net.load_state_dict(q_net.state_dict())
        episode_rewards.append(float(total_reward))

    q_net.eval()

    def run_policy(indices: np.ndarray, use_policy: bool) -> dict[str, float]:
        cum, wins, steps, prev_a = 0.0, 0, 0, 1
        for k, t in enumerate(indices[:-1] if len(indices) else indices):
            if use_policy:
                with torch.no_grad():
                    qvals = q_net(torch.tensor(norm(feats[t]), device=device).unsqueeze(0))
                    a_idx = int(torch.argmax(qvals, dim=1).item())
            else:
                a_idx = 2  # "always long" baseline
            position = RL_ACTIONS[a_idx]
            step_ret = (close[t + 1] - close[t]) / close[t] if close[t] != 0 else 0.0
            cost = TXN_COST * abs(RL_ACTIONS[a_idx] - RL_ACTIONS[prev_a])
            r = position * step_ret - cost
            cum += r
            if r > 0:
                wins += 1
            steps += 1
            prev_a = a_idx
        return {"totalReturn": float(cum), "winRate": float(wins / steps) if steps else 0.0, "steps": steps}

    policy_val = run_policy(val_idx, True)
    always_long_val = run_policy(val_idx, False)

    policy_id = f"rl_{uuid.uuid4().hex[:10]}"
    torch.save(q_net.state_dict(), os.path.join(POLICIES_DIR, f"{policy_id}.pt"))
    meta = {
        "id": policy_id, "symbol": symbol, "timeframe": timeframe,
        "algorithm": "dqn",
        "episodes": episodes, "trainPct": train_pct,
        "trainRows": int(len(train_idx)), "valRows": int(len(val_idx)),
        "warmupBars": int(warmup), "createdAt": time.time(),
        "stateFeatures": FEATURE_NAMES, "binsPerFeature": None, "stateSpaceSize": None,
        "featMean": feat_mean.tolist(), "featStd": feat_std.tolist(),
        "episodeRewards": episode_rewards,
        "device": get_device_info()["device"],
        "validation": {
            "policy": policy_val,
            "alwaysLong": always_long_val,
            "alwaysFlat": {"totalReturn": 0.0, "winRate": 0.0, "steps": policy_val["steps"]},
        },
    }
    with open(os.path.join(POLICIES_DIR, f"{policy_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def _get_dqn_actions(policy_id: str, bars: list[dict[str, Any]], meta: dict[str, Any]) -> list[int]:
    _require_torch("This policy")
    pt_path = os.path.join(POLICIES_DIR, f"{policy_id}.pt")
    if not os.path.exists(pt_path):
        raise FileNotFoundError(f"No such RL policy: {policy_id}")
    device = _device()
    q_net = DQNNet(len(FEATURE_NAMES), len(RL_ACTIONS), meta.get("hiddenSize", DQN_HIDDEN_SIZE)).to(device)
    q_net.load_state_dict(torch.load(pt_path, map_location=device))
    q_net.eval()

    feat_mean = np.array(meta["featMean"])
    feat_std = np.array(meta["featStd"])
    warmup = meta["warmupBars"]
    feats, _, _ = build_features(bars)
    n = len(bars)
    out = [0] * n
    if n <= warmup:
        return out
    Xn = ((feats[warmup:] - feat_mean) / feat_std).astype(np.float32)
    with torch.no_grad():
        qvals = q_net(torch.tensor(Xn, device=device))
        a_idxs = torch.argmax(qvals, dim=1).cpu().numpy()
    for i, a_idx in enumerate(a_idxs):
        out[warmup + i] = RL_ACTIONS[int(a_idx)]
    return out


def _train_tabular_policy(
    feats: np.ndarray, close: np.ndarray, warmup: int, episodes: int, train_pct: float,
    symbol: str, timeframe: str,
) -> dict[str, Any]:
    n = len(close)
    valid = np.arange(warmup, n - 1)  # need a next bar to realize reward
    if len(valid) < 60:
        raise ValueError(f"Not enough bars after warmup to train an RL policy (have {len(valid)}, need >=60).")

    split = _chrono_split(len(valid), train_pct)
    train_idx = valid[:split]
    val_idx = valid[split:]
    if len(val_idx) < 10:
        raise ValueError("Validation slice too small — use more bars or a lower train %.")

    state_feats_train = feats[train_idx][:, RL_STATE_FEATURE_IDX]
    bin_edges = [_quantile_bin_edges(state_feats_train[:, i], RL_BINS_PER_FEATURE) for i in range(len(RL_STATE_FEATURE_IDX))]
    n_states = _state_space_size(bin_edges)
    q_table = np.zeros((n_states, len(RL_ACTIONS)))

    alpha, gamma = 0.1, 0.95
    epsilon_start, epsilon_end = 1.0, 0.05
    episode_rewards: list[float] = []
    rng = np.random.default_rng(42)

    for ep in range(episodes):
        epsilon = epsilon_start + (epsilon_end - epsilon_start) * (ep / max(1, episodes - 1))
        total_reward = 0.0
        prev_action_idx = 1  # start flat
        for k, t in enumerate(train_idx):
            state_row = feats[t][RL_STATE_FEATURE_IDX]
            s = _discretize_state(state_row, bin_edges)
            if rng.random() < epsilon:
                a_idx = int(rng.integers(0, len(RL_ACTIONS)))
            else:
                a_idx = int(np.argmax(q_table[s]))
            position = RL_ACTIONS[a_idx]
            step_ret = (close[t + 1] - close[t]) / close[t] if close[t] != 0 else 0.0
            cost = TXN_COST * abs(RL_ACTIONS[a_idx] - RL_ACTIONS[prev_action_idx])
            reward = position * step_ret - cost
            total_reward += reward

            if k + 1 < len(train_idx):
                t_next = train_idx[k + 1]
                s_next = _discretize_state(feats[t_next][RL_STATE_FEATURE_IDX], bin_edges)
                best_next = np.max(q_table[s_next])
            else:
                best_next = 0.0
            q_table[s, a_idx] += alpha * (reward + gamma * best_next - q_table[s, a_idx])
            prev_action_idx = a_idx
        episode_rewards.append(float(total_reward))

    def run_policy(indices: np.ndarray, greedy_q: Optional[np.ndarray]) -> dict[str, float]:
        cum = 0.0
        wins = 0
        steps = 0
        prev_a = 1
        for k, t in enumerate(indices[:-1] if len(indices) else indices):
            if greedy_q is not None:
                s = _discretize_state(feats[t][RL_STATE_FEATURE_IDX], bin_edges)
                a_idx = int(np.argmax(greedy_q[s]))
            else:
                a_idx = 2  # "always long" baseline
            position = RL_ACTIONS[a_idx]
            step_ret = (close[t + 1] - close[t]) / close[t] if close[t] != 0 else 0.0
            cost = TXN_COST * abs(RL_ACTIONS[a_idx] - RL_ACTIONS[prev_a])
            r = position * step_ret - cost
            cum += r
            if r > 0:
                wins += 1
            steps += 1
            prev_a = a_idx
        return {"totalReturn": float(cum), "winRate": float(wins / steps) if steps else 0.0, "steps": steps}

    policy_val = run_policy(val_idx, q_table)
    always_long_val = run_policy(val_idx, None)
    # "Always flat" baseline is trivially zero return/cost — reported as a constant.

    policy_id = f"rl_{uuid.uuid4().hex[:10]}"
    np.savez(
        os.path.join(POLICIES_DIR, f"{policy_id}.npz"),
        q_table=q_table,
        bin_edges=np.array(bin_edges, dtype=object),
        allow_pickle=True,
    )
    meta = {
        "id": policy_id, "symbol": symbol, "timeframe": timeframe,
        "algorithm": "tabular",
        "episodes": episodes, "trainPct": train_pct,
        "trainRows": int(len(train_idx)), "valRows": int(len(val_idx)),
        "warmupBars": int(warmup), "createdAt": time.time(),
        "stateFeatures": RL_STATE_FEATURES, "binsPerFeature": RL_BINS_PER_FEATURE,
        "stateSpaceSize": int(n_states),
        "episodeRewards": episode_rewards,
        "device": "cpu",
        "validation": {
            "policy": policy_val,
            "alwaysLong": always_long_val,
            "alwaysFlat": {"totalReturn": 0.0, "winRate": 0.0, "steps": policy_val["steps"]},
        },
    }
    with open(os.path.join(POLICIES_DIR, f"{policy_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def train_rl_policy(
    bars: list[dict[str, Any]],
    episodes: int = 150,
    train_pct: float = 0.7,
    symbol: str = "",
    timeframe: str = "",
    algorithm: Literal["tabular", "dqn"] = "tabular",
) -> dict[str, Any]:
    close = np.array([float(b["close"]) for b in bars], dtype=np.float64)
    feats, _, warmup = build_features(bars)
    if algorithm == "dqn":
        return _train_dqn_policy(feats, close, warmup, episodes, train_pct, symbol, timeframe)
    return _train_tabular_policy(feats, close, warmup, episodes, train_pct, symbol, timeframe)


def _get_tabular_actions(policy_id: str, bars: list[dict[str, Any]], meta: dict[str, Any]) -> list[int]:
    npz_path = os.path.join(POLICIES_DIR, f"{policy_id}.npz")
    if not os.path.exists(npz_path):
        raise FileNotFoundError(f"No such RL policy: {policy_id}")
    data = np.load(npz_path, allow_pickle=True)
    q_table = data["q_table"]
    bin_edges = list(data["bin_edges"])
    warmup = meta["warmupBars"]

    feats, _, _ = build_features(bars)
    n = len(bars)
    out = [0] * n
    for t in range(warmup, n):
        s = _discretize_state(feats[t][RL_STATE_FEATURE_IDX], bin_edges)
        a_idx = int(np.argmax(q_table[s]))
        out[t] = RL_ACTIONS[a_idx]
    return out


def get_rl_actions(policy_id: str, bars: list[dict[str, Any]]) -> list[int]:
    json_path = os.path.join(POLICIES_DIR, f"{policy_id}.json")
    if not os.path.exists(json_path):
        raise FileNotFoundError(f"No such RL policy: {policy_id}")
    with open(json_path) as f:
        meta = json.load(f)
    if meta.get("algorithm") == "dqn":
        return _get_dqn_actions(policy_id, bars, meta)
    return _get_tabular_actions(policy_id, bars, meta)


def list_rl_policies() -> list[dict[str, Any]]:
    out = []
    for fn in sorted(os.listdir(POLICIES_DIR)):
        if fn.endswith(".json"):
            with open(os.path.join(POLICIES_DIR, fn)) as f:
                out.append(json.load(f))
    out.sort(key=lambda m: -m.get("createdAt", 0))
    return out


def delete_rl_policy(policy_id: str) -> bool:
    found = False
    for ext in (".npz", ".pt", ".json"):
        p = os.path.join(POLICIES_DIR, f"{policy_id}{ext}")
        if os.path.exists(p):
            os.remove(p)
            found = True
    return found
