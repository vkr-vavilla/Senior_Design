'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Bot, AlertCircle } from 'lucide-react';
import { useAuthContext } from '@/contexts/AuthContext';
import { chatApi, ApiError } from '@/lib/api';
import { Navbar } from '@/components/layout/Navbar';
import { FeedbackDisplay } from '@/components/feedback/FeedbackDisplay';
import { LoadingPage, LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Button } from '@/components/ui/Button';

function FeedbackSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-28 bg-slate-800 rounded-2xl" />
      <div className="h-36 bg-slate-800 rounded-2xl" />
      <div className="h-32 bg-slate-800 rounded-2xl" />
      <div className="h-40 bg-slate-800 rounded-2xl" />
    </div>
  );
}

export default function FeedbackPage() {
  const router = useRouter();
  const params = useParams();
  const { user, token, isLoading } = useAuthContext();
  const sessionId = params.sessionId as string;

  const [feedback, setFeedback] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!sessionId || !token || isLoading) return;

    const fetchFeedback = async () => {
      setIsFetching(true);
      setError(null);
      try {
        const result = await chatApi.getFeedback(sessionId, token);
        setFeedback(result);
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 404) {
            setError('Session not found. The feedback may not be available for this session.');
          } else {
            setError(err.message || 'Failed to load feedback.');
          }
        } else {
          setError('Unable to load feedback. Please check your connection and try again.');
        }
      } finally {
        setIsFetching(false);
      }
    };

    fetchFeedback();
  }, [sessionId, token, isLoading]);

  if (isLoading) return <LoadingPage />;
  if (!user) return null;

  return (
    <div className="min-h-screen bg-slate-950">
      <Navbar />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>

          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-600/20 border border-indigo-500/20 flex items-center justify-center">
              <Bot className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Interview Feedback</h1>
              <p className="text-slate-400 text-sm mt-0.5">
                AI-powered analysis of your performance
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        {isFetching ? (
          <div className="space-y-6">
            <div className="flex items-center gap-3 p-4 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 text-sm">
              <LoadingSpinner size="sm" />
              <span>Generating your personalized feedback...</span>
            </div>
            <FeedbackSkeleton />
          </div>
        ) : error ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center">
            <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <h3 className="text-white font-semibold mb-2">Failed to Load Feedback</h3>
            <p className="text-slate-400 text-sm mb-6 max-w-sm mx-auto">{error}</p>
            <div className="flex items-center justify-center gap-3">
              <Button
                onClick={() => {
                  setError(null);
                  setIsFetching(true);
                  chatApi
                    .getFeedback(sessionId, token ?? undefined)
                    .then(setFeedback)
                    .catch((err) =>
                      setError(
                        err instanceof ApiError
                          ? err.message
                          : 'Failed to load feedback.'
                      )
                    )
                    .finally(() => setIsFetching(false));
                }}
                variant="primary"
              >
                Try Again
              </Button>
              <Button onClick={() => router.push('/dashboard')} variant="secondary">
                Go to Dashboard
              </Button>
            </div>
          </div>
        ) : feedback ? (
          <FeedbackDisplay feedback={feedback} sessionId={sessionId} />
        ) : null}
      </main>
    </div>
  );
}
