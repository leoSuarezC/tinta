/* Dictado con la Web Speech API (Chrome y Edge; en Android usa el reconocedor de Google). */

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  0: SpeechAlternative;
}
interface SpeechEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function dictationSupported(): boolean {
  return !!ctor();
}

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

export function describeDictationError(err?: string): string | undefined {
  switch (err) {
    case undefined:
    case 'aborted':
    case 'no-speech':
      return undefined;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Permite el micrófono para dictar (en los permisos del sitio).';
    case 'audio-capture':
      return 'No se encontró un micrófono.';
    case 'network':
      return 'El dictado necesita conexión a internet.';
    case 'language-not-supported':
      return 'Ese idioma no está disponible para dictar en este dispositivo.';
    default:
      return `El dictado se detuvo (${err}).`;
  }
}

/** Comandos de voz con poca ambigüedad. */
export function applyVoiceCommands(text: string): string {
  return text
    .replace(/\s*\bpunto y aparte\b\s*/gi, '.\n')
    .replace(/\s*\bnuevo p[aá]rrafo\b\s*/gi, '\n\n')
    .replace(/\s*\bnueva l[ií]nea\b\s*/gi, '\n')
    .replace(/\s*\bpunto final\b\s*/gi, '.');
}

export class Dictation {
  private rec: Recognition | null = null;
  private active = false;
  private lastError?: string;
  private restarts = 0;

  constructor(
    private opts: {
      lang: string;
      onFinal: (text: string) => void;
      onInterim: (text: string) => void;
      onEnd: (error?: string) => void;
    },
  ) {}

  get running() {
    return this.active;
  }

  start() {
    const C = ctor();
    if (!C) {
      this.opts.onEnd('unsupported');
      return;
    }
    this.active = true;
    this.lastError = undefined;
    this.restarts = 0;
    this.launch(C);
  }

  private launch(C: RecognitionCtor) {
    const rec = new C();
    rec.lang = this.opts.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const t = applyVoiceCommands(r[0].transcript.trim());
          if (t) this.opts.onFinal(t);
          this.restarts = 0;
        } else interim += r[0].transcript;
      }
      this.opts.onInterim(interim);
    };
    rec.onerror = (e) => {
      this.lastError = e.error;
    };
    rec.onend = () => {
      this.opts.onInterim('');
      // En Android el reconocimiento se corta tras una pausa: se reanuda mientras siga activo.
      if (this.active && !FATAL.has(this.lastError ?? '') && this.restarts < 20) {
        this.restarts++;
        this.lastError = undefined;
        try {
          this.launch(C);
          return;
        } catch {
          /* cae al final */
        }
      }
      this.active = false;
      this.opts.onEnd(this.lastError);
    };
    this.rec = rec;
    rec.start();
  }

  stop() {
    this.active = false;
    try {
      this.rec?.stop();
    } catch {
      /* ya detenido */
    }
  }
}
