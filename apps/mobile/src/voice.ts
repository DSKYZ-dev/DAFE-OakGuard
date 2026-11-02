// Mobile voice input and output for the Advisor. Behaviour follows the desktop
// AdvisorVoice (apps/web/src/trade-advisor/voice.ts): push-to-talk, an optional
// hands-free mode armed by the wake word, and optional spoken replies.

const HANDSFREE_KEY = 'dafe_mobile_voice_handsfree';
const TTS_KEY = 'dafe_mobile_voice_tts';
const ARM_TIMEOUT_MS = 15_000;

export interface VoiceCallbacks {
  onTranscript: (text: string) => void;
  onStatus: (text: string) => void;
  onListening: (on: boolean) => void;
  onHandsFreeChange: (on: boolean) => void;
}

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

function recognitionCtor(): any | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function voiceInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export function speechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function handsFreeSaved(): boolean { return readFlag(HANDSFREE_KEY); }
export function setHandsFreeSaved(on: boolean): void { writeFlag(HANDSFREE_KEY, on); }
export function speakRepliesSaved(): boolean { return readFlag(TTS_KEY); }
export function setSpeakRepliesSaved(on: boolean): void { writeFlag(TTS_KEY, on); }

export function speakText(text: string): void {
  if (!speechOutputSupported() || !speakRepliesSaved()) return;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = 'en-US';
  utterance.rate = 0.95;
  synth.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}

export class VoiceInput {
  private rec: any = null;
  private mode: 'ptt' | 'hands' | null = null;
  private pttText = '';
  private wanted = handsFreeSaved();
  private handsOn = false;
  private armed = false;
  private armTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private lastError = false;

  constructor(private cb: VoiceCallbacks) {}

  // Push-to-talk: hold to record. Only the final transcript is delivered, and
  // only once recognition has ended, so partial text is never sent.
  pressStart(): void {
    if (this.mode === 'ptt') return;
    this.start('ptt');
  }

  pressEnd(): void {
    if (this.mode !== 'ptt' || !this.rec) return;
    try { this.rec.stop(); } catch { this.stopRecognizer(); this.finishPtt(); }
  }

  setHandsFree(on: boolean): void {
    this.wanted = on;
    setHandsFreeSaved(on);
    this.applyHands(on);
  }

  // Hands-free listens only while the Advisor tab is open. Leaving the tab
  // pauses it without changing the saved preference.
  setActive(active: boolean): void {
    this.applyHands(active && this.wanted);
  }

  dispose(): void {
    this.wanted = false;
    this.applyHands(false);
    this.stopRecognizer();
    this.cb.onListening(false);
  }

  private applyHands(on: boolean): void {
    this.handsOn = on;
    if (on) {
      if (!this.mode) this.start('hands');
      return;
    }
    this.disarm();
    this.clearRestart();
    if (this.mode === 'hands') {
      this.stopRecognizer();
      this.cb.onListening(false);
    }
  }

  private start(mode: 'ptt' | 'hands'): void {
    const SR = recognitionCtor();
    if (!SR) return;
    this.clearRestart();
    this.stopRecognizer();
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.continuous = mode === 'hands';
    rec.onresult = (e: any) => this.onResult(e);
    rec.onerror = (e: any) => this.onError(e);
    rec.onend = () => this.onEnd(rec);
    this.rec = rec;
    this.mode = mode;
    if (mode === 'ptt') this.pttText = '';
    this.cb.onListening(true);
    try {
      rec.start();
    } catch {
      this.stopRecognizer();
      this.cb.onListening(false);
      this.cb.onStatus('Could not start the microphone.');
    }
  }

  private stopRecognizer(): void {
    const r = this.rec;
    this.rec = null;
    this.mode = null;
    if (r) { try { r.abort(); } catch { /* already stopped */ } }
  }

  private onResult(e: any): void {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (!result.isFinal) continue;
      const text = String(result[0]?.transcript ?? '').trim();
      if (!text) continue;
      if (this.mode === 'ptt') {
        this.pttText = this.pttText ? `${this.pttText} ${text}` : text;
      } else {
        this.handsFreePhrase(text);
      }
    }
  }

  // Only a phrase that starts with "Advisor" counts. Words after it are sent as
  // the question; otherwise the next phrase is sent.
  private handsFreePhrase(raw: string): void {
    const phrase = raw.trim();
    const m = /^advisor\b[\s,.!?:;-]*(.*)$/i.exec(phrase);
    if (m) {
      const rest = m[1].trim();
      this.disarm();
      if (rest) this.cb.onTranscript(rest);
      else this.arm();
      return;
    }
    if (this.armed) {
      this.disarm();
      this.cb.onTranscript(phrase);
    }
  }

  private arm(): void {
    this.armed = true;
    this.cb.onStatus('Heard "Advisor" — ask your question.');
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => {
      this.armed = false;
      this.cb.onStatus('');
    }, ARM_TIMEOUT_MS);
  }

  private disarm(): void {
    this.armed = false;
    clearTimeout(this.armTimer);
  }

  private clearRestart(): void {
    clearTimeout(this.restartTimer);
  }

  private onError(e: any): void {
    const code = String(e?.error ?? '');
    if (code === 'aborted' || code === 'no-speech') return;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.wanted = false;
      setHandsFreeSaved(false);
      this.applyHands(false);
      this.cb.onHandsFreeChange(false);
      this.cb.onStatus('Microphone permission was denied. Allow it for this app and try again.');
      return;
    }
    this.lastError = true;
    this.cb.onStatus(`Voice input error: ${code || 'unknown'}.`);
  }

  private onEnd(rec: any): void {
    if (rec !== this.rec) return;
    const mode = this.mode;
    this.rec = null;
    this.mode = null;
    if (mode === 'ptt') {
      this.finishPtt();
      return;
    }
    if (this.handsOn) {
      const delay = this.lastError ? 1500 : 300;
      this.lastError = false;
      this.restartTimer = setTimeout(() => {
        if (this.handsOn && !this.rec) this.start('hands');
      }, delay);
    } else {
      this.cb.onListening(false);
    }
  }

  private finishPtt(): void {
    const text = this.pttText.trim();
    this.pttText = '';
    this.mode = null;
    if (text) this.cb.onTranscript(text);
    else this.cb.onStatus('No speech heard.');
    if (this.handsOn) this.start('hands');
    else this.cb.onListening(false);
  }
}
