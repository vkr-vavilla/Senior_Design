'use client';

import { CodeEditor } from '@/components/coding/CodeEditor';
import { Navbar } from '@/components/layout/Navbar';
import { Button } from '@/components/ui/Button';
import { LoadingPage, LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useAuthContext } from '@/contexts/AuthContext';
import { codingApi } from '@/lib/api';
import type { CodingProblem, RunResult } from '@/types/coding';
import { ArrowLeft, CheckCircle2, Flag, Play, Send, XCircle } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const difficultyColors: Record<string, string> = {
  easy: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  hard: 'text-red-400 bg-red-500/10 border-red-500/20',
};

export default function CodingPage() {
  const router = useRouter();
  const params = useParams();
  const sessionId = params.sessionId as string;
  const { user, token, isLoading } = useAuthContext();

  const [problems, setProblems] = useState<CodingProblem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, RunResult | null>>({});
  const [submittedIds, setSubmittedIds] = useState<Record<string, boolean>>({});

  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) router.push('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    async function load() {
      if (!sessionId || !token) {
        setIsFetching(false);
        return;
      }
      try {
        const data = await codingApi.getSessionProblems(sessionId, token);
        setProblems(data);
        const initialCodes: Record<string, string> = {};
        data.forEach((p) => {
          initialCodes[p.id] = p.code_snippets?.python3 ?? '';
        });
        setCodes(initialCodes);
      } catch (err) {
        setError('Failed to load the coding round.');
        console.error(err);
      } finally {
        setIsFetching(false);
      }
    }
    load();
  }, [sessionId, token]);

  const active = problems[activeIdx];

  const runFor = async (mode: 'run' | 'submit') => {
    if (!active || !token) return;
    setError('');
    if (mode === 'run') setIsRunning(true);
    else setIsSubmitting(true);
    try {
      const res =
        mode === 'run'
          ? await codingApi.run({ problemId: active.id, language: 'python3', code: codes[active.id] ?? '' }, token)
          : await codingApi.submit(
              { sessionId, problemId: active.id, language: 'python3', code: codes[active.id] ?? '' },
              token
            );
      setResults((prev) => ({ ...prev, [active.id]: res }));
      if (mode === 'submit') setSubmittedIds((prev) => ({ ...prev, [active.id]: true }));
    } catch (err) {
      setError('Could not reach the execution service. Is the code sandbox running?');
      console.error(err);
    } finally {
      if (mode === 'run') setIsRunning(false);
      else setIsSubmitting(false);
    }
  };

  const submittedCount = Object.values(submittedIds).filter(Boolean).length;

  // End the coding round: submitted answers are already saved to the session, so
  // we just confirm (if nothing was submitted) and hand off to the feedback page,
  // which now includes a dedicated Coding Round slide.
  const finishRound = () => {
    if (isRunning || isSubmitting) return;
    if (submittedCount === 0) {
      const proceed = window.confirm(
        "You haven't submitted any solutions yet. End the coding round anyway?"
      );
      if (!proceed) return;
    }
    router.push(`/interview/${sessionId}/feedback`);
  };

  if (isLoading || isFetching) return <LoadingPage />;
  if (!user) return null;

  if (problems.length === 0) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col">
        <Navbar />
        <main className="flex-1 flex items-center justify-center px-4 text-center">
          <p className="text-sm text-slate-400">
            {error || 'This interview has no coding round.'}
          </p>
        </main>
      </div>
    );
  }

  const difficulty = active.difficulty || 'medium';
  const result = results[active.id] ?? null;

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <Navbar />

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-5">
        {/* Header */}
        <div className="shrink-0">
          <div className="flex items-center justify-between gap-3 mb-4">
            <button
              onClick={() => router.push('/dashboard')}
              className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </button>

            <Button
              onClick={finishRound}
              variant="primary"
              disabled={isRunning || isSubmitting}
              className="text-sm"
            >
              <span className="flex items-center gap-2">
                <Flag className="w-4 h-4" />
                Finish &amp; View Feedback
              </span>
            </Button>
          </div>

          {/* Problem switcher (only when there's more than one) */}
          {problems.length > 1 && (
            <div className="flex items-center gap-2 mb-4">
              {problems.map((p, i) => {
                const done = submittedIds[p.id];
                const isActive = i === activeIdx;
                return (
                  <button
                    key={p.id}
                    onClick={() => setActiveIdx(i)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      isActive
                        ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {done && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                    Problem {i + 1}
                    <span className="text-xs opacity-70 capitalize">· {p.difficulty}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{active.title}</h1>
            <span
              className={`text-xs px-2.5 py-1 rounded-full border capitalize font-medium ${
                difficultyColors[difficulty] || difficultyColors.medium
              }`}
            >
              {difficulty}
            </span>
            {active.topic_tags?.slice(0, 4).map((tag) => (
              <span key={tag} className="text-xs text-slate-400 bg-slate-800/60 border border-slate-700/50 rounded-full px-2.5 py-1">
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Split: problem statement | editor + results */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 flex-1 min-h-0">
          {/* content_html is LeetCode-sourced text stored in our own DB (not user
              input). Rendering it directly is acceptable; add DOMPurify for hardening. */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 overflow-y-auto max-h-[75vh]">
            <div
              className="text-slate-300 text-sm leading-relaxed space-y-3
                [&_pre]:bg-slate-950 [&_pre]:border [&_pre]:border-slate-800 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:text-xs
                [&_code]:text-indigo-300 [&_strong]:text-white [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-indigo-400"
              dangerouslySetInnerHTML={{ __html: active.content_html }}
            />
          </div>

          {/* Editor + controls + results */}
          <div className="flex flex-col gap-4 min-h-0">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Python 3</span>
              <div className="flex items-center gap-2">
                <Button onClick={() => runFor('run')} variant="secondary" disabled={isRunning || isSubmitting}
                  className="text-sm bg-slate-800/60 hover:bg-slate-700/60 border-slate-700/50">
                  {isRunning ? (
                    <span className="flex items-center gap-2"><LoadingSpinner size="sm" /> Running…</span>
                  ) : (
                    <span className="flex items-center gap-2"><Play className="w-4 h-4" /> Run</span>
                  )}
                </Button>
                <Button onClick={() => runFor('submit')} variant="primary" disabled={isRunning || isSubmitting} className="text-sm">
                  {isSubmitting ? (
                    <span className="flex items-center gap-2"><LoadingSpinner size="sm" /> Submitting…</span>
                  ) : (
                    <span className="flex items-center gap-2"><Send className="w-4 h-4" /> Submit</span>
                  )}
                </Button>
              </div>
            </div>

            <div className="h-[400px] rounded-2xl overflow-hidden border border-slate-800 shrink-0">
              <CodeEditor
                value={codes[active.id] ?? ''}
                onChange={(v) => setCodes((prev) => ({ ...prev, [active.id]: v }))}
                language="python"
              />
            </div>

            {/* Results console */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 overflow-y-auto flex-1 min-h-[140px]">
              {error ? (
                <p className="text-sm text-red-400">{error}</p>
              ) : !result ? (
                <p className="text-sm text-slate-500">Run your code to see how it does against the example tests.</p>
              ) : (
                <ResultsView result={result} submitted={!!submittedIds[active.id]} />
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function ResultsView({ result, submitted }: { result: RunResult; submitted: boolean }) {
  const allPassed = result.all_passed;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span
          className={`inline-flex items-center gap-2 text-sm font-semibold px-3 py-1 rounded-full border ${
            allPassed
              ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
              : 'text-amber-300 bg-amber-500/10 border-amber-500/20'
          }`}
        >
          {allPassed ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {result.passed} / {result.total} passed
        </span>
        <span className="text-xs text-slate-500">
          {result.status}
          {submitted && <span className="ml-2 text-emerald-400">· saved</span>}
        </span>
      </div>

      {(result.compile_output || result.stderr) && (
        <pre className="text-xs text-red-300 bg-red-500/5 border border-red-500/20 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
          {result.compile_output || result.stderr}
        </pre>
      )}

      <div className="space-y-2">
        {result.cases.map((c) => (
          <div
            key={c.index}
            className={`rounded-lg border p-3 text-xs ${
              c.passed ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              {c.passed ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-red-400" />
              )}
              <span className="font-medium text-slate-200">Case {c.index + 1}</span>
              {c.runtime_error && <span className="text-red-400">runtime error</span>}
            </div>
            {!c.passed && (
              <div className="pl-5 space-y-0.5 font-mono text-slate-400">
                <div>expected: <span className="text-slate-300">{c.expected}</span></div>
                <div>got: <span className="text-slate-300">{c.actual}</span></div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
