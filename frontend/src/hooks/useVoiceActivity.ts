'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MicVAD } from '@ricky0123/vad-web/dist/real-time-vad';

/**
 * Hands-free turn taking: Silero VAD listening on the mic, so the candidate
 * just talks and stops instead of holding a push-to-talk button.
 *
 * How it works: a small ONNX model (Silero) scores every 512-sample frame of
 * mic audio for "is this speech". A run of speech frames opens an utterance;
 * `endOfTurnMs` of quiet closes it, and the buffered audio comes back as a
 * 16 kHz WAV for transcription. Everything runs in the browser — the model and
 * its WASM runtime are served from /vad (see scripts/copy-vad-assets.mjs), so
 * no audio and no asset fetch ever leaves the machine.
 *
 * The hard part is not detection, it's not hearing ourselves. Alex's voice
 * comes out of the speakers and straight back into the mic, and the VAD cannot
 * tell it apart from the candidate. Two defences, because echo cancellation
 * alone is not reliable across machines:
 *
 *  1. `hold` — the caller raises it whenever Alex is talking or about to, and
 *     we disconnect the VAD from the audio graph so it sees digital silence.
 *  2. `RESUME_DELAY_MS` — we re-open the mic slightly after `hold` drops,
 *     since the tail of the last audio clip is still in the room.
 *
 * The gate never touches the MediaStreamTrack. Both `track.enabled = false`
 * and stopping the track are wrong here: stopping re-prompts for permission
 * every turn, and disabling permanently kills capture in WebKitGTK. See the
 * hold effect below for the measurements.
 */

export type VoiceActivityStatus =
  /** Hands-free is switched off. */
  | 'off'
  /** Fetching the model / waiting on mic permission. */
  | 'loading'
  /** Mic is live, waiting for the candidate to start. */
  | 'listening'
  /** Candidate is mid-sentence. */
  | 'speech'
  /** Mic muted because Alex is speaking. */
  | 'held'
  /** Unusable — caller should fall back to push-to-talk. */
  | 'error';

interface UseVoiceActivityOptions {
  /** Master switch. Turning this off tears down the mic and the model. */
  enabled: boolean;
  /** Mute the mic — raise while Alex is speaking or a reply is in flight. */
  hold: boolean;
  /** Called with a 16 kHz mono WAV once the candidate finishes a turn. */
  onUtterance: (wav: Blob) => void;
  /** Silence that ends a turn. Long enough to survive a thinking pause. */
  endOfTurnMs?: number;
}

/** Wait out the tail of Alex's audio before re-opening the mic. */
const RESUME_DELAY_MS = 350;

/**
 * Silence that ends a turn. Interview answers contain real pauses — someone
 * working through a system-design question stops mid-thought all the time —
 * so this sits well above the ~500 ms a chatty voice assistant would use.
 * Shorter feels snappy right up until it cuts a candidate off mid-answer.
 */
const DEFAULT_END_OF_TURN_MS = 1400;

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was blocked. Allow it in your browser, or use the mic button to record manually.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Plug one in, or type your answers instead.';
  }
  return err instanceof Error ? err.message : String(err);
}

