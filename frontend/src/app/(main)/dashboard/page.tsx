'use client';

import { Navbar } from '@/components/layout/Navbar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingPage } from '@/components/ui/LoadingSpinner';
import { useAuthContext } from '@/contexts/AuthContext';
import { interviewApi, ApiError } from '@/lib/api';
import { RecentSessions } from '@/components/dashboard/RecentSessions';
import { DEFAULT_MODEL_SOURCE, GEMINI_KEY_URL, IS_CLOUD } from '@/lib/deployment';
import { Input as TextInput, Select } from '@/components/ui/Input';
import { Brain, Briefcase, ChevronRight, Cloud, Cpu, ExternalLink, FileText, Play, Shuffle, Sparkles, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const DIFFICULTY_LEVELS = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

const MODEL_SOURCES = [
  { value: 'api', label: 'Cloud — Gemini API (your key)' },
  { value: 'local', label: 'Local (vLLM / Ollama)' },
];

const POPULAR_ROLES = [
  'Software Engineer',
  'Product Manager',
  'Data Scientist',
  'Frontend Developer',
  'Backend Developer',
  'DevOps Engineer',
  'UX Designer',
  'Machine Learning Engineer',
];

const difficultyConfig = {
  easy: {
    label: 'Easy',
    desc: 'Great for beginners',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/20',
    active: 'bg-emerald-500/20 border-emerald-500/50 ring-1 ring-emerald-500/30',
  },
  medium: {
    label: 'Medium',
    desc: 'Standard interview difficulty',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20',
    active: 'bg-amber-500/20 border-amber-500/50 ring-1 ring-amber-500/30',
  },
  hard: {
    label: 'Hard',
    desc: 'Senior-level challenge',
    color: 'text-red-400',
    bg: 'bg-red-500/10 border-red-500/20 hover:bg-red-500/20',
    active: 'bg-red-500/20 border-red-500/50 ring-1 ring-red-500/30',
  },
};

export default function DashboardPage() {
  const router = useRouter();
  const { user, token, isLoading, logout } = useAuthContext();

  // A 401 from a protected request means the token expired (no refresh flow):
  // clear the session and send the user to log in again with a clear message.
  const handleAuthError = (err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 401) {
      logout();
      router.push('/login?expired=1');
      return true;
    }
    return false;
  };

  const [role, setRole] = useState('Software Engineer');
  const [interviewType, setInterviewType] = useState('technical');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [jobDescription, setJobDescription] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [isFetchingSessions, setIsFetchingSessions] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    async function fetchRecent() {
      if (!token) return;
      try {
        const data = await interviewApi.getSessions(token);
        setSessions((data as any[]).slice(0, 3));
      } catch (err) {
        console.error('Failed to fetch sessions', err);
      } finally {
        setIsFetchingSessions(false);
      }
    }
    fetchRecent();
  }, [token]);

  if (isLoading) return <LoadingPage />;
  if (!user) return null;

  const handleFileSelect = (file: File) => {
    if (file.type !== 'application/pdf') {
      setUploadError('Please upload a PDF file');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File must be under 10MB');
      return;
    }
    setResumeFile(file);
    setUploadError('');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  // Cloud has no GPU behind it, so it can only run Gemini; local defaults to
  // the on-device engine. See lib/deployment.ts.
  const [modelSource, setModelSource] = useState<'local' | 'api'>(DEFAULT_MODEL_SOURCE);
  const [geminiKey, setGeminiKey] = useState('');

  useEffect(() => {
    setGeminiKey(localStorage.getItem('gemini_api_key') || '');
  }, []);

  const handleBeginInterview = async () => {
    if (!role.trim() || !token) return;
    setUploadError('');

    // Resume is required — Alex's questions are grounded in it, so an
    // interview with no resume has nothing to ask about. Job description is
    // optional context on top of that.
    if (!resumeFile) {
      setUploadError('Please upload your resume (PDF) to start an interview.');
      return;
    }

    setIsUploading(true);
    try {
      const result = await interviewApi.createInterview(
        {
          resume: resumeFile,
          jobDescription: jobDescription.trim(),
          role: role.trim(),
          interviewType,
          difficulty,
        },
        token
      );

      const params = new URLSearchParams({
        role: role.trim(),
        type: interviewType,
        difficulty,
        modelSource,
        interviewId: result.interview_id,
      });
      router.push(`/interview?${params.toString()}`);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
      setIsUploading(false);
    }
  };

  const firstName = user.name.split(' ')[0];

  return (
    <div className="min-h-screen bg-slate-950">
      <Navbar />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Welcome Header */}
        <div className="mb-10">
          <div className="flex items-center gap-2 text-indigo-400 text-sm font-medium mb-2">
            <span>Good {getGreeting()},</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            Welcome back, {firstName}!
          </h1>
          <p className="text-slate-400 mt-2">
            Ready to ace your next interview? Let&apos;s practice.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Setup Card */}
          <div className="lg:col-span-2">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              {/* Card Header */}
              <div className="px-6 py-5 border-b border-slate-800 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-600/20 border border-indigo-500/20 flex items-center justify-center">
                  <Play className="w-4 h-4 text-indigo-400" />
                </div>
                <div>
                  <h2 className="font-semibold text-white">Start New Interview</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Configure your practice session</p>
                </div>
              </div>

              <div className="p-6 space-y-6">
                {/* Job Role */}
                <div>
                  <Input
                    label="Job Role"
                    type="text"
                    placeholder="e.g. Software Engineer, Product Manager..."
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    leftIcon={<Briefcase className="w-4 h-4" />}
                  />
                  {/* Popular roles */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {POPULAR_ROLES.slice(0, 5).map((r) => (
                      <button
                        key={r}
                        onClick={() => setRole(r)}
                        className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                          role === r
                            ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-300 hover:border-slate-600'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Interview Type */}
                <div>
                  <label className="text-sm font-medium text-slate-300 block mb-2">
                    Interview Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      {
                        value: 'technical',
                        label: 'Technical',
                        icon: Brain,
                        desc: 'Coding & system design',
                      },
                      {
                        value: 'behavioral',
                        label: 'Behavioral',
                        icon: Briefcase,
                        desc: 'Soft skills & experience',
                      },
                      {
                        value: 'mixed',
                        label: 'Mixed',
                        icon: Shuffle,
                        desc: 'Both technical & behavioral',
                      },
                    ].map((type) => {
                      const Icon = type.icon;
                      return (
                        <button
                          key={type.value}
                          onClick={() => setInterviewType(type.value)}
                          className={`p-3 rounded-xl border text-left transition-all ${
                            interviewType === type.value
                              ? 'bg-indigo-500/20 border-indigo-500/50 ring-1 ring-indigo-500/30'
                              : 'bg-slate-800/50 border-slate-700 hover:bg-slate-800 hover:border-slate-600'
                          }`}
                        >
                          <Icon
                            className={`w-4 h-4 mb-1.5 ${
                              interviewType === type.value ? 'text-indigo-400' : 'text-slate-400'
                            }`}
                          />
                          <div
                            className={`text-xs font-medium ${
                              interviewType === type.value ? 'text-indigo-300' : 'text-slate-300'
                            }`}
                          >
                            {type.label}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">{type.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Difficulty */}
                <div>
                  <label className="text-sm font-medium text-slate-300 block mb-2">
                    Difficulty Level
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {(Object.keys(difficultyConfig) as Array<keyof typeof difficultyConfig>).map(
                      (level) => {
                        const cfg = difficultyConfig[level];
                        const isActive = difficulty === level;
                        return (
                          <button
                            key={level}
                            onClick={() => setDifficulty(level)}
                            className={`p-4 rounded-xl border text-center transition-all ${
                              isActive ? cfg.active : cfg.bg
                            }`}
                          >
                            <div className={`text-lg font-bold ${cfg.color}`}>{cfg.label}</div>
                            <div className="text-xs text-slate-500 mt-1">{cfg.desc}</div>
                          </button>
                        );
                      }
                    )}
                  </div>
                </div>

                {/* Resume Upload */}
                <div>
                  <label className="text-sm font-medium text-slate-300 block mb-2">
                    Resume (PDF) <span className="text-red-400 font-normal">*required</span>
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFileSelect(file);
                    }}
                  />
                  {resumeFile ? (
                    <div className="flex items-center gap-3 p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-xl">
                      <FileText className="w-5 h-5 text-indigo-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium truncate">{resumeFile.name}</p>
                        <p className="text-xs text-slate-400">{(resumeFile.size / 1024).toFixed(0)} KB</p>
                      </div>
                      <button
                        onClick={() => { setResumeFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                        className="p-1 hover:bg-slate-700 rounded-lg transition-colors"
                      >
                        <X className="w-4 h-4 text-slate-400" />
                      </button>
                    </div>
                  ) : (
                    <div
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed rounded-xl cursor-pointer transition-all ${
                        isDragging
                          ? 'border-indigo-500 bg-indigo-500/10'
                          : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/50'
                      }`}
                    >
                      <Upload className={`w-6 h-6 ${isDragging ? 'text-indigo-400' : 'text-slate-500'}`} />
                      <p className="text-sm text-slate-400">
                        <span className="text-indigo-400 font-medium">Click to upload</span> or drag and drop
                      </p>
                      <p className="text-xs text-slate-600">PDF only, up to 10MB</p>
                    </div>
                  )}
                </div>

                {/* Job Description */}
                <div>
                  <label className="text-sm font-medium text-slate-300 block mb-2">
                    Job Description <span className="text-slate-500 font-normal">(optional)</span>
                  </label>
                  <textarea
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    placeholder="Paste the job description here. The AI will tailor questions to match the role requirements..."
                    rows={4}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/50 resize-none transition-all"
                  />
                </div>

                {/* Interviewer model */}
                <div>
                  <label className="text-sm font-medium text-slate-300 block mb-2">
                    Interviewer Model
                  </label>
                  <Select
                    options={IS_CLOUD ? MODEL_SOURCES.slice(0, 1) : MODEL_SOURCES}
                    value={modelSource}
                    onChange={(e) => setModelSource(e.target.value as 'local' | 'api')}
                    hint={
                      modelSource === 'api'
                        ? 'Questions are generated by Google Gemini using your own API key. Free tier is plenty for practice.'
                        : 'Runs our fine-tuned model on your machine — vLLM on NVIDIA, Ollama on Apple Silicon. No key, nothing leaves your device.'
                    }
                  />

                  {modelSource === 'api' && (
                    <div className="mt-3 space-y-3">
                      <TextInput
                        label="Gemini API Key"
                        type="password"
                        placeholder="AIzaSy…"
                        value={geminiKey}
                        onChange={(e) => {
                          setGeminiKey(e.target.value);
                          localStorage.setItem('gemini_api_key', e.target.value);
                        }}
                      />
                      <a
                        href={GEMINI_KEY_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        Get a free key from Google AI Studio
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  )}

                  {/* Why the choice is constrained here, stated once. */}
                  <div className="mt-3 flex gap-2.5 rounded-xl border border-slate-800 bg-slate-800/40 px-3.5 py-3">
                    {IS_CLOUD ? (
                      <Cloud className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    ) : (
                      <Cpu className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                    )}
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {IS_CLOUD ? (
                        <>
                          <span className="text-slate-300 font-medium">You&apos;re on the cloud version</span>{' '}
                          — interviews run on Gemini with your own key. Want the fine-tuned model
                          fully offline? Download the desktop app.
                        </>
                      ) : (
                        <>
                          <span className="text-slate-300 font-medium">You&apos;re running locally</span>{' '}
                          — the fine-tuned model runs on your hardware. Switch to Cloud (Gemini) if
                          you&apos;d rather not use your GPU.
                        </>
                      )}
                    </p>
                  </div>

                  <div className="mt-2 flex gap-2.5 rounded-xl border border-violet-500/20 bg-violet-500/[0.07] px-3.5 py-3">
                    <Sparkles className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-slate-400 leading-relaxed">
                      <span className="text-violet-300 font-medium">GPU servers coming soon</span> —
                      you&apos;ll be able to run our fine-tuned model in the cloud, no key and no
                      local GPU required.
                    </p>
                  </div>
                </div>

                {/* Error message */}
                {uploadError && (
                  <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">
                    {uploadError}
                  </div>
                )}

                {/* Begin Button */}
                <Button
                  onClick={handleBeginInterview}
                  variant="primary"
                  size="lg"
                  className="w-full"
                  disabled={!role.trim() || !resumeFile || isUploading}
                  rightIcon={isUploading ? undefined : <ChevronRight className="w-5 h-5" />}
                >
                  {isUploading ? 'Uploading Resume...' : resumeFile ? 'Begin Interview' : 'Upload a Resume to Begin'}
                </Button>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Quick Stats */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h3 className="font-semibold text-white mb-4 text-sm">Quick Tips</h3>
              <div className="space-y-3">
                {[
                  {
                    icon: '•',
                    text: 'Answer questions with structured responses (STAR method for behavioral)',
                  },
                  {
                    icon: '•',
                    text: 'Be specific — use real examples and concrete numbers when possible',
                  },
                  {
                    icon: '•',
                    text: 'Aim for 2-4 minute answers — not too brief, not too long',
                  },
                ].map((tip, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <span className="text-lg shrink-0">{tip.icon}</span>
                    <p className="text-slate-400 leading-relaxed">{tip.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {token && <RecentSessions token={token} />}
          </div>
        </div>
      </main>
    </div>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}
