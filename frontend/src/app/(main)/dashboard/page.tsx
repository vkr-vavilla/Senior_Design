'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Briefcase, Brain, Shuffle, ChevronRight, Clock, Layers } from 'lucide-react';
import { useAuthContext } from '@/contexts/AuthContext';
import { Navbar } from '@/components/layout/Navbar';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { LoadingPage } from '@/components/ui/LoadingSpinner';

const INTERVIEW_TYPES = [
  { value: 'technical', label: 'Technical' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'mixed', label: 'Mixed' },
];

const DIFFICULTY_LEVELS = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
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
  const { user, isLoading } = useAuthContext();

  const [role, setRole] = useState('Software Engineer');
  const [interviewType, setInterviewType] = useState('technical');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  if (isLoading) return <LoadingPage />;
  if (!user) return null;

  const handleBeginInterview = () => {
    if (!role.trim()) return;
    const params = new URLSearchParams({
      role: role.trim(),
      type: interviewType,
      difficulty,
    });
    router.push(`/interview?${params.toString()}`);
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
                  <Select
                    label="Interview Type"
                    options={INTERVIEW_TYPES}
                    value={interviewType}
                    onChange={(e) => setInterviewType(e.target.value)}
                  />
                  <div className="mt-2 grid grid-cols-3 gap-2">
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

                {/* Begin Button */}
                <Button
                  onClick={handleBeginInterview}
                  variant="primary"
                  size="lg"
                  className="w-full"
                  disabled={!role.trim()}
                  rightIcon={<ChevronRight className="w-5 h-5" />}
                >
                  Begin Interview
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
                    icon: '💡',
                    text: 'Answer questions with structured responses (STAR method for behavioral)',
                  },
                  {
                    icon: '🎯',
                    text: 'Be specific — use real examples and concrete numbers when possible',
                  },
                  {
                    icon: '⏱️',
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

            {/* Recent Sessions Placeholder */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="w-4 h-4 text-slate-400" />
                <h3 className="font-semibold text-white text-sm">Recent Sessions</h3>
              </div>
              <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
                <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center">
                  <Layers className="w-5 h-5 text-slate-600" />
                </div>
                <div>
                  <p className="text-slate-400 text-sm font-medium">Session history coming soon</p>
                  <p className="text-slate-600 text-xs mt-1">
                    Complete a session to see it here
                  </p>
                </div>
              </div>
            </div>
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
