export interface VoiceOptions {
  wakeWord?: string;
  onResult?: (text: string) => void;
  onStateChange?: (state: VoiceState) => void;
  apiBaseUrl?: string;
}

export type VoiceState = 'idle' | 'listening' | 'speaking' | 'wake-waiting';

export type VoicePreference = 'auto' | 'natural' | 'male' | 'female' | 'soft';

export class AdvisorVoice {
  private recognition: any = null;
  private wakeWord: string;
  private state: VoiceState = 'idle';
  private continuousMode = false;
  private wakePending = false;
  private onResult: ((text: string) => void) | null = null;
  private onStateChange: ((state: VoiceState) => void) | null = null;
  private apiBaseUrl: string;
  private isSpeakingFlag = false;
  private voicePref: VoicePreference = 'auto';

  constructor(options: VoiceOptions = {}) {
    this.wakeWord = (options.wakeWord || 'Advisor').toLowerCase();
    this.onResult = options.onResult || null;
    this.onStateChange = options.onStateChange || null;
    this.apiBaseUrl = options.apiBaseUrl || 'http://127.0.0.1:8788';
    this.voicePref = (localStorage.getItem('dafe_voice_pref') as VoicePreference) || 'auto';
  }

  setVoicePreference(pref: VoicePreference): void {
    this.voicePref = pref;
    localStorage.setItem('dafe_voice_pref', pref);
  }

  getVoicePreference(): VoicePreference { return this.voicePref; }

  getState(): VoiceState { return this.state; }
  isContinuous(): boolean { return this.continuousMode; }

  private setState(s: VoiceState) {
    this.state = s;
    this.onStateChange?.(s);
  }

  startWakeListening(): void {
    if (this.state === 'speaking' || this.state === 'listening') return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || (window as any).mozSpeechRecognition;
    if (!SR) {
      return;
    }
    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase().trim();
        if (this.wakePending && event.results[i].isFinal) {
          this.wakePending = false;
          this.setState('idle');
          if (transcript) {
            this.onResult?.(transcript);
          }
          if (this.continuousMode && !this.isSpeakingFlag) {
            setTimeout(() => this.startWakeListening(), 500);
          }
          return;
        }
        if (transcript.includes(this.wakeWord) && !this.wakePending) {
          this.wakePending = true;
          this.setState('wake-waiting');
        }
      }
    };

    this.recognition.onerror = () => {
      this.setState('idle');
      if (this.continuousMode) {
        setTimeout(() => this.startWakeListening(), 2000);
      }
    };

    this.recognition.onend = () => {
      if (this.continuousMode && !this.isSpeakingFlag && this.state !== 'speaking') {
        setTimeout(() => this.startWakeListening(), 500);
      }
    };

    this.setState('listening');
    try { this.recognition.start(); } catch { /* ignore */ }
  }

  stopWakeListening(): void {
    this.continuousMode = false;
    this.wakePending = false;
    this.isSpeakingFlag = false;
    this.recognition?.stop();
    this.recognition = null;
    this.setState('idle');
  }

  toggleContinuous(): void {
    this.continuousMode = !this.continuousMode;
    if (this.continuousMode) {
      this.startWakeListening();
    } else {
      this.stopWakeListening();
    }
  }

  async speak(text: string, onDone?: () => void): Promise<void> {
    this.isSpeakingFlag = true;

    const audioB64 = await this.synthesizeBackend(text);
    if (audioB64) {
      this.setState('speaking');
      const audio = new Audio(`data:audio/mp3;base64,${audioB64}`);
      audio.onended = () => {
        this.isSpeakingFlag = false;
        this.setState('idle');
        onDone?.();
        if (this.continuousMode) {
          setTimeout(() => this.startWakeListening(), 300);
        }
      };
      audio.onerror = () => {
        this.fallbackSpeak(text, onDone);
      };
      audio.play().catch(() => {
        this.fallbackSpeak(text, onDone);
      });
    } else {
      this.fallbackSpeak(text, onDone);
    }
  }

  private async synthesizeBackend(text: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/voice/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, provider: 'gtts' }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.audio_b64 || null;
    } catch {
      return null;
    }
  }

  private fallbackSpeak(text: string, onDone?: () => void): void {
    if (!('speechSynthesis' in window)) {
      this.isSpeakingFlag = false;
      this.setState('idle');
      onDone?.();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.lang = 'en-US';

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const enVoices = voices.filter(v => v.lang.startsWith('en'));

      let picked: SpeechSynthesisVoice | undefined;
      if (this.voicePref === 'natural') {
        picked = enVoices.find(v => v.name.includes('Natural') || v.name.includes('Neural') || v.name.includes('Premium') || v.name.includes('Enhanced'));
      } else if (this.voicePref === 'male') {
        picked = enVoices.find(v => v.name.toLowerCase().includes('male') || v.name.includes('David') || v.name.includes('Mark') || v.name.includes('Guy') || v.name.includes('James'));
      } else if (this.voicePref === 'female') {
        picked = enVoices.find(v => v.name.toLowerCase().includes('female') || v.name.includes('Zira') || v.name.includes('Susan') || v.name.includes('Catherine') || v.name.includes('Linda'));
      } else if (this.voicePref === 'soft') {
        picked = enVoices.find(v => v.name.includes('Natural') || v.name.includes('Samantha') || v.name.includes('Karen') || (v.name.includes('Microsoft') && !v.name.includes('David') && !v.name.includes('Mark')));
      }
      // auto or fallback: prefer natural/neural, avoid harsh voices
      if (!picked) {
        picked = enVoices.find(v =>
          (v.name.includes('Natural') || v.name.includes('Neural') || v.name.includes('Premium'))
          && !v.name.includes('Zira')
        ) || enVoices.find(v => v.lang.startsWith('en-US') && !v.name.includes('Zira'));
      }
      if (picked) utterance.voice = picked;
    };
    pickVoice();
    window.speechSynthesis.onvoiceschanged = () => pickVoice();

    this.setState('speaking');
    utterance.onend = () => {
      this.isSpeakingFlag = false;
      this.setState('idle');
      onDone?.();
    };
    utterance.onerror = () => {
      this.isSpeakingFlag = false;
      this.setState('idle');
      onDone?.();
    };
    window.speechSynthesis.speak(utterance);
  }

  cancel(): void {
    this.isSpeakingFlag = false;
    window.speechSynthesis.cancel();
    this.recognition?.stop();
    this.recognition = null;
    this.setState('idle');
  }

  requestMicrophone(): Promise<boolean> {
    return navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(() => true)
      .catch(() => false) ?? Promise.resolve(false);
  }
}
