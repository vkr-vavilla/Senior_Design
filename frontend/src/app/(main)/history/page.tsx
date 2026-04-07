'use client';

import { Navbar } from '@/components/layout/Navbar';
import { LoadingPage } from '@/components/ui/LoadingSpinner';
import { useAuthContext } from '@/contexts/AuthContext';
import { interviewApi } from '@/lib/api';
import { Brain, Briefcase, Calendar, ChevronRight, FileText, MessageSquare, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Session {
  _id: string;
  role: string | null;
  interview_type: string | null;
  difficulty: string | null;
  created_at: string;
  resume_filename?: string;
  feedback?: string;
  messages: any[];
}

const typeIcons: Record<string, React.ElementType> = {
  technical: Brain,
  behavioral: Briefcase,
  mixed: Shuffle,
};

const difficultyColors: Record<string, string> = {
  easy: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  hard: 'text-red-400 bg-red-500/10 border-red-500/20',
};

export default function HistoryPage() {
  const router = useRouter();
  const { user, token, isLoading } = useAuthContext();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    async function fetchHistory() {
      if (!token) return;
      try {
        const data = await interviewApi.getSessions(token);
        setSessions(data as Session[]);
      } catch (err) {
        setError('Failed to load history');
        console.error(err);
      } finally {
        setIsFetching(false);
      }
    }
    fetchHistory();
  }, [token]);

  if (isLoading || isFetching) return <LoadingPage />;
  if (!user) return null;

  return (
    <div className="min-h-screen bg-slate-950">
      <Navbar />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Interview History</h1>
          <p className="text-slate-400">Review your past mock interviews, transcripts, and feedback.</p>
        </div>

        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 mb-6">
            {error}
          </div>
        )}

        {sessions.length === 0 && !error ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-4">
              <Calendar className="w-8 h-8 text-slate-500" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">No past interviews</h2>
            <p className="text-slate-400 mb-6">You haven't completed any mock interviews yet.</p>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl transition-colors"
            >
              Start an Interview
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {sessions.map((session) => {
              const type = session.interview_type || 'technical';
              const difficulty = session.difficulty || 'medium';
              const TypeIcon = typeIcons[type] || Brain;
              
              const date = new Date(session.created_at).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });

              return (
                <Link
                  key={session._id}
                  href={`/interview/${session._id}/feedback`}
                  className="block group"
                >
                  <div className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 sm:p-6 transition-all group-hover:bg-slate-800/50">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-4">
                        <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center shrink-0">
                          <TypeIcon className="w-6 h-6 text-slate-400 group-hover:text-indigo-400 transition-colors" />
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold text-white group-hover:text-indigo-300 transition-colors">
                            {session.role || 'General Interview'}
                          </h3>
                          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full border capitalize ${
                                difficultyColors[difficulty] || difficultyColors.medium
                              }`}
                            >
                              {difficulty}
                            </span>
                            <span className="text-xs text-slate-400 capitalize">{type}</span>
                            <span className="text-slate-600 text-xs">•</span>
                            <span className="text-xs text-slate-400 flex items-center gap-1.5">
                              <Calendar className="w-3.5 h-3.5" />
                              {date}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        {session.resume_filename && (
                          <div className="hidden sm:flex items-center justify-center w-8 h-8 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-400" title="Resume Attached">
                            <FileText className="w-4 h-4" />
                          </div>
                        )}
                        <div className="hidden sm:flex items-center justify-center w-8 h-8 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-400" title={`${session.messages?.length || 0} messages`}>
                          <MessageSquare className="w-4 h-4" />
                        </div>
                        <div className="w-8 h-8 flex items-center justify-center">
                          <ChevronRight className="w-5 h-5 text-slate-500 group-hover:text-white transition-colors" />
                        </div>
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
