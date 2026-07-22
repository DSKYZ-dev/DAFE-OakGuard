"""
DAFE Charts — ML / RL Engine.

Two genuine, from-real-data capabilities, sharing one feature pipeline:

  1. Supervised ML signal models (gradient boosting / a real 2-hidden-layer
     MLP / logistic regression, all via scikit-learn) predicting next-H-bar
     direction or return from OHLCV-derived features. Exposed to OakScript
     as ml.predict(modelId).
  2. A from-scratch tabular Q-learning agent — genuine reinforcement
     learning: it never sees a labeled "correct" target, only a reward
     signal (mark-to-market P&L) from acting against the SAME historical
     bars the backtester replays, exactly the trial-and-error RL loop is
     supposed to be. Exposed as rl.action(policyId).

Both split data chronologically (train = first train_pct of bars, validate
= the rest) — never randomly shuffled, which would leak future bars into
training the same way it would corrupt the backtester's in-sample/
out-of-sample split. Every metric is reported next to a naive baseline
(majority-class accuracy, zero-change MAE, always-flat/always-long return)
so a model that learned nothing real is visible as such, not dressed up
by a lonely accuracy number.

No PyTorch/TensorFlow dependency: the default PyTorch pip wheel on this
platform bundles ~2GB of CUDA runtime the sandbox has no GPU to use, and
would be an inappropriate default dependency for anyone else deploying
this backend. scikit-learn's MLPClassifier/MLPRegressor is a genuine
multi-layer neural net trained via backprop — appropriately scoped for
tabular financial features, where gradient-boosted trees routinely
outperform deep nets anyway.
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


def train_ml_model(
    bars: list[dict[str, Any]],
    horizon: int = 3,
    target_type: Literal["direction", "return"] = "direction",
    model_type: Literal["gbm", "mlp", "logistic"] = "gbm",
    train_pct: float = 0.7,
    symbol: str = "",
    timeframe: str = "",
) -> dict[str, Any]:
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
    }
    with open(os.path.join(MODELS_DIR, f"{model_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def predict_ml_model(model_id: str, bars: list[dict[str, Any]]) -> list[float]:
    import joblib
    path = os.path.join(MODELS_DIR, f"{model_id}.joblib")
    if not os.path.exists(path):
        raise FileNotFoundError(f"No such model: {model_id}")
    bundle = joblib.load(path)
    scaler, model, names = bundle["scaler"], bundle["model"], bundle["feature_names"]
    with open(os.path.join(MODELS_DIR, f"{model_id}.json")) as f:
        meta = json.load(f)
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
    for ext in (".joblib", ".json"):
        p = os.path.join(MODELS_DIR, f"{model_id}{ext}")
        if os.path.exists(p):
            os.remove(p)
            found = True
    return found


# ---------------------------------------------------------------------------
# Reinforcement learning — tabular Q-learning
# ---------------------------------------------------------------------------
# Genuine RL: the agent is never told the "right" action. It only ever sees
# a per-step reward (mark-to-market P&L on the position its action implies,
# minus a small transaction-cost penalty on flipping) and learns purely
# from that via the standard Q-learning Bellman update — the same
# trial-and-error loop every RL textbook describes, not supervised
# learning wearing an RL name.

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


def train_rl_policy(
    bars: list[dict[str, Any]],
    episodes: int = 150,
    train_pct: float = 0.7,
    symbol: str = "",
    timeframe: str = "",
) -> dict[str, Any]:
    close = np.array([float(b["close"]) for b in bars], dtype=np.float64)
    feats, _, warmup = build_features(bars)
    n = len(bars)
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
        "episodes": episodes, "trainPct": train_pct,
        "trainRows": int(len(train_idx)), "valRows": int(len(val_idx)),
        "warmupBars": int(warmup), "createdAt": time.time(),
        "stateFeatures": RL_STATE_FEATURES, "binsPerFeature": RL_BINS_PER_FEATURE,
        "stateSpaceSize": int(n_states),
        "episodeRewards": episode_rewards,
        "validation": {
            "policy": policy_val,
            "alwaysLong": always_long_val,
            "alwaysFlat": {"totalReturn": 0.0, "winRate": 0.0, "steps": policy_val["steps"]},
        },
    }
    with open(os.path.join(POLICIES_DIR, f"{policy_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def get_rl_actions(policy_id: str, bars: list[dict[str, Any]]) -> list[int]:
    npz_path = os.path.join(POLICIES_DIR, f"{policy_id}.npz")
    json_path = os.path.join(POLICIES_DIR, f"{policy_id}.json")
    if not os.path.exists(npz_path):
        raise FileNotFoundError(f"No such RL policy: {policy_id}")
    data = np.load(npz_path, allow_pickle=True)
    q_table = data["q_table"]
    bin_edges = list(data["bin_edges"])
    with open(json_path) as f:
        meta = json.load(f)
    warmup = meta["warmupBars"]

    feats, _, _ = build_features(bars)
    n = len(bars)
    out = [0] * n
    for t in range(warmup, n):
        s = _discretize_state(feats[t][RL_STATE_FEATURE_IDX], bin_edges)
        a_idx = int(np.argmax(q_table[s]))
        out[t] = RL_ACTIONS[a_idx]
    return out


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
    for ext in (".npz", ".json"):
        p = os.path.join(POLICIES_DIR, f"{policy_id}{ext}")
        if os.path.exists(p):
            os.remove(p)
            found = True
    return found
