'use client';

import { useState, useRef, useCallback } from 'react';
import { Send, Mic, MicOff, Square, Loader2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VoiceActivityStatus } from '@/hooks/useVoiceActivity';

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
  /** Hands-free mode: no button to hold, so show mic state instead. */
  handsFree?: boolean;
  voiceStatus?: VoiceActivityStatus;
  voiceError?: string | null;
}

/** What the mic is doing right now, in the candidate's terms. */
const VOICE_HINTS: Record<VoiceActivityStatus, { label: string; className: string } | null> = {
  off: null,
  loading: { label: 'Starting mic', className: 'text-slate-400 border-slate-700 bg-slate-800' },
  listening: {
    label: 'Listening',
    className: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  },
  speech: {
    label: 'Hearing you',
    className: 'text-indigo-300 border-indigo-500/40 bg-indigo-500/15',
  },
  held: { label: 'Mic muted', className: 'text-slate-500 border-slate-700 bg-slate-800' },
  error: { label: 'Mic unavailable', className: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
};

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
  handsFree = false,
  voiceStatus = 'off',
  voiceError = null,
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
  const voiceHint = VOICE_HINTS[voiceStatus];

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
            {/* Hands-free: nothing to press, so the mic reports its own state.
                Push-to-talk keeps the button below. */}
            {handsFree && voiceHint && (
              <div
                className={cn(
                  'flex items-center gap-1.5 h-9 px-3 rounded-xl border text-xs font-medium shrink-0 transition-colors',
                  voiceHint.className
                )}
              >
                {voiceStatus === 'loading' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : voiceStatus === 'held' ? (
                  <MicOff className="w-3.5 h-3.5" />
                ) : (
                  <Mic className={cn('w-3.5 h-3.5', voiceStatus === 'speech' && 'animate-pulse')} />
                )}
                {voiceHint.label}
              </div>
            )}

            {/* Mic Button */}
            {!handsFree && !disabled && !isStreaming && onStartRecording && (
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
        {voiceError ? (
          <p className="flex items-center justify-center gap-1.5 text-xs text-amber-500/90 mt-2 text-center">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {voiceError}
          </p>
        ) : (
          <p className="text-xs text-slate-600 mt-2 text-center">
            {handsFree ? (
              <>Answer out loud &mdash; we&apos;ll send it when you pause &middot; or type and press{' '}
                <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">Enter</kbd>
              </>
            ) : (
              <>
                Press <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">Enter</kbd> to send &middot;{' '}
                <kbd className="px-1 py-0.5 bg-slate-800 rounded text-slate-500 font-mono">Shift+Enter</kbd> for new line
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
