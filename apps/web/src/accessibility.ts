// ─── Accessible Signal Palette + Sonification ──────────────────────
// Two independent, opt-in (default OFF) accessibility toggles, both
// persisted to localStorage so they survive a reload:
//  - Palette: swaps buy/sell/alert colors from green/red (indistinguishable
//    under the two most common forms of color blindness, protanopia and
//    deuteranopia — roughly 8% of men) to the blue/orange pair from the
//    Okabe–Ito colorblind-safe palette, which stays distinguishable across
//    protanopia, deuteranopia, and tritanopia.
//  - Sonification: a short Web Audio tone on the same events, for anyone
//    who wants (or needs) an audible cue independent of the screen.
// Scoped to trade markers and the alert/audit UI this session already
// centralizes (sendAlert, broker.onFill) — NOT the candlestick body
// rendering itself, whose bull/bear colors are hardcoded at ~15 separate
// sites across every bar-type variant (line/area/renko/kagi/footprint/...)
// in chart-renderer.ts. Re-theming all of those safely is a much larger,
// riskier change than this pass's "get it to 100% working" bar allows for;
// the signal markers and alerts are the higher-value, lower-risk win.

const PALETTE_KEY = 'dafe_accessible_palette';
const SONIFICATION_KEY = 'dafe_sonification';

// Okabe–Ito blue/orange — https://jfly.uni-koeln.de/color/ — chosen over an
// invented pair specifically because it's a published, tested colorblind-
// safe palette rather than a guess.
const STANDARD_COLORS = { bull: '#22cc88', bear: '#ff4477' };
const ACCESSIBLE_COLORS = { bull: '#0072B2', bear: '#E69F00' };

export function isAccessiblePaletteEnabled(): boolean {
  try { return localStorage.getItem(PALETTE_KEY) === '1'; } catch { return false; }
}

export function setAccessiblePaletteEnabled(enabled: boolean): void {
  try { localStorage.setItem(PALETTE_KEY, enabled ? '1' : '0'); } catch {}
}

/** Buy/bullish/up and sell/bearish/down colors for anything this session
 * owns (trade markers, alert badges, ledger/strategy-lab UI) — call this
 * instead of hardcoding '#22cc88'/'#ff4477' so the toggle actually reaches
 * every consumer instead of just some of them. */
export function signalColors(): { bull: string; bear: string } {
  return isAccessiblePaletteEnabled() ? ACCESSIBLE_COLORS : STANDARD_COLORS;
}

export function isSonificationEnabled(): boolean {
  try { return localStorage.getItem(SONIFICATION_KEY) === '1'; } catch { return false; }
}

export function setSonificationEnabled(enabled: boolean): void {
  try { localStorage.setItem(SONIFICATION_KEY, enabled ? '1' : '0'); } catch {}
}

// Lazily created — browsers require a user gesture before an AudioContext
// can actually produce sound, and the settings checkbox click IS that
// gesture, so creating it on first playTone() call (never at module load)
// lines up with when a gesture has actually happened.
let audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

interface ToneStep { freq: number; startOffset: number; duration: number; }
const TONE_PATTERNS: Record<'alert' | 'buy' | 'sell', ToneStep[]> = {
  alert: [{ freq: 550, startOffset: 0, duration: 0.14 }],
  buy: [{ freq: 440, startOffset: 0, duration: 0.09 }, { freq: 660, startOffset: 0.09, duration: 0.12 }],
  sell: [{ freq: 660, startOffset: 0, duration: 0.09 }, { freq: 440, startOffset: 0.09, duration: 0.12 }],
};

/** Fires a short (<=250ms), quiet chime for the given event kind. No-op
 * (and never throws) when sonification is off or Web Audio is unavailable
 * — this is always called from a real event-handling path (an alert
 * firing, a trade filling), and a sound-effect failure must never break
 * that path. */
export function playTone(kind: 'alert' | 'buy' | 'sell'): void {
  if (!isSonificationEnabled()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();

    const now = ctx.currentTime;
    for (const step of TONE_PATTERNS[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = step.freq;
      const start = now + step.startOffset;
      const end = start + step.duration;
      // Quick fade-in/out envelope so the tone doesn't click at its edges,
      // capped at a deliberately quiet volume (this fires on every alert/
      // fill — it must never be startling).
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    // Never let a sound-effect failure break the alert/fill path it's
    // attached to.
  }
}
