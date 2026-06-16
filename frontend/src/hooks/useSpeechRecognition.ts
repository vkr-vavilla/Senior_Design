'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface UseSpeechRecognitionOptions {
  onResult?: (text: string) => void;
  onSilenceTimeout?: (finalText: string) => void;
}

export function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef<any>(null);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptRef = useRef('');

  // Save latest transcript in ref to avoid closure issues in callbacks
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  // Check support on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        setIsSupported(true);
      }
    }
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const resetSilenceTimer = useCallback((onTimeoutCallback: (finalText: string) => void) => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }

    silenceTimeoutRef.current = setTimeout(() => {
      console.log('DEBUG: 10s silence timeout triggered');
      if (recognitionRef.current) {
        recognitionRef.current.stop(); // This triggers onend which cleans up
      }
      const text = transcriptRef.current;
      transcriptRef.current = '';
      setTranscript('');
      onTimeoutCallback(text);
    }, 10000); // 10 seconds of silence
  }, []);

  const startListening = useCallback((options?: UseSpeechRecognitionOptions) => {
    if (!isSupported) {
      console.warn('Speech recognition is not supported in this browser.');
      return;
    }

    // Stop any existing instance
    if (recognitionRef.current) {
      recognitionRef.current.abort();
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognitionRef.current = recognition;
    setTranscript('');
    transcriptRef.current = '';
    setIsListening(true);

    const handleTimeout = (text: string) => {
      if (options?.onSilenceTimeout) {
        options.onSilenceTimeout(text);
      }
    };

    // Initial 10-second silence timer
    resetSilenceTimer(handleTimeout);

    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      // Combine previous stable transcript + newly finalized + interim
      const currentResult = (finalTranscript || interimTranscript).trim();
      
      // If we have text, update state
      if (currentResult) {
        // We compile a full transcript since start
        let fullText = '';
        for (let i = 0; i < event.results.length; ++i) {
          fullText += event.results[i][0].transcript + ' ';
        }
        const cleanedFullText = fullText.trim();
        setTranscript(cleanedFullText);

        if (options?.onResult) {
          options.onResult(cleanedFullText);
        }
        // Reset silence timer on active speaking/results
        resetSilenceTimer(handleTimeout);
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'no-speech') {
        // Silently ignore or handle
      } else {
        setIsListening(false);
        if (silenceTimeoutRef.current) {
          clearTimeout(silenceTimeoutRef.current);
        }
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }
    };

    recognition.start();
  }, [isSupported, resetSilenceTimer]);

  const stopListening = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = null;
      }

      if (recognitionRef.current) {
        recognitionRef.current.onend = () => {
          setIsListening(false);
          resolve(transcriptRef.current);
        };
        recognitionRef.current.stop();
      } else {
        setIsListening(false);
        resolve(transcriptRef.current);
      }
    });
  }, []);

  return {
    isListening,
    transcript,
    isSupported,
    startListening,
    stopListening,
    setTranscript,
  };
}
