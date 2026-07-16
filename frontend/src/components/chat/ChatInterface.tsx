import { Bot } from 'lucide-react';
import type { Message } from '@/types/chat';
import { MessageBubble } from './MessageBubble';

interface ChatInterfaceProps {
  messages: Message[];
  isStreaming: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

export function ChatInterface({ messages, isStreaming, messagesEndRef }: ChatInterfaceProps) {
  // Soft top fade so messages appear to dissolve into the avatar band above
  // as they scroll up, rather than being hard-clipped at the boundary. Top
  // padding is deliberately taller than the fade zone so the first message
  // (nothing scrolled above it yet) renders fully opaque instead of sitting
  // inside the fade with nothing to visually justify it.
  const FADE_HEIGHT = 56;
  const topFadeMask = `linear-gradient(to bottom, transparent, black ${FADE_HEIGHT}px)`;

  return (
    <div
      className="flex-1 overflow-y-auto px-4 pb-6"
      style={{
        paddingTop: FADE_HEIGHT + 16,
        maskImage: topFadeMask,
        WebkitMaskImage: topFadeMask,
      }}
    >
      <div className="max-w-3xl mx-auto space-y-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center">
              <Bot className="w-8 h-8 text-indigo-400" />
            </div>
            <div>
              <p className="text-slate-300 font-medium">The interview will begin shortly...</p>
              <p className="text-slate-500 text-sm mt-1">
                Your AI interviewer is preparing the first question.
              </p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))
        )}

        {/* Typing indicator */}
        {isStreaming && messages.length === 0 && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1.5 items-center h-4">
                <div className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <div className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
