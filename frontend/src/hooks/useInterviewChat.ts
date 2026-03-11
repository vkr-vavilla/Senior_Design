'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { Message, InterviewConfig, ChatChunk } from '@/types/chat';
import { generateId } from '@/lib/utils';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000';

interface UseInterviewChatReturn {
  messages: Message[];
  isConnected: boolean;
  isStreaming: boolean;
  sessionEnded: boolean;
  elapsedTime: number;
  sessionId: string | null;
  startInterview: (config: InterviewConfig, token: string) => void;
  sendMessage: (text: string) => void;
  endInterview: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

export function useInterviewChat(): UseInterviewChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
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

  const startTimer = useCallback(() => {
    timerRef.current = setInterval(() => {
      setElapsedTime((t) => t + 1);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startInterview = useCallback(
    (config: InterviewConfig, token: string) => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      const ws = new WebSocket(`${WS_URL}/chat/ws?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setMessages([]);
        setElapsedTime(0);
        setSessionEnded(false);
        startTimer();

        // Send initial message to kick off the interview
        const initialMessage = `I want to practice a ${config.difficulty} ${config.type} interview for a ${config.role} position. Please start the interview by greeting me and asking your first question.`;

        ws.send(JSON.stringify({ message: initialMessage }));

        // Add initial message to chat (as a hidden/system trigger — show it as user context)
        // We actually just show the AI response; skip showing the system prompt
      };

      ws.onmessage = (event) => {
        try {
          const data: ChatChunk = JSON.parse(event.data);

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
          }
        } catch (err) {
          console.error('Failed to parse WS message:', err);
        }
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        setIsStreaming(false);
        stopTimer();

        // Try to extract session ID from close event or generate one
        // The backend saves the session on close
        if (!sessionId) {
          setSessionId(generateId());
        }

        if (!sessionEnded) {
          setSessionEnded(true);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
        setIsStreaming(false);
        stopTimer();
      };
    },
    [startTimer, stopTimer, sessionId, sessionEnded]
  );

  const sendMessage = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected');
      return;
    }

    // Add user message to UI
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: text,
    };

    setMessages((prev) => [...prev, userMessage]);
    streamingIdRef.current = null;

    wsRef.current.send(JSON.stringify({ message: text }));
  }, []);

  const endInterview = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    stopTimer();
    setSessionEnded(true);
    setIsConnected(false);
  }, [stopTimer]);

  return {
    messages,
    isConnected,
    isStreaming,
    sessionEnded,
    elapsedTime,
    sessionId,
    startInterview,
    sendMessage,
    endInterview,
    messagesEndRef,
  };
}