export function useVoiceActivity({
  enabled,
  hold,
  onUtterance,
  endOfTurnMs = DEFAULT_END_OF_TURN_MS,
}: UseVoiceActivityOptions) {
  const [status, setStatus] = useState<VoiceActivityStatus>('off');
  const [error, setError] = useState<string | null>(null);

  // Callback and tuning live in refs so changing them never tears down and
  // re-downloads the model — the setup effect depends on `enabled` alone.
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const endOfTurnRef = useRef(endOfTurnMs);
  endOfTurnRef.current = endOfTurnMs;

  const vadRef = useRef<MicVAD | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const holdRef = useRef(hold);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Serialises the async pause/start calls that gate the microphone. */
  const gateRef = useRef<Promise<void>>(Promise.resolve());
  const levelRef = useRef(0);

  /**
   * Live mic loudness, 0..1, for the avatar to react to while the candidate
   * talks. Polled per animation frame, so it is a ref rather than state.
   */
  const getInputLevel = useCallback(() => levelRef.current, []);

  // Setup / teardown. Keyed on `enabled` only.
  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setError(null);

    void (async () => {
      try {
        // Imported lazily: the package touches window at module scope and
        // pulls in onnxruntime, neither of which belongs in the SSR bundle or
        // in the initial payload of an interview that may never go hands-free.
        //
        // Deep imports rather than the package index on purpose. The index
        // also re-exports NonRealTimeVAD, which pulls in the full
        // onnxruntime-web build (WebGPU and all) alongside the wasm-only one
        // MicVAD needs — two megabytes of JS for an export we never call.
        const [{ MicVAD }, { encodeWAV }] = await Promise.all([
          import('@ricky0123/vad-web/dist/real-time-vad'),
          import('@ricky0123/vad-web/dist/utils'),
        ]);
        if (cancelled) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const vad = await MicVAD.new({
          model: 'legacy',
          // Same-origin copies of the worklet, the Silero weights and the
          // onnxruntime WASM. Without these the package reaches for a CDN.
          baseAssetPath: '/vad/',
          onnxWASMBasePath: '/vad/',
          // AudioWorklet where available, ScriptProcessor otherwise — the
          // Tauri webview (WebKitGTK) is the case that needs the fallback.
          processorType: 'auto',
          // Single-threaded: multi-threaded WASM needs SharedArrayBuffer,
          // which needs COOP/COEP headers we do not set. One thread is
          // plentiful for a model this small.
          ortConfig: (ort) => {
            ort.env.wasm.numThreads = 1;
          },
          // We own the stream so we can mute it per turn; the package's own
          // pause/resume stop the tracks, which would re-prompt for the mic.
          getStream: async () => stream,
          pauseStream: async () => {},
          resumeStream: async () => stream,
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
          // Ignore anything shorter than this — a cough, a chair, a keystroke.
          minSpeechMs: 500,
          // Keep the audio just before detection fired, or the first word of
          // the answer arrives at the transcriber clipped.
          preSpeechPadMs: 800,
          redemptionMs: endOfTurnRef.current,
          onFrameProcessed: (_probs, frame) => {
            if (holdRef.current) {
              levelRef.current = 0;
              return;
            }
            let sumSq = 0;
            for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
            const rms = Math.sqrt(sumSq / frame.length);
            // Same attack/release smoothing the TTS meter uses, so the avatar
            // behaves identically whoever is talking.
            levelRef.current += (Math.min(1, rms * 4) - levelRef.current) * 0.35;
          },
          onSpeechStart: () => {
            if (!holdRef.current) setStatus('speech');
          },
          onVADMisfire: () => {
            if (!holdRef.current) setStatus('listening');
          },
          onSpeechEnd: (audio) => {
            setStatus(holdRef.current ? 'held' : 'listening');
            // A hold raised mid-utterance means this segment is either Alex
            // leaking through the speakers or a turn we have already sent.
            if (holdRef.current) return;
            // 16-bit PCM rather than the package's default 32-bit float: half
            // the upload and the format every transcriber accepts.
            const wav = encodeWAV(audio, 1, 16000, 1, 16);
            onUtteranceRef.current(new Blob([wav], { type: 'audio/wav' }));
          },
        });

        if (cancelled) {
          await vad.destroy();
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        vadRef.current = vad;
        await vad.start();
        if (cancelled) return;
        // Alex normally speaks first, so honour a hold that is already up.
        if (holdRef.current) await vad.pause();
        setStatus(holdRef.current ? 'held' : 'listening');
      } catch (err) {
        if (cancelled) return;
        console.error('[VAD] hands-free mode unavailable:', err);
        setStatus('error');
        setError(describeError(err));
      }
    })();

    /**
     * Hand the microphone back to the OS.
     *
     * Order matters. Stopping the tracks first releases the capture device
     * even if tearing down the VAD throws; doing it the other way round —
     * and swallowing the error, as this used to — stranded a live capture
     * stream on every re-initialisation. They accumulate: a desktop session
     * was found holding seventeen simultaneous streams on one microphone,
     * all from the same webview, which pins the device open and is exactly
     * the state where a freshly opened stream hears nothing.
     */
    const release = () => {
      const vad = vadRef.current;
      const stream = streamRef.current;
      vadRef.current = null;
      streamRef.current = null;
      levelRef.current = 0;
      stream?.getTracks().forEach((t) => t.stop());
      try {
        // Closes the VAD's own AudioContext, which is a second handle on the
        // device. Report failures rather than hiding them — a silent one here
        // is a leaked microphone.
        void vad?.destroy().catch((e) => console.warn('[VAD] teardown failed:', e));
      } catch (e) {
        console.warn('[VAD] teardown threw:', e);
      }
    };

    // React runs cleanup on unmount, but never for a reload or a full-page
    // navigation — and the desktop shell navigates this very webview from the
    // splash screen into the app. Without this the stream outlives the
    // document that opened it, with nothing left alive to close it.
    window.addEventListener('pagehide', release);

    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [enabled]);

  /**
   * Mute / unmute around Alex's turn, by connecting and disconnecting the VAD
   * from the audio graph.
   *
   * NOT by toggling `track.enabled`, which is the obvious way and is broken in
   * WebKitGTK — the Tauri desktop webview. Measured there: a live mic reads
   * 0.061 peak, goes to 0.020 while disabled, and then reads **0.000 forever**
   * once re-enabled, with the track still reporting live / enabled / unmuted.
   * The mic simply never comes back, so after Alex's first sentence the app sat
   * in "Listening" and could not hear a word. Chrome recovers; WebKitGTK does
   * not, and nothing about the track's own state says so.
   *
   * The VAD's pause/start only disconnect and rebuild the source node, leaving
   * the track untouched. Verified on the same webview: 0.061 -> 0.000 -> 0.215.
   * Pausing also resets the frame processor, which conveniently discards
   * whatever Alex leaked into the mic before the gate came down.
   */
  useEffect(() => {
    holdRef.current = hold;
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }

    // Serialised: pause and start are async, and a fast hold/unhold flip
    // (Alex speaking in short clauses) must not interleave them.
    const gate = (action: 'pause' | 'start') => {
      gateRef.current = gateRef.current
        .then(() => {
          const vad = vadRef.current;
          if (!vad) return;
          return action === 'pause' ? vad.pause() : vad.start();
        })
        .catch((e) => console.warn(`[VAD] ${action} failed:`, e));
    };

    if (hold) {
      levelRef.current = 0;
      gate('pause');
      setStatus((s) => (s === 'listening' || s === 'speech' ? 'held' : s));
      return;
    }

    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      gate('start');
      setStatus((s) => (s === 'held' ? 'listening' : s));
    }, RESUME_DELAY_MS);

    return () => {
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    };
  }, [hold]);

  // Retune a running VAD in place rather than rebuilding it.
  useEffect(() => {
    vadRef.current?.setOptions({ redemptionMs: endOfTurnMs });
  }, [endOfTurnMs]);

  return { status, error, getInputLevel };
}
