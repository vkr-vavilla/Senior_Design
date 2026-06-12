'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, Mic, Brain } from 'lucide-react';

// Animated waveform bars (like a voice activity indicator)
function Waveform() {
  return (
    <div className="flex items-center gap-[3px] h-4">
      {[0.4, 0.8, 1, 0.6, 0.9, 0.5, 0.7].map((h, i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-emerald-400"
          animate={{ scaleY: [h, 1, h * 0.6, 0.9, h] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.1,
            ease: 'easeInOut',
          }}
          style={{ height: '100%', transformOrigin: 'center' }}
        />
      ))}
    </div>
  );
}

// Top-right: AI identity + session card
export function AISessionCard() {
  const [question, setQuestion] = useState(0);
  const questions = ['Technical', 'Behavioral', 'System Design'];

  useEffect(() => {
    const t = setInterval(() => setQuestion((q) => (q + 1) % questions.length), 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <motion.div
      className="absolute -top-5 -right-3 z-20 pointer-events-none"
      initial={{ opacity: 0, y: -12, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 1.2, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="bg-slate-950/90 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden">
        {/* Top accent bar */}
        <div className="h-[2px] bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-500" />

        <div className="px-4 py-3.5 flex items-center gap-3.5">
          {/* Bot icon with pulse rings */}
          <div className="relative flex-shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/40">
              <Bot className="w-5 h-5 text-white" />
            </div>
            {/* Outer pulse ring */}
            <motion.span
              className="absolute inset-0 rounded-xl border-2 border-indigo-400/50"
              animate={{ scale: [1, 1.55], opacity: [0.5, 0] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
            />
          </div>

          <div className="flex flex-col gap-1">
            {/* Brand */}
            <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-white font-brand leading-none">
              Final Round AI
            </span>

            {/* Question type cycling */}
            <div className="flex items-center gap-1.5 overflow-hidden h-4">
              <Brain className="w-3 h-3 text-violet-400 flex-shrink-0" />
              <div className="relative h-4 overflow-hidden">
                <motion.span
                  key={question}
                  className="text-[11px] text-violet-300 font-medium absolute whitespace-nowrap"
                  initial={{ y: 14, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -14, opacity: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                  {questions[question]}
                </motion.span>
              </div>
            </div>

            {/* Status with waveform */}
            <div className="flex items-center gap-2">
              <Mic className="w-3 h-3 text-emerald-400 flex-shrink-0" />
              <Waveform />
              <span className="text-[10px] text-emerald-400 font-medium">Active</span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// Bottom-left: Live scoring HUD
export function LiveScoreHUD() {
  const metrics = [
    { label: 'Clarity', value: 92 },
    { label: 'Depth', value: 78 },
    { label: 'Flow', value: 88 },
  ];

  return (
    <motion.div
      className="absolute bottom-8 left-4 z-20 pointer-events-none"
      initial={{ opacity: 0, x: -16, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ delay: 1.6, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="bg-slate-950/90 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden min-w-[196px]">
        {/* Top accent */}
        <div className="h-[2px] bg-gradient-to-r from-emerald-500 via-indigo-500 to-violet-500" />

        <div className="p-4">
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-[9px] font-bold tracking-[0.15em] uppercase text-slate-500">
              Live Analysis
            </span>
            <motion.div
              className="flex items-center gap-1"
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-[9px] font-bold text-emerald-400 tracking-widest uppercase">
                Live
              </span>
            </motion.div>
          </div>

          {/* Big score */}
          <div className="flex items-baseline gap-1.5 mb-3">
            <motion.span
              className="text-4xl font-bold text-white tabular-nums leading-none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 2 }}
            >
              87
            </motion.span>
            <span className="text-slate-600 text-sm">/100</span>
            <div className="ml-auto flex items-center gap-1 px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
              <span className="text-[10px] font-semibold text-emerald-400">Excellent</span>
            </div>
          </div>

          {/* Animated progress bar */}
          <div className="h-1 bg-slate-800 rounded-full overflow-hidden mb-4">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-400"
              initial={{ width: '0%' }}
              animate={{ width: '87%' }}
              transition={{ duration: 1.4, delay: 2.1, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>

          {/* Mini metrics */}
          <div className="grid grid-cols-3 gap-1">
            {metrics.map(({ label, value }, i) => (
              <motion.div
                key={label}
                className="flex flex-col items-center py-1.5 bg-slate-900/60 rounded-lg"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 2.3 + i * 0.08, duration: 0.3 }}
              >
                <span className="text-[13px] font-bold text-slate-200 tabular-nums leading-none">
                  {value}
                </span>
                <span className="text-[9px] text-slate-600 mt-0.5">{label}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
