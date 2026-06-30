'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface UseSpeechRecognitionOptions {
  onResult?: (text: string) => void;
}

export function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef<any>(null);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptRef = useRef('');
  const isListeningRef = useRef(false);

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

  // Silence timeout logic removed.

  const startListening = useCallback((options?: UseSpeechRecognitionOptions) => {
    if (!isSupported) {
      console.warn('Speech recognition is not supported in this browser.');
      return;
    }

    // Stop and completely clean up any existing instance
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.abort();
      } catch (e) {
        // ignore
      }
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
    isListeningRef.current = true;

    recognition.onresult = (event: any) => {
      if (!isListeningRef.current) return;
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
      }
    };

    recognition.onerror = (event: any) => {
      if (!isListeningRef.current) return;
      console.error('Speech recognition error:', event.error);
      if (event.error === 'no-speech') {
        // Silently ignore or handle
      } else {
        setIsListening(false);
        isListeningRef.current = false;
        if (silenceTimeoutRef.current) {
          clearTimeout(silenceTimeoutRef.current);
        }
      }
    };

    recognition.onend = () => {
      if (!isListeningRef.current) return;
      setIsListening(false);
      isListeningRef.current = false;
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }
    };

    recognition.start();
  }, [isSupported]);

  const stopListening = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = null;
      }

      const currentTranscript = transcriptRef.current;

      isListeningRef.current = false;
      setIsListening(false);

      if (recognitionRef.current) {
        // Clear handlers immediately to avoid firing stale callbacks or hanging the promise
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        try {
          recognitionRef.current.stop();
        } catch (e) {
          // ignore
        }
      }
      resolve(currentTranscript);
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
