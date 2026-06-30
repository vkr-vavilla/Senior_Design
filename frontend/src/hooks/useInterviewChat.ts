'use client';

import { generateId } from '@/lib/utils';
import type { ChatChunk, InterviewConfig, Message } from '@/types/chat';
import { useCallback, useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000';

interface UseInterviewChatReturn {
  messages: Message[];
  activeModelSource: 'local' | 'api';
  isConnected: boolean;
  isStreaming: boolean;
  sessionEnded: boolean;
  elapsedTime: number;
  sessionId: string | null;
  startInterview: (config: InterviewConfig, token: string, onChunk?: (chunk: string) => void, onDone?: () => void) => void;
  sendMessage: (text: string) => void;
  endInterview: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

export function useInterviewChat(): UseInterviewChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeModelSource, setActiveModelSource] = useState<'local' | 'api'>('local');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [inactivityWarning, setInactivityWarning] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingIdRef = useRef<string | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Timer cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const resetInactivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setInactivityWarning(false);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const endInterview = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    stopTimer();
    setSessionEnded(true);
    setIsConnected(false);
  }, [stopTimer]);

  const startTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedTime((t) => t + 1);

      const now = Date.now();
      const inactivityMs = now - lastActivityRef.current;
      const fifteenMinutesMs = 15 * 1000; // TEST VALUE: 15 seconds
      const sixteenMinutesMs = 20 * 1000; // TEST VALUE: 20 seconds (15s + 5s)

      if (inactivityMs >= sixteenMinutesMs) {
        endInterview();
      } else if (inactivityMs >= fifteenMinutesMs) {
        setInactivityWarning(true);
      }
    }, 1000);
  }, [endInterview]);

  const startInterview = useCallback(
    (config: InterviewConfig, token: string, onChunk?: (chunk: string) => void, onDone?: () => void) => {
      startTimer(); // Start timer immediately upon request
      if (wsRef.current) {
        wsRef.current.close();
      }

      // If we have an interviewId from the resume flow, use it as the session ID immediately
      if (config.interviewId) {
        setSessionId(config.interviewId);
      }

      const interviewIdParam = config.interviewId ? `&interview_id=${config.interviewId}` : '';
      const modelSourceParam = `&model_source=${encodeURIComponent(config.modelSource)}`;
      const ws = new WebSocket(`${WS_URL}/chat/ws?token=${token}${interviewIdParam}${modelSourceParam}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setMessages([]);
        setActiveModelSource(config.modelSource);
        setElapsedTime(0);
        setSessionEnded(false);
        setInactivityWarning(false);
        // startTimer(); // Removed from here

        // The backend handles the initial greeting now to avoid double-priming
        // if (config.interviewId) {
        //   const initialMessage = `I want to practice a ${config.difficulty} ${config.type} interview for a ${config.role} position. Please start the interview by greeting me and asking your first question.`;
        //   ws.send(JSON.stringify({ message: initialMessage }));
        // }
      };

      ws.onmessage = (event) => {
        try {
          const data: ChatChunk = JSON.parse(event.data);
          if (data.source) {
            setActiveModelSource(data.source);
          }

          if (!data.done) {
            setIsStreaming(true);

            if (!streamingIdRef.current) {
              // First chunk — create new AI message
              const newId = generateId();
              streamingIdRef.current = newId;
              setMessages((prev) => [
                ...prev,
                {
                  id: newId,
                  role: 'assistant' as const,
                  content: data.chunk,
                  isStreaming: true,
                },
              ]);
            } else {
              // Subsequent chunks — append to existing message
              const existingId = streamingIdRef.current;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === existingId
                    ? { ...msg, content: msg.content + data.chunk, isStreaming: true }
                    : msg
                )
              );
            }
            
            // Call the callback for Speech-to-Speech
            if (onChunk) {
              onChunk(data.chunk);
            }
          } else {
            // Stream complete
            const doneId = streamingIdRef.current;
            streamingIdRef.current = null;
            setIsStreaming(false);

            if (doneId) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === doneId ? { ...msg, isStreaming: false } : msg
                )
              );
            }
            
            if (onDone) onDone();
          }
        } catch (err) {
          console.error('Failed to parse WS message:', err);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsStreaming(false);
        stopTimer();
        setSessionEnded(true);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
        setIsStreaming(false);
        stopTimer();
      };
    },
    [startTimer, stopTimer]
  );

  const sendMessage = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected');
      return;
    }

    resetInactivity();

    // Add user message to UI
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: text,
    };

    setMessages((prev) => [...prev, userMessage]);
    streamingIdRef.current = null;

    wsRef.current.send(JSON.stringify({ message: text }));
  }, [resetInactivity]);

  return {
    messages,
    activeModelSource,
    isConnected,
    isStreaming,
    sessionEnded,
    inactivityWarning,
    elapsedTime,
    sessionId,
    startInterview,
    sendMessage,
    endInterview,
    resetInactivity,
    messagesEndRef,
  };
}
