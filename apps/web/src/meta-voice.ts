/**
 * Push-to-talk through Muse Voice Transcribe.
 *
 * Records the microphone, converts the clip in the browser to the format the
 * Meta transcribe endpoint accepts (mono 16-bit PCM WAV at 16 kHz) and sends
 * it through the backend, so the API key never reaches the page. Recognition
 * is biased toward trading and OakScript vocabulary.
 */

const BACKEND = (): string => (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788';

/** Terms the recogniser should prefer over similar-sounding words. */
export const TRADING_KEYWORDS = [
  'OakScript', 'RSI', 'EMA', 'SMA', 'MACD', 'ATR', 'VWAP', 'CCI', 'ADX', 'Bollinger', 'Donchian',
  'Keltner', 'stochastic', 'crossover', 'crossunder', 'breakout', 'breakdown', 'Fibonacci', 'pivot',
  'ribbon', 'manifold', 'histogram', 'divergence', 'oversold', 'overbought', 'Heikin-Ashi', 'Renko', '3D',
];

export interface TranscriptResult {
  ok: boolean;
  text: string;
  detail?: string;
  latencyMs?: number;
  audioMs?: number;
  costUsd?: number;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Decode any recorded clip and resample it to 16 kHz mono WAV. */
async function toWav16k(blob: Blob): Promise<ArrayBuffer> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), rate);
  } finally {
    void ctx.close();
  }
}

export async function transcribeWav(wav: ArrayBuffer): Promise<TranscriptResult> {
  try {
    const r = await fetch(`${BACKEND()}/api/meta/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_b64: toBase64(wav), keywords: TRADING_KEYWORDS }),
    });
    const d = await r.json();
    if (!d.ok) return { ok: false, text: '', detail: d.detail || `HTTP ${r.status}` };
    return { ok: true, text: String(d.transcript || ''), latencyMs: d.latency_ms, audioMs: d.audio_ms, costUsd: d.cost_usd };
  } catch (e: any) {
    return { ok: false, text: '', detail: 'The backend is not reachable, so Muse Voice Transcribe is unavailable.' };
  }
}

/** One push-to-talk session: start() opens the mic, stop() returns the transcript. */
export class PushToTalk {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  startedAt = 0;

  get active(): boolean { return !!this.recorder; }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start();
    this.startedAt = Date.now();
  }

  async stop(): Promise<TranscriptResult> {
    const rec = this.recorder;
    if (!rec) return { ok: false, text: '', detail: 'Not recording.' };
    const done = new Promise<void>(resolve => { rec.onstop = () => resolve(); });
    rec.stop();
    await done;
    this.stream?.getTracks().forEach(t => t.stop());
    this.recorder = null;
    this.stream = null;
    const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
    if (Date.now() - this.startedAt < 400 || blob.size < 1000) return { ok: false, text: '', detail: 'The recording was too short.' };
    return transcribeWav(await toWav16k(blob));
  }

  cancel(): void {
    try { this.recorder?.stop(); } catch { /* already stopped */ }
    this.stream?.getTracks().forEach(t => t.stop());
    this.recorder = null;
    this.stream = null;
  }
}
