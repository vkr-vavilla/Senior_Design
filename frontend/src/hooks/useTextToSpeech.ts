'use client';

import { useState, useCallback, useRef } from 'react';
import { chatApi } from '@/lib/api';

export type VoiceEngine = 'premium' | 'browser';

export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [engine, setEngine] = useState<VoiceEngine>('premium');
  
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
  const premiumFailureCountRef = useRef<number>(0);
  const premiumDisabledUntilRef = useRef<number>(0);
  // Serializes synthesize requests so audio chunks enter the play queue in order
  const synthChainRef = useRef<Promise<void>>(Promise.resolve());

  const canUsePremium = useCallback(() => Date.now() >= premiumDisabledUntilRef.current, []);

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

  // Taps an analyser onto a freshly-created Audio element. Same-origin blob
  // URLs (from chatApi.synthesize) never taint the WebAudio graph, so this is
  // safe; wrapped defensively anyway since a failure here must never break
  // playback, only wave reactivity.
  const attachAnalyser = useCallback((audio: HTMLAudioElement) => {
    try {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      levelDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    } catch (err) {
      console.warn('[TTS] amplitude analyser attach failed (playback unaffected):', err);
    }
  }, [ensureAudioContext]);

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

    // After repeated failures, cool down premium mode and force browser voice.
    if (premiumFailureCountRef.current >= 2) {
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

    if (item.type === 'url') {
      const audio = new Audio(item.value);
      audioRef.current = audio;
      attachAnalyser(audio);

      audio.onended = () => {
        setIsSpeaking(false);
        isPlayingRef.current = false;
        URL.revokeObjectURL(item.value);
        processQueue();
      };

      audio.onerror = () => {
        setIsSpeaking(false);
        isPlayingRef.current = false;
        processQueue();
      };

      try {
        await audio.play();
      } catch (err) {
        setIsSpeaking(false);
        isPlayingRef.current = false;
        processQueue();
      }
    } else {
      const utterance = new SpeechSynthesisUtterance(item.value);
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find(v => v.name.includes('Google US English') || v.name.includes('Samantha') || v.lang.startsWith('en'));
      if (voice) utterance.voice = voice;

      utterance.onend = () => {
        setIsSpeaking(false);
        isPlayingRef.current = false;
        processQueue();
      };

      utterance.onerror = () => {
        setIsSpeaking(false);
        isPlayingRef.current = false;
        processQueue();
      };

      window.speechSynthesis.speak(utterance);
    }
  }, [attachAnalyser]);

  const stop = useCallback(() => {
    playSessionIdRef.current += 1;
    smoothedLevelRef.current = 0;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    window.speechSynthesis.cancel();
    playQueueRef.current = [];
    isPlayingRef.current = false;
    setIsSpeaking(false);
    sentenceBufferRef.current = '';
    synthChainRef.current = Promise.resolve();
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    
    const currentSessionId = playSessionIdRef.current;
    if (engine === 'premium' && canUsePremium()) {
      try {
        const audioBlob = await chatApi.synthesize(text);
        if (playSessionIdRef.current !== currentSessionId) return;
        handlePremiumSuccess();
        const url = URL.createObjectURL(audioBlob);
        playQueueRef.current.push({ type: 'url', value: url });
        processQueue();
      } catch (err) {
        if (playSessionIdRef.current !== currentSessionId) return;
        handlePremiumFailure();
        // FALLBACK
        playQueueRef.current.push({ type: 'text', value: text });
        processQueue();
      }
    } else {
      playQueueRef.current.push({ type: 'text', value: text });
      processQueue();
    }
  }, [engine, canUsePremium, handlePremiumFailure, handlePremiumSuccess, processQueue]);

  const speakStream = useCallback(async (chunk: string) => {
    sentenceBufferRef.current += chunk;

    // Flush at the first natural pause: sentence end, comma, semicolon, colon, or dash.
    // This lets the voice start within ~1 sec instead of waiting for a full sentence.
    const buf = sentenceBufferRef.current;
    const minChars = 18;
    let cutIndex = -1;
    if (buf.length >= minChars) {
      const strong = /[.!?](\s|$)/.exec(buf);
      const soft = /[,;:](\s|$)/.exec(buf);
      const dash = / [—-] /.exec(buf);
      const candidates = [strong, soft, dash].filter(Boolean) as RegExpExecArray[];
      if (candidates.length) {
        cutIndex = Math.min(...candidates.map(m => m.index + 1));
      } else if (buf.length > 80) {
        // Hard cut if a clause runs too long without punctuation
        const lastSpace = buf.lastIndexOf(' ', 80);
        if (lastSpace > minChars) cutIndex = lastSpace;
      }
    }

    if (cutIndex > 0) {
      const sentence = buf.slice(0, cutIndex).trim();
      sentenceBufferRef.current = buf.slice(cutIndex);

      if (sentence.length > 2) {
        const currentSessionId = playSessionIdRef.current;
        if (engine === 'premium' && canUsePremium()) {
          // Chain synth requests so the play queue is populated in order even if
          // a shorter clause finishes synthesis faster than an earlier longer one.
          synthChainRef.current = synthChainRef.current.then(async () => {
            try {
              const blob = await chatApi.synthesize(sentence);
              if (playSessionIdRef.current !== currentSessionId) return;
              handlePremiumSuccess();
              const url = URL.createObjectURL(blob);
              playQueueRef.current.push({ type: 'url', value: url });
              processQueue();
            } catch (err) {
              if (playSessionIdRef.current !== currentSessionId) return;
              handlePremiumFailure();
              // FALLBACK to browser voice if synthesis fails (rate limits)
              playQueueRef.current.push({ type: 'text', value: sentence });
              processQueue();
            }
          });
        } else {
          playQueueRef.current.push({ type: 'text', value: sentence });
          processQueue();
        }
      }
    }
  }, [engine, canUsePremium, handlePremiumFailure, handlePremiumSuccess, processQueue]);

  const flush = useCallback(async () => {
    if (sentenceBufferRef.current.trim()) {
      const remaining = sentenceBufferRef.current.trim();
      sentenceBufferRef.current = '';

      const currentSessionId = playSessionIdRef.current;
      if (engine === 'premium' && canUsePremium()) {
        synthChainRef.current = synthChainRef.current.then(async () => {
          try {
            const blob = await chatApi.synthesize(remaining);
            if (playSessionIdRef.current !== currentSessionId) return;
            handlePremiumSuccess();
            const url = URL.createObjectURL(blob);
            playQueueRef.current.push({ type: 'url', value: url });
            processQueue();
          } catch (err) {
            if (playSessionIdRef.current !== currentSessionId) return;
            handlePremiumFailure();
            playQueueRef.current.push({ type: 'text', value: remaining });
            processQueue();
          }
        });
      } else {
        playQueueRef.current.push({ type: 'text', value: remaining });
        processQueue();
      }
    }
  }, [engine, canUsePremium, handlePremiumFailure, handlePremiumSuccess, processQueue]);

  return {
    isSpeaking,
    engine,
    setEngine,
    speak,
    speakStream,
    stop,
    flush,
    getAudioLevel,
  };
}
