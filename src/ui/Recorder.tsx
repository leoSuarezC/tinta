import { useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Square } from 'lucide-react';
import { useServices } from '../app/services';
import { useApp } from '../app/state';
import { compactStamp, extForMime, stamp } from '../model/fileTypes';
import { ATTACH_FOLDER } from '../app/actions';
import { holdReauth } from '../app/hooks';
import { cls, Sheet } from './common';
import { formatDuration } from './format';
import fixWebmDuration from 'fix-webm-duration';

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

type Phase = 'idle' | 'recording' | 'paused' | 'saving';

export function RecorderSheet({ folder, onSaved, onClose }: { folder: string; onSaved?: (lid: string, seconds: number) => void; onClose: () => void }) {
  const { engine, store } = useServices();
  const toast = useApp((s) => s.toast);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string>();
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  const accumulated = useRef(0);
  const raf = useRef(0);
  const wake = useRef<WakeLockSentinel | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const eink = useApp((s) => s.settings.eink);

  const cleanup = () => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    void wake.current?.release().catch(() => undefined);
    wake.current = null;
  };
  useEffect(() => cleanup, []);
  // No renovar la sesión de Google (redirección) en medio de una grabación.
  useEffect(() => (phase === 'recording' || phase === 'paused' || phase === 'saving' ? holdReauth() : undefined), [phase]);

  const tick = (analyser?: AnalyserNode, buf?: Uint8Array<ArrayBuffer>) => {
    const now = performance.now();
    const running = rec.current?.state === 'recording';
    setElapsed(accumulated.current + (running ? (now - started.current) / 1000 : 0));
    if (analyser && buf && running && !eink) {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      setLevel(peak / 128);
    }
    raf.current = requestAnimationFrame(() => tick(analyser, buf));
  };

  const start = async () => {
    setError(undefined);
    const mime = pickMime();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Este navegador no puede grabar audio.');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.start(1000);
      rec.current = r;
      started.current = performance.now();
      accumulated.current = 0;
      setPhase('recording');
      try {
        wake.current = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        /* sin wake lock */
      }
      let analyser: AnalyserNode | undefined;
      let buf: Uint8Array<ArrayBuffer> | undefined;
      try {
        const ctx = new AudioContext();
        audioCtx.current = ctx;
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        buf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      } catch {
        /* sin medidor */
      }
      tick(analyser, buf);
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(name === 'NotAllowedError' ? 'Permite el micrófono para grabar (en los permisos del sitio).' : name === 'NotFoundError' ? 'No se encontró un micrófono.' : `No se pudo grabar: ${(e as Error).message}`);
      cleanup();
    }
  };

  const pause = () => {
    const r = rec.current;
    if (!r) return;
    if (r.state === 'recording') {
      r.pause();
      accumulated.current += (performance.now() - started.current) / 1000;
      setPhase('paused');
    } else if (r.state === 'paused') {
      r.resume();
      started.current = performance.now();
      setPhase('recording');
    }
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    const seconds = accumulated.current + (r.state === 'recording' ? (performance.now() - started.current) / 1000 : 0);
    setPhase('saving');
    await new Promise<void>((resolve) => {
      r.onstop = () => resolve();
      r.stop();
    });
    cleanup();
    const type = (r.mimeType || 'audio/webm').split(';')[0];
    let blob = new Blob(chunks.current, { type });
    // Las grabaciones WebM del navegador no traen la duración: se agrega para poder adelantar y retroceder.
    if (type.includes('webm')) blob = await fixWebmDuration(blob, Math.round(seconds * 1000), { logger: false }).catch(() => blob);
    const ext = extForMime(type);
    const parent = await store.getItem(folder);
    const isAttachment = parent?.name === ATTACH_FOLDER;
    const name = isAttachment ? `audio-${compactStamp()}.${ext}` : `Nota de voz ${stamp()}.${ext}`;
    const item = await engine.createFile(folder, name, type, blob);
    toast(isAttachment ? 'Audio agregado a la nota' : `«${item.name}» guardado`);
    onSaved?.(item.lid, seconds);
    onClose();
  };

  const cancel = () => {
    if (rec.current && rec.current.state !== 'inactive') {
      rec.current.onstop = null;
      rec.current.stop();
    }
    cleanup();
    onClose();
  };

  return (
    <Sheet title="Grabar audio" onClose={cancel} className="recorder">
      <div className="rec-stage">
        <div className={cls('rec-time', phase === 'recording' && 'is-live')} aria-live="off">
          {formatDuration(elapsed)}
        </div>
        <div className="rec-meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${phase === 'recording' ? Math.max(0.04, Math.min(1, level * 1.6)) : 0.04})` }} />
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="rec-controls">
          {phase === 'idle' && (
            <button className="rec-main" onClick={start} aria-label="Empezar a grabar">
              <Mic size={30} />
            </button>
          )}
          {(phase === 'recording' || phase === 'paused') && (
            <>
              <button className="icon-btn big" onClick={pause} aria-label={phase === 'paused' ? 'Continuar' : 'Pausar'}>
                {phase === 'paused' ? <Play size={26} /> : <Pause size={26} />}
              </button>
              <button className="rec-main is-stop" onClick={stop} aria-label="Detener y guardar">
                <Square size={26} fill="currentColor" />
              </button>
            </>
          )}
          {phase === 'saving' && <p>Guardando…</p>}
        </div>
        <p className="rec-hint">
          {phase === 'idle' ? 'La grabación se guarda en Drive al detenerla.' : phase === 'paused' ? 'En pausa' : phase === 'recording' ? 'Grabando. La pantalla se mantiene encendida.' : ''}
        </p>
      </div>
    </Sheet>
  );
}
