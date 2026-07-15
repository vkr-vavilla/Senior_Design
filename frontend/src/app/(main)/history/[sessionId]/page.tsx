'use client';

import { ChatInterface } from '@/components/chat/ChatInterface';
import { FeedbackDisplay, renderInline } from '@/components/feedback/FeedbackDisplay';
import { Navbar } from '@/components/layout/Navbar';
import { Button } from '@/components/ui/Button';
import { LoadingPage, LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useAuthContext } from '@/contexts/AuthContext';
import { interviewApi, chatApi } from '@/lib/api';
import { type CodingAttempt, type Message } from '@/types/chat';
import {
  ArrowLeft,
  Bot,
  Brain,
  Briefcase,
  Calendar,
  CheckCircle2,
  Code2,
  Download,
  FileText,
  MessageSquare,
  Shuffle,
  Sparkles,
  Star,
  XCircle
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface SessionDetail {
  _id: string;
  role: string | null;
  interview_type: string | null;
  difficulty: string | null;
  created_at: string;
  resume_filename?: string;
  job_description?: string;
  feedback?: string;
  messages: Array<{ role: string; text: string }>;
  coding_attempts?: CodingAttempt[];
}

// Pulls the text of one "**Header**" section out of the feedback markdown,
// up to (but not including) the next bold section header. Used to surface
// just the code-review portion of the report on the Coding Round tab,
// without re-implementing FeedbackDisplay's full card parser here.
function extractSection(markdown: string, header: string): string | null {
  const marker = `**${header}**`;
  const start = markdown.indexOf(marker);
  if (start === -1) return null;
  const afterHeader = start + marker.length;
  const nextBoldIdx = markdown.indexOf('\n**', afterHeader);
  const raw = markdown.slice(afterHeader, nextBoldIdx === -1 ? markdown.length : nextBoldIdx);
  return raw.trim() || null;
}

function MarkdownLines({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        const isBullet = /^[-•*]\s+/.test(line);
        const content = line.replace(/^[-•*]\s+/, '');
        return (
          <div key={i} className="flex gap-2.5">
            {isBullet && <span className="mt-2 w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />}
            <p className="text-sm text-slate-300 leading-relaxed">{renderInline(content)}</p>
          </div>
        );
      })}
    </div>
  );
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

