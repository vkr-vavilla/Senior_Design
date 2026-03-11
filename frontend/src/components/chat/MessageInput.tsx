'use client';

import { useState, useRef, useCallback } from 'react';
import { Send } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
}

export function MessageInput({
  onSend,
  disabled = false,
  isStreaming = false,
  placeholder = 'Type your response...',
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
            disabled ? 'border-slate-800 opacity-60' : 'border-slate-700 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/20'
          )}
        >
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
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200',
              canSend
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'
                : 'bg-slate-800 text-slate-600 cursor-not-allowed'
            )}
            title={isStreaming ? 'Waiting for response...' : 'Send message (Enter)'}
          >
            {isStreaming ? (
              <svg
                className="animate-spin h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="text-xs text-slate-600 mt-2 text-center">
          Press <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">Enter</kbd> to send &middot;{' '}
          <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  );
}
