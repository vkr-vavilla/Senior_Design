'use client';

import { ChatInterface } from '@/components/chat/ChatInterface';
import { MessageInput } from '@/components/chat/MessageInput';
import { Navbar } from '@/components/layout/Navbar';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { LoadingPage } from '@/components/ui/LoadingSpinner';
import { useAuthContext } from '@/contexts/AuthContext';
import { useInterviewChat } from '@/hooks/useInterviewChat';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';
import { useTextToSpeech } from '@/hooks/useTextToSpeech';
import { chatApi } from '@/lib/api';
import { cn, formatTime } from '@/lib/utils';
import type { InterviewConfig } from '@/types/chat';
import {
    ArrowLeft,
    Bot,
    Brain,
    Briefcase,
    CheckCircle,
    ChevronRight,
    Clock,
    Play,
    Shuffle,
    Square,
    Volume2,
    VolumeX,
    Sparkles,
    Mic2
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

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

const MODEL_SOURCES = [
  { value: 'local', label: 'Local (vLLM)' },
  { value: 'api', label: 'API (Gemini)' },
];

const typeIcons = {
  technical: Brain,
  behavioral: Briefcase,
  mixed: Shuffle,
};

const difficultyColors = {
  easy: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  hard: 'text-red-400 bg-red-500/10 border-red-500/20',
};

function InterviewPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, token, isLoading } = useAuthContext();

  const {
    messages,
    activeModelSource,
    isConnected,
    isStreaming,
    sessionEnded,
    elapsedTime,
    sessionId,
    startInterview,
    sendMessage,
    endInterview,
    messagesEndRef,
  } = useInterviewChat();

  const [hasStarted, setHasStarted] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const { isRecording, recordingTime, startRecording, stopRecording } = useAudioRecorder();
  const { speakStream, stop: stopSpeaking, engine, setEngine, flush } = useTextToSpeech();

  // Pre-fill from query params
  const [config, setConfig] = useState<InterviewConfig>({
    role: searchParams.get('role') || 'Software Engineer',
    type: (searchParams.get('type') as InterviewConfig['type']) || 'technical',
    difficulty: (searchParams.get('difficulty') as InterviewConfig['difficulty']) || 'medium',
    modelSource: (searchParams.get('modelSource') as InterviewConfig['modelSource']) || 'local',
    interviewId: searchParams.get('interviewId') || undefined,
  });

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  if (isLoading) return <LoadingPage />;
  if (!user) return null;

  const handleStart = () => {
    if (!config.role.trim() || !token) return;
    startInterview(config, token, (chunk) => {
      if (isVoiceMode) speakStream(chunk);
    }, () => {
      if (isVoiceMode) flush();
    });
    setHasStarted(true);
  };

  const handleTranscribeAndSend = async () => {
    try {
      const audioBlob = await stopRecording();
      setIsTranscribing(true);
      const { text } = await chatApi.transcribe(audioBlob);
      if (text.trim()) {
        sendMessage(text);
      }
    } catch (err) {
      console.error('Transcription failed:', err);
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleEndInterview = () => {
    if (!showEndConfirm) {
      setShowEndConfirm(true);
      return;
    }
    stopSpeaking();
    endInterview();
    setShowEndConfirm(false);
  };

  const TypeIcon = typeIcons[config.type];

  // Setup Screen
  if (!hasStarted) {
    return (
      <div className="min-h-screen bg-slate-950">
        <Navbar />
        <div className="max-w-2xl mx-auto px-4 py-12">
          <div className="mb-8">
            <button
              onClick={() => router.push('/dashboard')}
              className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors mb-6"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </button>
            <h1 className="text-2xl font-bold text-white">Configure Interview</h1>
            <p className="text-slate-400 mt-1 text-sm">Set up your mock interview session</p>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
            <Input
              label="Job Role"
              type="text"
              placeholder="e.g. Software Engineer"
              value={config.role}
              onChange={(e) => setConfig((c) => ({ ...c, role: e.target.value }))}
              leftIcon={<Briefcase className="w-4 h-4" />}
            />

            <Select
              label="Interview Type"
              options={INTERVIEW_TYPES}
              value={config.type}
              onChange={(e) =>
                setConfig((c) => ({ ...c, type: e.target.value as InterviewConfig['type'] }))
              }
            />

            <Select
              label="Difficulty"
              options={DIFFICULTY_LEVELS}
              value={config.difficulty}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  difficulty: e.target.value as InterviewConfig['difficulty'],
                }))
              }
            />

            <Select
              label="Model Source"
              options={MODEL_SOURCES}
              value={config.modelSource}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  modelSource: e.target.value as InterviewConfig['modelSource'],
                }))
              }
            />

            <Button
              onClick={handleStart}
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!config.role.trim()}
              leftIcon={<Play className="w-4 h-4" />}
              rightIcon={<ChevronRight className="w-4 h-4" />}
            >
              Start Interview
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Interview Ended State
  if (sessionEnded) {
    return (
      <div className="min-h-screen bg-slate-950">
        <Navbar />
        <div className="max-w-xl mx-auto px-4 py-16 text-center">
          <div className="w-20 h-20 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-10 h-10 text-emerald-400" />
          </div>

          <h1 className="text-2xl font-bold text-white mb-3">Interview Complete!</h1>
          <p className="text-slate-400 mb-2">
            Great job completing your {config.difficulty} {config.type} interview for{' '}
            <span className="text-white font-medium">{config.role}</span>.
          </p>
          <p className="text-slate-500 text-sm mb-8">
            Your session has been saved.{' '}
            {sessionId
              ? 'You can view your detailed feedback below.'
              : 'Feedback generation is available once the session is saved.'}
          </p>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-lg font-bold text-white">{formatTime(elapsedTime)}</div>
              <div className="text-xs text-slate-500 mt-0.5">Duration</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-lg font-bold text-white">
                {messages.filter((m) => m.role === 'user').length}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">Responses</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-lg font-bold text-white capitalize">{config.difficulty}</div>
              <div className="text-xs text-slate-500 mt-0.5">Difficulty</div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {sessionId && (
              <Button
                onClick={() => router.push(`/interview/${sessionId}/feedback`)}
                variant="primary"
                size="lg"
              >
                View Feedback
              </Button>
            )}
            <Button
              onClick={() => router.push('/dashboard')}
              variant="secondary"
              size="lg"
            >
              Back to Dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Active Interview Screen
  return (
    <div className="h-screen bg-slate-950 flex flex-col">
      <Navbar />

      {/* Interview Header */}
      <div className="border-b border-slate-800 bg-slate-900/50 px-4 py-3 shrink-0">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-600/20 border border-indigo-500/20 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-semibold text-white text-sm truncate">AI Interviewer</h1>
                {isConnected && (
                  <span className="flex items-center gap-1 text-xs text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className={cn(
                    'text-xs px-2 py-0.5 rounded-full border capitalize',
                    difficultyColors[config.difficulty]
                  )}
                >
                  {config.difficulty}
                </span>
                <span className="text-xs text-slate-500 capitalize">{config.type}</span>
                <span className="text-xs text-slate-600">·</span>
                <span className="text-xs text-slate-500 uppercase">{config.modelSource}</span>
                <span className="text-xs text-slate-600">·</span>
                <span className="text-xs text-slate-500 uppercase">active: {activeModelSource}</span>
                <span className="text-xs text-slate-600">·</span>
                <span className="text-xs text-slate-500 truncate">{config.role}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Timer */}
            <div className="flex items-center gap-1.5 text-sm font-mono text-slate-300 bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              {formatTime(elapsedTime)}
            </div>

            {/* Voice Mode Toggle */}
            <div className="flex items-center gap-2">
              {isVoiceMode && (
                <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700">
                  <button
                    onClick={() => setEngine('premium')}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold transition-all",
                      engine === 'premium' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-300"
                    )}
                  >
                    <Sparkles className="w-3 h-3" />
                    PREM
                  </button>
                  <button
                    onClick={() => setEngine('browser')}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold transition-all",
                      engine === 'browser' ? "bg-slate-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-300"
                    )}
                  >
                    <Mic2 className="w-3 h-3" />
                    STD
                  </button>
                </div>
              )}

              <button
                onClick={() => {
                  const next = !isVoiceMode;
                  setIsVoiceMode(next);
                  if (!next) stopSpeaking();
                }}
                className={cn(
                  "p-2 rounded-lg border transition-all",
                  isVoiceMode 
                    ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" 
                    : "bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-400"
                )}
                title={isVoiceMode ? "Voice Mode On" : "Voice Mode Off"}
              >
                {isVoiceMode ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
            </div>

            {/* End Button */}
            {showEndConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">End interview?</span>
                <button
                  onClick={handleEndInterview}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setShowEndConfirm(false)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={handleEndInterview}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-red-400 bg-slate-800 hover:bg-red-500/10 border border-slate-700 hover:border-red-500/30 rounded-lg transition-all"
              >
                <Square className="w-3.5 h-3.5" />
                End
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Chat Interface */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <ChatInterface
          messages={messages}
          isStreaming={isStreaming}
          messagesEndRef={messagesEndRef}
        />
        <MessageInput
          onSend={sendMessage}
          disabled={!isConnected || sessionEnded || isTranscribing}
          isStreaming={isStreaming || isTranscribing}
          isRecording={isRecording}
          recordingTime={recordingTime}
          onStartRecording={startRecording}
          onStopRecording={handleTranscribeAndSend}
          placeholder={isTranscribing ? 'Transcribing your voice...' : 'Type or record your response...'}
        />
      </div>
    </div>
  );
}

export default function InterviewPage() {
  return (
    <Suspense fallback={<LoadingPage />}>
      <InterviewPageContent />
    </Suspense>
  );
}
