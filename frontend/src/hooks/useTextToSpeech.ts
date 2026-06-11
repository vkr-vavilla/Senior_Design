'use client';

import { useState, useCallback, useRef } from 'react';
import { chatApi } from '@/lib/api';

export type VoiceEngine = 'premium' | 'browser';

export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [engine, setEngine] = useState<VoiceEngine>('premium');
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sentenceBufferRef = useRef<string>('');

  // Queue stores items to play
  const playQueueRef = useRef<{ type: 'url' | 'text', value: string }[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  const premiumFailureCountRef = useRef<number>(0);
  const premiumDisabledUntilRef = useRef<number>(0);
  // Serializes synthesize requests so audio chunks enter the play queue in order
  const synthChainRef = useRef<Promise<void>>(Promise.resolve());

  const canUsePremium = useCallback(() => Date.now() >= premiumDisabledUntilRef.current, []);

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
  }, []);

  const stop = useCallback(() => {
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
    
    if (engine === 'premium' && canUsePremium()) {
      try {
        const audioBlob = await chatApi.synthesize(text);
        handlePremiumSuccess();
        const url = URL.createObjectURL(audioBlob);
        playQueueRef.current.push({ type: 'url', value: url });
        processQueue();
      } catch (err) {
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
        if (engine === 'premium' && canUsePremium()) {
          // Chain synth requests so the play queue is populated in order even if
          // a shorter clause finishes synthesis faster than an earlier longer one.
          synthChainRef.current = synthChainRef.current.then(async () => {
            try {
              const blob = await chatApi.synthesize(sentence);
              handlePremiumSuccess();
              const url = URL.createObjectURL(blob);
              playQueueRef.current.push({ type: 'url', value: url });
              processQueue();
            } catch (err) {
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

      if (engine === 'premium' && canUsePremium()) {
        synthChainRef.current = synthChainRef.current.then(async () => {
          try {
            const blob = await chatApi.synthesize(remaining);
            handlePremiumSuccess();
            const url = URL.createObjectURL(blob);
            playQueueRef.current.push({ type: 'url', value: url });
            processQueue();
          } catch (err) {
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
  };
}