export default function SessionDetailPage() {
  const router = useRouter();
  const params = useParams();
  const sessionId = params.sessionId as string;
  const { user, token, isLoading } = useAuthContext();
  
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'feedback' | 'coding' | 'transcript' | 'details'>('feedback');
  const [isDownloading, setIsDownloading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  
  const dummyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    async function fetchSession() {
      if (!sessionId || !token) return;
      try {
        const data = await interviewApi.getSession(sessionId, token);
        const s = data as unknown as SessionDetail;
        setSession(s);
        if (!s.feedback) {
          setActiveTab(
            s.messages?.length > 0 ? 'transcript' : s.coding_attempts?.length ? 'coding' : 'details'
          );
        }
      } catch (err) {
        setError('Failed to load session details');
        console.error(err);
      } finally {
        setIsFetching(false);
      }
    }
    fetchSession();
  }, [sessionId, token]);

  const handleGenerateFeedback = async () => {
    if (!token) return;
    setIsGenerating(true);
    setGenerateError('');
    try {
      const result = await chatApi.getFeedback(sessionId, token);
      setSession((prev) => prev ? { ...prev, feedback: result.feedback } : prev);
      setActiveTab('feedback');
    } catch (err) {
      setGenerateError('Failed to generate feedback. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownloadResume = async () => {
    if (!session?.resume_filename || !token) return;
    setIsDownloading(true);
    try {
      await interviewApi.downloadResume(sessionId, token, session.resume_filename);
    } catch (err) {
      console.error(err);
      alert('Failed to download resume.');
    } finally {
      setIsDownloading(false);
    }
  };

  if (isLoading || isFetching) return <LoadingPage />;
  if (!user) return null;
  if (!session) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <p className="text-sm text-red-400">{error || 'Session not found.'}</p>
        </main>
      </div>
    );
  }

  const type = session.interview_type || 'technical';
  const difficulty = session.difficulty || 'medium';
  const date = new Date(session.created_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const chatMessages: Message[] = (session.messages || []).map((msg, idx) => ({
    id: `msg-${idx}`,
    role: msg.role === 'model' ? 'assistant' : 'user',
    content: msg.text,
  }));

  const codingAttempts = session.coding_attempts ?? [];
  const codingAbility = session.feedback ? extractSection(session.feedback, 'Coding Ability') : null;
  const codingScores = session.feedback ? extractSection(session.feedback, 'Coding & Design Scores') : null;

  const tabs = [
    { id: 'feedback', label: 'AI Feedback', icon: Star, show: true },
    { id: 'coding', label: 'Coding Round', icon: Code2, show: codingAttempts.length > 0 },
    { id: 'transcript', label: 'Chat Transcript', icon: MessageSquare, show: chatMessages.length > 0 },
    { id: 'details', label: 'Interview Details', icon: FileText, show: true },
  ].filter(t => t.show);

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <Navbar />

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 md:py-10 flex flex-col">
        {/* Header Section */}
        <div className="mb-8 shrink-0">
          <button
            onClick={() => router.push('/history')}
            className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to History
          </button>

          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row justify-between items-start gap-6">
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-3">
                  {session.role || 'General Interview'}
                </h1>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2">
                  <span
                    className={`text-xs px-2.5 py-1 rounded-full border capitalize font-medium ${
                      difficultyColors[difficulty] || difficultyColors.medium
                    }`}
                  >
                    {difficulty}
                  </span>
                  <span className="text-sm text-slate-300 capitalize">{type}</span>
                  <span className="text-slate-600 text-sm">•</span>
                  <span className="text-sm text-slate-400 flex items-center gap-1.5">
                    <Calendar className="w-4 h-4 text-slate-500" />
                    {date}
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row items-center gap-3 shrink-0">
                {session.resume_filename && (
                  <Button
                    onClick={handleDownloadResume}
                    variant="secondary"
                    className="w-full sm:w-auto text-sm bg-slate-800/50 hover:bg-slate-700/50 border-slate-700/50"
                    disabled={isDownloading}
                  >
                    <Download className="w-4 h-4 mr-2 text-indigo-400" />
                    {isDownloading ? 'Downloading...' : 'Download Resume'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
            {error}
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Tabs */}
            <div className="flex items-center gap-2 border-b border-slate-800 pb-px mb-6 hide-scrollbar overflow-x-auto shrink-0">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`flex items-center gap-2 px-4 py-3 border-b-2 text-sm font-medium whitespace-nowrap transition-colors ${
                      isActive
                        ? 'border-indigo-500 text-indigo-400'
                        : 'border-transparent text-slate-400 hover:text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Content Area */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {activeTab === 'feedback' && (
                <div className="pb-10">
                  {session.feedback ? (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        {generateError ? (
                          <p className="text-red-400 text-sm">{generateError}</p>
                        ) : (
                          <span />
                        )}
                        <Button
                          onClick={handleGenerateFeedback}
                          variant="secondary"
                          disabled={isGenerating}
                          className="text-sm bg-slate-800/50 hover:bg-slate-700/50 border-slate-700/50"
                        >
                          {isGenerating ? (
                            <span className="flex items-center gap-2">
                              <LoadingSpinner size="sm" />
                              Regenerating...
                            </span>
                          ) : (
                            <span className="flex items-center gap-2">
                              <Sparkles className="w-4 h-4" />
                              Regenerate Feedback
                            </span>
                          )}
                        </Button>
                      </div>
                      <FeedbackDisplay feedback={session.feedback} sessionId={session._id} />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 gap-6 text-center">
                      <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                        <Sparkles className="w-8 h-8 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-white font-semibold text-lg mb-2">No feedback yet</h3>
                        <p className="text-slate-400 text-sm max-w-sm">
                          Generate AI feedback to see a detailed breakdown of your performance, strengths, and areas to improve.
                        </p>
                      </div>
                      {generateError && (
                        <p className="text-red-400 text-sm">{generateError}</p>
                      )}
                      <Button
                        onClick={handleGenerateFeedback}
                        variant="primary"
                        disabled={isGenerating || !session.messages?.length}
                      >
                        {isGenerating ? (
                          <span className="flex items-center gap-2">
                            <LoadingSpinner size="sm" />
                            Generating feedback...
                          </span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4" />
                            Generate Feedback
                          </span>
                        )}
                      </Button>
                      {!session.messages?.length && (
                        <p className="text-slate-500 text-xs">No conversation recorded for this session.</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'coding' && (
                <div className="space-y-6 pb-10">
                  {codingAttempts.map((attempt, i) => (
                    <div
                      key={`${attempt.problem_id}-${i}`}
                      className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden"
                    >
                      <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-white font-semibold truncate">{attempt.title}</span>
                          <span
                            className={`text-xs px-2.5 py-1 rounded-full border capitalize font-medium shrink-0 ${
                              difficultyColors[(attempt.difficulty || 'medium').toLowerCase()] || difficultyColors.medium
                            }`}
                          >
                            {attempt.difficulty}
                          </span>
                          <span className="text-xs text-slate-500 uppercase shrink-0">{attempt.language}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${
                              attempt.all_passed
                                ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
                                : 'text-amber-300 bg-amber-500/10 border-amber-500/20'
                            }`}
                          >
                            {attempt.all_passed ? (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5" />
                            )}
                            {attempt.passed}/{attempt.total} passed
                          </span>
                          <span className="text-xs text-slate-500">
                            {new Date(attempt.submitted_at).toLocaleString(undefined, {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                          </span>
                        </div>
                      </div>
                      <pre className="text-xs text-slate-300 bg-slate-950 p-4 overflow-x-auto font-mono leading-relaxed">
                        <code>{attempt.code}</code>
                      </pre>
                    </div>
                  ))}

                  {codingAbility || codingScores ? (
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8">
                      <div className="flex items-center gap-2 mb-5">
                        <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                          <Code2 className="w-4 h-4 text-cyan-400" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-white">AI Code Review</h3>
                          <p className="text-xs text-slate-500">
                            Time/space complexity, edge cases, and a more efficient approach if one exists
                          </p>
                        </div>
                      </div>
                      {codingAbility && (
                        <div className="mb-6">
                          <MarkdownLines text={codingAbility} />
                        </div>
                      )}
                      {codingScores && (
                        <div className="pt-4 border-t border-slate-800/60">
                          <MarkdownLines text={codingScores} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 gap-4 text-center bg-slate-900 border border-slate-800 rounded-2xl">
                      <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                        <Sparkles className="w-7 h-7 text-cyan-400" />
                      </div>
                      <div>
                        <h3 className="text-white font-semibold mb-1">No code review yet</h3>
                        <p className="text-slate-400 text-sm max-w-sm">
                          Generate AI feedback to get a written review of this code — time/space complexity,
                          edge cases, and a more efficient approach if one exists.
                        </p>
                      </div>
                      <Button
                        onClick={handleGenerateFeedback}
                        variant="primary"
                        disabled={isGenerating}
                      >
                        {isGenerating ? (
                          <span className="flex items-center gap-2">
                            <LoadingSpinner size="sm" />
                            Generating...
                          </span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4" />
                            Generate Feedback
                          </span>
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'transcript' && chatMessages.length > 0 && (
                <div className="h-[600px] bg-slate-900 border border-slate-800 rounded-2xl flex flex-col overflow-hidden relative">
                  <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/50 shrink-0 flex items-center gap-2">
                    <Bot className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-medium text-slate-300 uppercase tracking-wider">Interview Log</span>
                  </div>
                  <ChatInterface
                    messages={chatMessages}
                    isStreaming={false}
                    messagesEndRef={dummyRef}
                  />
                  {/* We apply a mask/gradient at the bottom to fade it nicely since we're viewing past chunks */}
                </div>
              )}

              {activeTab === 'details' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-10">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <Briefcase className="w-5 h-5 text-indigo-400" />
                      <h3 className="font-semibold text-white">Job Description</h3>
                    </div>
                    {session.job_description ? (
                      <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                        {session.job_description}
                      </p>
                    ) : (
                      <p className="text-sm text-slate-500 italic">No job description provided.</p>
                    )}
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 h-fit">
                    <div className="flex items-center gap-2 mb-4">
                      <FileText className="w-5 h-5 text-indigo-400" />
                      <h3 className="font-semibold text-white">Context Information</h3>
                    </div>
                    <div className="space-y-4 text-sm">
                      <div className="flex justify-between items-center py-2 border-b border-slate-800/50">
                        <span className="text-slate-500">Resume Attached</span>
                        <span className="text-slate-300">{session.resume_filename ? 'Yes' : 'No'}</span>
                      </div>
                      <div className="flex justify-between items-center py-2 border-b border-slate-800/50">
                        <span className="text-slate-500">Interview Type</span>
                        <span className="text-slate-300 capitalize">{type}</span>
                      </div>
                      <div className="flex justify-between items-center py-2 border-b border-slate-800/50">
                        <span className="text-slate-500">Role</span>
                        <span className="text-slate-300">{session.role || 'N/A'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
