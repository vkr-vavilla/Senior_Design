'use client';

import { generateId } from '@/lib/utils';
import type { ChatChunk, InterviewConfig, Message } from '@/types/chat';
import { useCallback, useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000';

interface UseInterviewChatReturn {
  messages: Message[];
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
    (config: InterviewConfig, token: string, onChunk?: (chunk: string) => void, onDone?: () => void) => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      // If we have an interviewId from the resume flow, use it as the session ID immediately
      if (config.interviewId) {
        setSessionId(config.interviewId);
      }

      // The JWT is sent as the first WS message instead of a query param so it
      // stays out of server/proxy access logs.
      const interviewIdParam = config.interviewId
        ? `?interview_id=${encodeURIComponent(config.interviewId)}`
        : '';
      const ws = new WebSocket(`${WS_URL}/chat/ws${interviewIdParam}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ token }));
        setIsConnected(true);
        setMessages([]);
        setElapsedTime(0);
        setSessionEnded(false);
        startTimer();

        // The backend handles the initial greeting now to avoid double-priming
        // if (config.interviewId) {
        //   const initialMessage = `I want to practice a ${config.difficulty} ${config.type} interview for a ${config.role} position. Please start the interview by greeting me and asking your first question.`;
        //   ws.send(JSON.stringify({ message: initialMessage }));
        // }
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
