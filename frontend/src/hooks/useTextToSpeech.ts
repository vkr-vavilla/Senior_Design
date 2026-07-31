'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { chatApi } from '@/lib/api';

export type VoiceEngine = 'premium' | 'browser';

// The Tauri desktop webview (WebKitGTK on Linux) does not implement the Web
// Speech API, so window.speechSynthesis is undefined there. Access it only
// through this guard so calls no-op instead of throwing a TypeError.
const getSpeechSynthesis = (): SpeechSynthesis | null =>
  typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

export function useTextToSpeech(token?: string) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  // True from the moment a clip is queued for synthesis until the last one has
  // finished playing — i.e. "Alex has the floor", gaps included. isSpeaking
  // only covers audio that is actually coming out of the speakers right now.
  const [isBusy, setIsBusy] = useState(false);
  const [engine, setEngine] = useState<VoiceEngine>('premium');
  // The browser refused to play audio at all (autoplay policy). Surfaced so
  // the UI can say so instead of the interview just going quiet.
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const playbackBlockedRef = useRef(false);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sentenceBufferRef = useRef<string>('');
  const playSessionIdRef = useRef<number>(0);

  // Live voice-amplitude analysis (drives the SiriWave avatar). Each premium
  // Audio element gets its own AnalyserNode tapped into the playback graph —
  // MediaElementSource redirects output through the graph, so the analyser
  // must stay connected to destination or audio would go silent.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelDataRef = useRef<Uint8Array | null>(null);
  const smoothedLevelRef = useRef<number>(0);

  // Queue stores items to play
  const playQueueRef = useRef<{ type: 'url' | 'text', value: string }[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  // Synthesis requests that have been fired but whose audio has not reached the
  // queue yet. Tracked because isSpeaking alone briefly reads false in the gap
  // between two clips, and hands-free mode uses that signal to decide when to
  // un-mute the mic — a false gap there means the mic opens while Alex is
  // mid-sentence and the VAD transcribes his voice as the candidate's answer.
  const pendingSynthRef = useRef<number>(0);
  // Whether this reply has already emitted its opening clause. Only that first
  // one cuts early for a fast start; the rest wait for sentence ends.
  const hasSpokenClauseRef = useRef<boolean>(false);
  const premiumFailureCountRef = useRef<number>(0);
  const premiumDisabledUntilRef = useRef<number>(0);
  // Serializes synthesize requests so audio chunks enter the play queue in order
  const synthChainRef = useRef<Promise<void>>(Promise.resolve());
  const tokenRef = useRef<string | undefined>(token);
  tokenRef.current = token;

  const canUsePremium = useCallback(() => Date.now() >= premiumDisabledUntilRef.current, []);

  /** Recompute "Alex has the floor" from the three refs that can change it. */
  const syncBusy = useCallback(() => {
    setIsBusy(
      isPlayingRef.current || playQueueRef.current.length > 0 || pendingSynthRef.current > 0
    );
  }, []);

  const ensureAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }, []);

  /**
   * The one and only <audio> element, reused for every clip.
   *
   * Deliberately not one element per clip. Browsers grant autoplay permission
   * per media element, to the element a user gesture touched — so a fresh
   * element created seconds later has no gesture behind it and play() rejects
   * with NotAllowedError. In the Tauri webview (WebKitGTK) this was stark:
   * Alex's opening line played, because its element was created moments after
   * the click that started the interview, and every clip after it was refused.
   * Reusing one gesture-unlocked element keeps the permission.
   *
   * It also fixes a quieter bug: createMediaElementSource may be called only
   * once per element, so the old code built a new source node per clip and
   * left every previous one connected to the context.
   */
  const ensureAudioElement = useCallback((): HTMLAudioElement | null => {
    if (typeof window === 'undefined') return null;
    if (audioRef.current) return audioRef.current;

    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;

    // Analyser attaches once, to this element, for its whole lifetime.
    try {
      const ctx = ensureAudioContext();
      if (ctx) {
        const source = ctx.createMediaElementSource(audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        analyserRef.current = analyser;
        levelDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      }
    } catch (err) {
      console.warn('[TTS] amplitude analyser attach failed (playback unaffected):', err);
    }
    return audio;
  }, [ensureAudioContext]);

  /**
   * Call from a real user gesture (the click that starts the interview) to buy
   * playback permission for the whole session. Both things below are only
   * grantable from inside a gesture handler, and both are silently refused
   * outside one — which is why this cannot live in an effect.
   */
  const unlockPlayback = useCallback(() => {
    const ctx = ensureAudioContext();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});

    const audio = ensureAudioElement();
    if (!audio) return;
    // A no-op play/pause is enough to mark the element as user-activated.
    audio.muted = true;
    audio
      .play()
      .then(() => {
        audio.pause();
        audio.muted = false;
      })
      .catch(() => {
        // Nothing to play yet is fine — the activation still counts.
        audio.muted = false;
      });
  }, [ensureAudioContext, ensureAudioElement]);

  // Polled every animation frame by SiriWave via getAmplitude — not React
  // state, since audio level changes far faster than a re-render should.
  const getAudioLevel = useCallback((): number => {
    const analyser = analyserRef.current;
    const data = levelDataRef.current;
    const audio = audioRef.current;
    let target = 0;
    if (analyser && data && audio && !audio.paused) {
      // TS's lib.dom types getByteTimeDomainData as Uint8Array<ArrayBuffer>,
      // stricter than the Uint8Array<ArrayBufferLike> `new Uint8Array(n)`
      // actually returns — functionally identical, cast to satisfy the checker.
      analyser.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>);
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / data.length);
      // Speech RMS on this waveform data is quiet; boost for a visibly alive wave.
      target = Math.min(1, rms * 4);
    } else if (engine === 'browser' && isSpeaking) {
      // Web Speech API exposes no waveform data — fake a gentle pulse so the
      // wave still visibly reacts instead of going flat during fallback playback.
      target = 0.35 + 0.2 * Math.sin(Date.now() / 140);
    }
    // Attack/release smoothing so the wave doesn't jitter frame to frame.
    smoothedLevelRef.current += (target - smoothedLevelRef.current) * 0.35;
    return smoothedLevelRef.current;
  }, [engine, isSpeaking]);

  const handlePremiumFailure = useCallback(() => {
    premiumFailureCountRef.current += 1;

    // After repeated failures, cool down premium mode and force browser voice
    // — but only where a browser voice exists. The Tauri webview (WebKitGTK)
    // has no speechSynthesis, so switching engines there doesn't degrade the
    // voice, it silences it: every queued sentence becomes a no-op skip. In
    // that environment keep trying the server; a lost clip beats a mute Alex.
    if (premiumFailureCountRef.current >= 2 && getSpeechSynthesis()) {
      premiumDisabledUntilRef.current = Date.now() + 60000;
      premiumFailureCountRef.current = 0;
      setEngine('browser');
    }
  }, []);

  const handlePremiumSuccess = useCallback(() => {
    premiumFailureCountRef.current = 0;
  }, []);

  const processQueue = useCallback(async () => {
    if (isPlayingRef.current || playQueueRef.current.length === 0) return;

    isPlayingRef.current = true;
    const item = playQueueRef.current.shift()!;
    setIsSpeaking(true);
    syncBusy();

    // Playback finished (or failed) — release the queue and, if nothing is
    // left to play or synthesize, hand the floor back to the candidate.
    const advance = () => {
      setIsSpeaking(false);
      isPlayingRef.current = false;
      syncBusy();
      processQueue();
    };

    if (item.type === 'url') {
      const audio = ensureAudioElement();
      if (!audio) {
        URL.revokeObjectURL(item.value);
        advance();
        return;
      }

      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        URL.revokeObjectURL(item.value);
        audio.onended = null;
        audio.onerror = null;
        audio.onloadedmetadata = null;
        advance();
      };
      audio.onended = done;
      audio.onerror = done;
      // Watchdog: if 'ended' never fires (playback wedged in the webview),
      // advance anyway once the clip must be over. A lost clip costs a few
      // words; a wedged queue holds isBusy up forever, which keeps the mic
      // gated — the candidate loses the ability to answer at all.
      watchdog = setTimeout(done, 30000);
      audio.onloadedmetadata = () => {
        if (settled || !isFinite(audio.duration)) return;
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(done, audio.duration * 1000 + 4000);
      };

      audio.src = item.value;
      try {
        await audio.play();
        playbackBlockedRef.current = false;
      } catch (err) {
        // NotAllowedError here means the browser refused autoplay — the
        // element never got a user gesture. Report it once: the alternative
        // is an interview that silently stops speaking, which reads as a
        // broken app rather than a permission the user could grant.
        if (!playbackBlockedRef.current) {
          playbackBlockedRef.current = true;
          const name = err instanceof Error ? err.name : String(err);
          console.warn(`[TTS] playback refused by the browser (${name})`);
          setPlaybackBlocked(true);
        }
        done();
      }
    } else {
      const synth = getSpeechSynthesis();
      if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
        // No browser TTS in this environment (e.g. Tauri/WebKitGTK) — skip the
        // spoken fallback and advance the queue so playback never stalls.
        advance();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(item.value);
      const voices = synth.getVoices();
      const voice = voices.find(v => v.name.includes('Google US English') || v.name.includes('Samantha') || v.lang.startsWith('en'));
      if (voice) utterance.voice = voice;

      utterance.onend = advance;
      utterance.onerror = advance;

      synth.speak(utterance);
    }
  }, [ensureAudioElement, syncBusy]);

  // Every interview mounts a fresh instance of this hook, and WebKitGTK does
  // not garbage-collect audio pipelines just because React let go of them.
  // Without this cleanup each restarted interview stacked another live
  // AudioContext + media element in the webview: the first session played
  // fine, and later ones played one clip and wedged — same leak class as the
  // seventeen stranded microphone streams on the VAD side.
  useEffect(() => {
    const release = () => {
      const audio = audioRef.current;
      audioRef.current = null;
      analyserRef.current = null;
      levelDataRef.current = null;
      if (audio) {
        audio.pause();
        audio.onended = null;
        audio.onerror = null;
        audio.removeAttribute('src');
      }
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      void ctx?.close().catch(() => {});
    };
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('pagehide', release);
      release();
    };
  }, []);

  const stop = useCallback(() => {
    playSessionIdRef.current += 1;
    smoothedLevelRef.current = 0;
    if (audioRef.current) {
      // Pause, but keep the element. Discarding it would throw away the
      // autoplay permission the start-of-interview gesture bought us, and
      // nothing later in the session can earn it back.
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
    }
    getSpeechSynthesis()?.cancel();
    playQueueRef.current = [];
    isPlayingRef.current = false;
    // In-flight synthesis requests bail out on the session-id check, so their
    // audio never reaches the queue — drop the count with them.
    pendingSynthRef.current = 0;
    setIsSpeaking(false);
    setIsBusy(false);
    sentenceBufferRef.current = '';
    hasSpokenClauseRef.current = false;
    synthChainRef.current = Promise.resolve();
  }, []);

  /**
   * Fetch one clause's audio and queue it, falling back to the browser voice
   * if the server can't. Assumes the caller already reserved a pending slot
   * (see speakClause) and releases it here, whatever the outcome.
   */
  const synthesizeReserved = useCallback(async (text: string, sessionId: number) => {
    try {
      const blob = await chatApi.synthesize(text, tokenRef.current);
      // A newer session means stop() ran — the user ended the interview or
      // muted Alex while this was in flight — so this audio is stale.
      if (playSessionIdRef.current !== sessionId) return;
      handlePremiumSuccess();
      playQueueRef.current.push({ type: 'url', value: URL.createObjectURL(blob) });
    } catch (err) {
      if (playSessionIdRef.current !== sessionId) return;
      handlePremiumFailure();
      playQueueRef.current.push({ type: 'text', value: text });
    } finally {
      pendingSynthRef.current = Math.max(0, pendingSynthRef.current - 1);
      syncBusy();
    }
    processQueue();
  }, [handlePremiumFailure, handlePremiumSuccess, processQueue, syncBusy]);

  /**
   * Speak one clause. Synchronous on purpose: the pending slot is reserved
   * before the request is even scheduled on the chain, so there is no instant
   * where a clause is spoken-for but nothing reads as busy — that instant is
   * exactly when hands-free mode would wrongly re-open the mic.
   */
  const speakClause = useCallback((text: string) => {
    if (engine === 'premium' && canUsePremium()) {
      const sessionId = playSessionIdRef.current;
      pendingSynthRef.current += 1;
      syncBusy();
      // Chain synth requests so the play queue is populated in order even if
      // a shorter clause finishes synthesis faster than an earlier longer one.
      synthChainRef.current = synthChainRef.current.then(
        () => synthesizeReserved(text, sessionId)
      );
    } else {
      playQueueRef.current.push({ type: 'text', value: text });
      syncBusy();
      processQueue();
    }
  }, [engine, canUsePremium, synthesizeReserved, processQueue, syncBusy]);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    speakClause(text);
  }, [speakClause]);

  const speakStream = useCallback(async (chunk: string) => {
    sentenceBufferRef.current += chunk;

    // Every cut is a separate synth request, and every seam between clips is
    // a place for an audible gap. Kokoro on CPU synthesizes at ~1-2 s per
    // clause (measured), so lots of small clips means lots of small silences,
    // heard as Alex "cutting off". The shape that minimises seams while still
    // starting fast: cut the FIRST clause early so the voice starts within a
    // couple of seconds, then accumulate whole groups of sentences and send
    // them as one big clip each — a typical reply becomes 2-3 clips total,
    // with clip N+1 synthesizing while clip N plays.
    //
    // Dashes are deliberately NOT a cut point: " - " and " — " are common in
    // LLM output and splitting there put a gap exactly where the dash was,
    // which read as Kokoro stumbling over the punctuation.
    const buf = sentenceBufferRef.current;
    const firstClause = !hasSpokenClauseRef.current;
    let cutIndex = -1;
    if (firstClause) {
      if (buf.length >= 18) {
        const strong = /[.!?](\s|$)/.exec(buf);
        const soft = /[,;:](\s|$)/.exec(buf);
        const candidates = [strong, soft].filter(Boolean) as RegExpExecArray[];
        if (candidates.length) {
          cutIndex = Math.min(...candidates.map(m => m.index + 1));
        } else if (buf.length > 80) {
          const lastSpace = buf.lastIndexOf(' ', 80);
          if (lastSpace > 18) cutIndex = lastSpace;
        }
      }
    } else if (buf.length >= 200) {
      // Big chunk: only cut at a sentence end once enough has accumulated.
      // The tail of the reply (whatever is left when the stream finishes) goes
      // out via flush(), so short replies are exactly two clips.
      let last = -1;
      const re = /[.!?](\s|$)/g;
      for (let m = re.exec(buf); m; m = re.exec(buf)) last = m.index + 1;
      if (last > 0) {
        cutIndex = last;
      } else if (buf.length > 400) {
        // Runaway text with no sentence ends — break at a word boundary
        // rather than let the whole reply queue up behind it.
        const lastSpace = buf.lastIndexOf(' ', 380);
        if (lastSpace > 0) cutIndex = lastSpace;
      }
    }

    if (cutIndex > 0) {
      const sentence = buf.slice(0, cutIndex).trim();
      sentenceBufferRef.current = buf.slice(cutIndex);

      if (sentence.length > 2) {
        hasSpokenClauseRef.current = true;
        speakClause(sentence);
      }
    }
  }, [speakClause]);

  const flush = useCallback(async () => {
    const remaining = sentenceBufferRef.current.trim();
    // End of this reply — the next one starts fast again.
    hasSpokenClauseRef.current = false;
    if (!remaining) return;
    sentenceBufferRef.current = '';
    speakClause(remaining);
  }, [speakClause]);

  return {
    isSpeaking,
    isBusy,
    playbackBlocked,
    unlockPlayback,
    engine,
    setEngine,
    speak,
    speakStream,
    stop,
    flush,
    getAudioLevel,
  };
}
