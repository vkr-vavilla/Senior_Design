'use client';

import { interviewApi } from '@/lib/api';
import type { Session } from '@/types/chat';
import { Brain, Briefcase, ChevronRight, Clock, Layers, MessageSquare, Shuffle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const TYPE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  technical: { label: 'Technical', icon: Brain, color: 'text-indigo-400' },
  behavioral: { label: 'Behavioral', icon: Briefcase, color: 'text-violet-400' },
  mixed: { label: 'Mixed', icon: Shuffle, color: 'text-sky-400' },
};

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  hard: 'text-red-400 bg-red-500/10 border-red-500/20',
};

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface Props {
  token: string;
}

export function RecentSessions({ token }: Props) {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    interviewApi
      .getSessions(token)
      .then(setSessions)
      .catch(() => setError(true))
      .finally(() => setIsLoading(false));
  }, [token]);

  const handleSessionClick = (session: Session) => {
    if (session.feedback) {
      router.push(`/interview/${session._id}/feedback`);
    } else {
      router.push(
        `/interview?role=${encodeURIComponent(session.role)}&type=${session.interview_type}&difficulty=${session.difficulty}&interviewId=${session._id}`
      );
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="w-4 h-4 text-slate-400" />
        <h3 className="font-semibold text-white text-sm">Recent Sessions</h3>
        {!isLoading && sessions.length > 0 && (
          <span className="ml-auto text-xs text-slate-500">{sessions.length}</span>
        )}
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-slate-800/50 animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && error && (
        <p className="text-xs text-slate-500 text-center py-6">Failed to load sessions.</p>
      )}

      {!isLoading && !error && sessions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
          <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center">
            <Layers className="w-5 h-5 text-slate-600" />
          </div>
          <div>
            <p className="text-slate-400 text-sm font-medium">No sessions yet</p>
            <p className="text-slate-600 text-xs mt-1">Complete a session to see it here</p>
          </div>
        </div>
      )}

      {!isLoading && !error && sessions.length > 0 && (
        <div className="space-y-2">
          {sessions.slice(0, 5).map((session) => {
            const typeInfo = TYPE_CONFIG[session.interview_type] ?? TYPE_CONFIG.mixed;
            const TypeIcon = typeInfo.icon;
            const diffColor = DIFFICULTY_COLORS[session.difficulty] ?? DIFFICULTY_COLORS.medium;
            const messageCount = session.messages.length;

            return (
              <button
                key={session._id}
                onClick={() => handleSessionClick(session)}
                className="w-full flex items-center gap-3 p-3 rounded-xl bg-slate-800/50 border border-slate-700/50 hover:bg-slate-800 hover:border-slate-600 transition-all text-left group"
              >
                <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center shrink-0">
                  <TypeIcon className={`w-4 h-4 ${typeInfo.color}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{session.role}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded border capitalize ${diffColor}`}>
                      {session.difficulty}
                    </span>
                    {messageCount > 0 && (
                      <span className="flex items-center gap-1 text-xs text-slate-500">
                        <MessageSquare className="w-3 h-3" />
                        {messageCount}
                      </span>
                    )}
                    <span className="text-xs text-slate-600 ml-auto">
                      {formatRelativeDate(session.created_at)}
                    </span>
                  </div>
                </div>

                <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-colors shrink-0" />
              </button>
            );
          })}

          {sessions.length > 5 && (
            <p className="text-xs text-slate-600 text-center pt-1">
              +{sessions.length - 5} more sessions
            </p>
          )}
        </div>
      )}
    </div>
  );
}
