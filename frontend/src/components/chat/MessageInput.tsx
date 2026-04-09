'use client';

import { useState, useRef, useCallback } from 'react';
import { Send, Mic, Square, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
  onTranscribe?: (audio: Blob) => Promise<void>;
  isRecording?: boolean;
  recordingTime?: number;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
}

export function MessageInput({
  onSend,
  disabled = false,
  isStreaming = false,
  placeholder = 'Type your response...',
  onTranscribe,
  isRecording = false,
  recordingTime = 0,
  onStartRecording,
  onStopRecording,
}: MessageInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 120; // ~4 lines
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    adjustHeight();
  };

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isStreaming) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, isStreaming, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = value.trim().length > 0 && !disabled && !isStreaming;

  return (
    <div className="border-t border-slate-800 bg-slate-950 px-4 py-4">
      <div className="max-w-3xl mx-auto">
        <div
          className={cn(
            'flex items-end gap-3 bg-slate-900 border rounded-2xl px-4 py-3 transition-all duration-200',
            disabled ? 'border-slate-800 opacity-60' : 'border-slate-700 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/20',
            isRecording && 'border-red-500/50 ring-1 ring-red-500/20'
          )}
        >
          {/* Recording Indicator */}
          {isRecording ? (
            <div className="flex-1 flex items-center gap-3 h-[24px]">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-xs font-mono text-red-500">
                  {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                </span>
              </div>
              <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-red-500/50 animate-[shimmer_2s_infinite] w-full" />
              </div>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={disabled ? 'Interview has ended' : placeholder}
              disabled={disabled}
              rows={1}
              className={cn(
                'flex-1 bg-transparent text-white placeholder:text-slate-500 text-sm resize-none focus:outline-none leading-relaxed min-h-[24px] max-h-[120px]',
                disabled && 'cursor-not-allowed'
              )}
            />
          )}

          <div className="flex items-center gap-2">
            {/* Mic Button */}
            {!disabled && !isStreaming && onStartRecording && (
              <button
                onClick={isRecording ? onStopRecording : onStartRecording}
                className={cn(
                  'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200',
                  isRecording 
                    ? 'bg-red-500 text-white animate-pulse' 
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                )}
                title={isRecording ? 'Stop recording' : 'Record response'}
              >
                {isRecording ? <Square className="w-4 h-4 fill-current" /> : <Mic className="w-4 h-4" />}
              </button>
            )}

            {/* Send Button */}
            <button
              onClick={handleSend}
              disabled={!canSend || isRecording}
              className={cn(
                'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200',
                canSend && !isRecording
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'
                  : 'bg-slate-800 text-slate-600 cursor-not-allowed'
              )}
              title={isStreaming ? 'Waiting for response...' : 'Send message (Enter)'}
            >
              {isStreaming ? (
                <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-600 mt-2 text-center">
          Press <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">Enter</kbd> to send &middot;{' '}
          <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  );
}
