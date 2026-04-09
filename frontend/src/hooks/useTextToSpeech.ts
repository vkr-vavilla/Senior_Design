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
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    
    if (engine === 'premium') {
      try {
        const audioBlob = await chatApi.synthesize(text);
        const url = URL.createObjectURL(audioBlob);
        playQueueRef.current.push({ type: 'url', value: url });
        processQueue();
      } catch (err) {
        // FALLBACK
        playQueueRef.current.push({ type: 'text', value: text });
        processQueue();
      }
    } else {
      playQueueRef.current.push({ type: 'text', value: text });
      processQueue();
    }
  }, [engine, processQueue]);

  const speakStream = useCallback(async (chunk: string) => {
    sentenceBufferRef.current += chunk;

    const sentenceEndRegex = /[.!?](\s|$)/;
    const match = sentenceEndRegex.exec(sentenceBufferRef.current);

    if (match) {
      const sentence = sentenceBufferRef.current.slice(0, match.index + 1).trim();
      sentenceBufferRef.current = sentenceBufferRef.current.slice(match.index + 1);

      if (sentence.length > 2) {
        if (engine === 'premium') {
          try {
            const blob = await chatApi.synthesize(sentence);
            const url = URL.createObjectURL(blob);
            playQueueRef.current.push({ type: 'url', value: url });
            processQueue();
          } catch (err) {
            // FALLBACK to browser voice if synthesis fails (rate limits)
            playQueueRef.current.push({ type: 'text', value: sentence });
            processQueue();
          }
        } else {
          playQueueRef.current.push({ type: 'text', value: sentence });
          processQueue();
        }
      }
    }
  }, [engine, processQueue]);

  const flush = useCallback(async () => {
    if (sentenceBufferRef.current.trim()) {
      const remaining = sentenceBufferRef.current.trim();
      sentenceBufferRef.current = '';
      
      if (engine === 'premium') {
        try {
          const blob = await chatApi.synthesize(remaining);
          const url = URL.createObjectURL(blob);
          playQueueRef.current.push({ type: 'url', value: url });
          processQueue();
        } catch (err) {
          playQueueRef.current.push({ type: 'text', value: remaining });
          processQueue();
        }
      } else {
        playQueueRef.current.push({ type: 'text', value: remaining });
        processQueue();
      }
    }
  }, [engine, processQueue]);

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
