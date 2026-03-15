'use client';

import { useRef, useState, useEffect } from 'react';
import { motion, useInView } from 'framer-motion';
import Link from 'next/link';
import { Zap, Target, TrendingUp, ArrowRight, MessageSquare, Sparkles } from 'lucide-react';

// ── SVG Circular Gauge ────────────────────────────────────────
function CircleGauge({
  value,
  label,
  gradientId,
  delay = 0,
}: {
  value: number;
  label: string;
  gradientId: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-30px' });
  const radius = 26;
  const circumference = 2 * Math.PI * radius;

  return (
    <div ref={ref} className="flex flex-col items-center gap-1.5">
      <div className="relative w-[64px] h-[64px]">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="4" />
          <motion.circle
            cx="32" cy="32" r={radius}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={inView ? { strokeDashoffset: circumference * (1 - value / 100) } : { strokeDashoffset: circumference }}
            transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1], delay }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.span
            className="text-[13px] font-bold text-white tabular-nums"
            initial={{ opacity: 0 }}
            animate={inView ? { opacity: 1 } : { opacity: 0 }}
            transition={{ delay: delay + 0.3 }}
          >
            {value}
          </motion.span>
        </div>
      </div>
      <span className="text-[10px] text-slate-500">{label}</span>
    </div>
  );
}

// ── Typewriter Question Cycler ────────────────────────────────
const QUESTIONS = [
  { q: 'Design a URL shortener handling 10B requests per day.', type: 'System Design', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/25' },
  { q: "Tell me about a time you led a team through a difficult technical decision.", type: 'Behavioral', color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/25' },
  { q: 'Implement cycle detection in a linked list. Explain your approach.', type: 'Technical', color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/25' },
  { q: 'How would you prioritize features when resources are constrained?', type: 'Product', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25' },
];

function QuestionCycler() {
  const [index, setIndex] = useState(0);
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);
  const current = QUESTIONS[index];

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    let i = 0;
    const iv = setInterval(() => {
      if (i < current.q.length) {
        setDisplayed(current.q.slice(0, i + 1));
        i++;
      } else {
        setDone(true);
        clearInterval(iv);
      }
    }, 22);
    return () => clearInterval(iv);
  }, [index, current.q]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % QUESTIONS.length), 2200);
    return () => clearTimeout(t);
  }, [done]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 h-5">
        <motion.span
          key={current.type}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className={`text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded border ${current.bg} ${current.color}`}
        >
          {current.type}
        </motion.span>
        <motion.span
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 1.2, repeat: Infinity }}
          className="w-1.5 h-1.5 rounded-full bg-emerald-400"
        />
      </div>
      <div className="min-h-[80px]">
        <p className="text-sm text-slate-300 leading-relaxed">
          {displayed}
          {!done && (
            <span className="inline-block w-[2px] h-[14px] bg-indigo-400 ml-0.5 animate-pulse align-middle rounded-sm" />
          )}
        </p>
      </div>
      {/* Question counter dots */}
      <div className="flex items-center gap-1.5">
        {QUESTIONS.map((_, i) => (
          <motion.span
            key={i}
            className="rounded-full bg-slate-700"
            animate={{
              width: i === index ? 16 : 6,
              height: 6,
              backgroundColor: i === index ? 'rgb(99,102,241)' : 'rgb(51,65,85)',
            }}
            transition={{ duration: 0.3 }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Radar / Spider Chart ──────────────────────────────────────
const RADAR_METRICS = [
  { label: 'Clarity', value: 0.92 },
  { label: 'Depth', value: 0.78 },
  { label: 'Structure', value: 0.88 },
  { label: 'Examples', value: 0.82 },
  { label: 'Confidence', value: 0.75 },
  { label: 'Conciseness', value: 0.85 },
];

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function RadarChart() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-30px' });
  const n = RADAR_METRICS.length;
  const cx = 72, cy = 72, maxR = 52;
  const angles = RADAR_METRICS.map((_, i) => (360 / n) * i);
  const rings = [0.25, 0.5, 0.75, 1].map((s) => angles.map((a) => polar(cx, cy, maxR * s, a)));
  const data = RADAR_METRICS.map(({ value }, i) => polar(cx, cy, maxR * value, angles[i]));
  const toPolygon = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div ref={ref} className="flex items-center gap-4">
      <svg viewBox="0 0 144 144" className="w-[120px] h-[120px] flex-shrink-0">
        {rings.map((pts, ri) => (
          <polygon key={ri} points={toPolygon(pts)} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        ))}
        {angles.map((a, i) => {
          const pt = polar(cx, cy, maxR, a);
          return <line key={i} x1={cx} y1={cy} x2={pt.x} y2={pt.y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />;
        })}
        <motion.polygon
          points={toPolygon(data)}
          fill="rgba(99,102,241,0.15)"
          stroke="rgba(99,102,241,0.7)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          initial={{ opacity: 0, scale: 0 }}
          animate={inView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
        />
        {data.map((p, i) => (
          <motion.circle
            key={i} cx={p.x} cy={p.y} r="2.5"
            fill="#818cf8"
            initial={{ opacity: 0, scale: 0 }}
            animate={inView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
            style={{ transformOrigin: `${p.x}px ${p.y}px` }}
            transition={{ duration: 0.3, delay: 0.5 + i * 0.06 }}
          />
        ))}
        {RADAR_METRICS.map(({ label }, i) => {
          const pt = polar(cx, cy, maxR + 13, angles[i]);
          return (
            <text key={label} x={pt.x} y={pt.y} textAnchor="middle" dominantBaseline="middle" fontSize="7.5" fill="rgba(148,163,184,0.65)">
              {label}
            </text>
          );
        })}
      </svg>

      {/* Metric bars alongside radar */}
      <div className="flex-1 space-y-2">
        {RADAR_METRICS.map(({ label, value }, i) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-600 w-14 flex-shrink-0">{label}</span>
            <div className="flex-1 h-[3px] bg-slate-800 rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-400"
                initial={{ width: '0%' }}
                animate={inView ? { width: `${value * 100}%` } : { width: '0%' }}
                transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1], delay: 0.4 + i * 0.06 }}
              />
            </div>
            <span className="text-[9px] text-slate-500 tabular-nums w-5 text-right">{Math.round(value * 100)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Score Trend Line Chart ────────────────────────────────────
const SESSIONS = [
  { score: 54 }, { score: 63 }, { score: 71 }, { score: 79 }, { score: 87 },
];

function ScoreTrend() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-30px' });
  const W = 200, H = 56, pad = 6;
  const pts = SESSIONS.map((s, i) => ({
    x: pad + (i / (SESSIONS.length - 1)) * (W - pad * 2),
    y: H - pad - (s.score / 100) * (H - pad * 2),
  }));
  const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaD = `${lineD} L ${pts[pts.length - 1].x} ${H} L ${pts[0].x} ${H} Z`;

  return (
    <div ref={ref} className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-slate-500 uppercase tracking-widest">Score Trend</span>
        <span className="text-[9px] text-emerald-400 font-semibold">+33 pts</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(99,102,241)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(99,102,241)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.path d={areaD} fill="url(#trendFill)"
          initial={{ opacity: 0 }} animate={inView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }} />
        <motion.path d={lineD} fill="none" stroke="rgb(99,102,241)" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          pathLength={1}
          initial={{ pathLength: 0 }}
          animate={inView ? { pathLength: 1 } : { pathLength: 0 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.3 }} />
        {pts.map((p, i) => (
          <motion.circle key={i} cx={p.x} cy={p.y} r="2.5"
            fill={i === pts.length - 1 ? '#10b981' : '#6366f1'}
            initial={{ opacity: 0, scale: 0 }}
            animate={inView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
            style={{ transformOrigin: `${p.x}px ${p.y}px` }}
            transition={{ duration: 0.3, delay: 0.5 + i * 0.1 }} />
        ))}
      </svg>
      <div className="flex justify-between">
        {SESSIONS.map((s, i) => (
          <span key={i} className={`text-[9px] tabular-nums ${i === SESSIONS.length - 1 ? 'text-emerald-400 font-bold' : 'text-slate-700'}`}>
            {s.score}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Role Chips (color-coded by category) ─────────────────────
const ROLE_GROUPS = [
  { roles: ['Software Eng', 'Backend Dev', 'ML Engineer'], cls: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-300' },
  { roles: ['Product Mgr', 'Data Science', 'UX Design'], cls: 'bg-violet-500/10 border-violet-500/20 text-violet-300' },
  { roles: ['Finance', 'Consulting', 'Marketing', 'Sales'], cls: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' },
];

function RoleChips() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-30px' });
  const all = ROLE_GROUPS.flatMap(({ roles, cls }) => roles.map((r) => ({ r, cls })));

  return (
    <motion.div
      ref={ref}
      className="flex flex-wrap gap-1.5"
      initial="hidden"
      animate={inView ? 'visible' : 'hidden'}
      variants={{ visible: { transition: { staggerChildren: 0.055, delayChildren: 0.1 } } }}
    >
      {all.map(({ r, cls }) => (
        <motion.span
          key={r}
          variants={{
            hidden: { opacity: 0, scale: 0.7, y: 6 },
            visible: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 20 } },
          }}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border ${cls}`}
        >
          {r}
        </motion.span>
      ))}
    </motion.div>
  );
}

// ── Tilt Card ─────────────────────────────────────────────────
function TiltCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rx, setRx] = useState(0);
  const [ry, setRy] = useState(0);
  const [glare, setGlare] = useState({ x: 50, y: 50 });
  const [hovered, setHovered] = useState(false);

  return (
    <motion.div
      ref={ref}
      className={`group relative ${className}`}
      style={{ transformPerspective: 900, transformStyle: 'preserve-3d' }}
      animate={{ rotateX: rx, rotateY: ry }}
      transition={{ type: 'spring', stiffness: 240, damping: 28, mass: 0.4 }}
      onMouseMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        setRx((y - 0.5) * -5);
        setRy((x - 0.5) * 5);
        setGlare({ x: x * 100, y: y * 100 });
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setRx(0); setRy(0); setHovered(false); }}
    >
      <div
        className="absolute inset-0 rounded-2xl pointer-events-none z-20 transition-opacity duration-300"
        style={{
          opacity: hovered ? 1 : 0,
          background: `radial-gradient(circle at ${glare.x}% ${glare.y}%, rgba(255,255,255,0.07) 0%, transparent 65%)`,
        }}
      />
      {children}
    </motion.div>
  );
}

// ── SVG Gradient Defs (shared) ────────────────────────────────
function SvgDefs() {
  return (
    <svg className="w-0 h-0 absolute overflow-hidden" aria-hidden="true">
      <defs>
        <linearGradient id="cg1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" /><stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
        <linearGradient id="cg2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8b5cf6" /><stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
        <linearGradient id="cg3" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" /><stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ── Main Export ───────────────────────────────────────────────
export function FeatureCards() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <SvgDefs />

      {/* ── Card 1: Real-time AI Feedback (2-col) ─────────────── */}
      <TiltCard className="md:col-span-2 p-6 bg-slate-900/80 backdrop-blur-sm border border-slate-800 hover:border-indigo-500/40 rounded-2xl transition-colors duration-500 overflow-hidden cursor-default">
        <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-indigo-500 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
            <Zap className="w-[18px] h-[18px] text-indigo-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white leading-tight">Real-time AI Feedback</h3>
            <p className="text-[11px] text-slate-500">Instant analysis on every answer</p>
          </div>
        </div>

        {/* AI analysis bubble */}
        <div className="mb-5 p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/50">
          <div className="flex items-start gap-2.5">
            <div className="w-6 h-6 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
              <MessageSquare className="w-3 h-3 text-indigo-400" />
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              <span className="text-indigo-300 font-medium">Strong STAR structure.</span>{' '}
              Consider adding <span className="text-amber-300 font-medium">quantifiable metrics</span> to strengthen your impact statement and make it more memorable to interviewers.
            </p>
          </div>
        </div>

        {/* Three circular gauges */}
        <div className="flex items-center justify-around py-3 px-4 bg-slate-800/40 rounded-xl border border-slate-700/40">
          <CircleGauge value={92} label="Clarity" gradientId="cg1" delay={0.15} />
          <div className="w-px h-10 bg-slate-700/40" />
          <CircleGauge value={78} label="Depth" gradientId="cg2" delay={0.3} />
          <div className="w-px h-10 bg-slate-700/40" />
          <CircleGauge value={88} label="Structure" gradientId="cg3" delay={0.45} />
        </div>
      </TiltCard>

      {/* ── Card 2: Smart Questions (1-col) ──────────────────── */}
      <TiltCard className="p-6 bg-slate-900/80 backdrop-blur-sm border border-slate-800 hover:border-violet-500/40 rounded-2xl transition-colors duration-500 overflow-hidden cursor-default">
        <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-violet-500 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-[18px] h-[18px] text-violet-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white leading-tight">Smart Questions</h3>
            <p className="text-[11px] text-slate-500">Adaptive to role & experience</p>
          </div>
        </div>

        <QuestionCycler />
      </TiltCard>

      {/* ── Card 3: Any Role (1-col) ──────────────────────────── */}
      <TiltCard className="p-6 bg-slate-900/80 backdrop-blur-sm border border-slate-800 hover:border-emerald-500/40 rounded-2xl transition-colors duration-500 overflow-hidden cursor-default">
        <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-emerald-500 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
              <Target className="w-[18px] h-[18px] text-emerald-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white leading-tight">Any Role</h3>
              <p className="text-[11px] text-slate-500">Industry-specific questions</p>
            </div>
          </div>
          <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">200+</span>
        </div>

        <RoleChips />
      </TiltCard>

      {/* ── Card 4: Performance Analytics (2-col) ────────────── */}
      <TiltCard className="md:col-span-2 p-6 bg-slate-900/80 backdrop-blur-sm border border-slate-800 hover:border-rose-500/30 rounded-2xl transition-colors duration-500 overflow-hidden cursor-default">
        <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-rose-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
        <div className="absolute inset-0 bg-gradient-to-br from-violet-600/4 via-transparent to-indigo-600/4 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center flex-shrink-0">
            <TrendingUp className="w-[18px] h-[18px] text-rose-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white leading-tight">Performance Analytics</h3>
            <p className="text-[11px] text-slate-500">Track growth across every session</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Radar */}
          <div className="p-3.5 bg-slate-800/50 rounded-xl border border-slate-700/40">
            <p className="text-[9px] text-slate-600 uppercase tracking-widest mb-3">Skill Breakdown</p>
            <RadarChart />
          </div>

          {/* Score trend + badge */}
          <div className="p-3.5 bg-slate-800/50 rounded-xl border border-slate-700/40 flex flex-col justify-between gap-3">
            <ScoreTrend />
            <div className="flex items-center gap-2.5 p-2.5 bg-emerald-500/5 border border-emerald-500/15 rounded-xl">
              <div className="w-1 h-8 rounded-full bg-gradient-to-b from-emerald-400 to-emerald-700 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-emerald-400">Current score: 87/100</p>
                <p className="text-[10px] text-slate-500">Top 15% of all users</p>
              </div>
            </div>
          </div>
        </div>
      </TiltCard>

      {/* ── Bottom CTA (full width) ───────────────────────────── */}
      <motion.div
        className="md:col-span-3 group relative flex flex-col sm:flex-row items-center gap-6 p-7 bg-slate-900/80 backdrop-blur-sm border border-slate-800 rounded-2xl overflow-hidden"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        whileHover={{ borderColor: 'rgba(99,102,241,0.35)' }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-indigo-600/5 to-violet-600/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
          <Zap className="w-5 h-5 text-indigo-400" />
        </div>

        <div className="flex-1 text-center sm:text-left">
          <h3 className="text-lg font-bold text-white mb-1">Start in Under a Minute</h3>
          <p className="text-slate-400 text-sm">
            No complex setup. Sign up, choose your role and difficulty, and your AI interviewer is ready instantly.
          </p>
        </div>

        <Link
          href="/register"
          className="group/btn relative z-10 flex-shrink-0 inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl transition-all duration-200 text-sm cursor-pointer hover:-translate-y-0.5 shadow-lg shadow-indigo-500/20"
        >
          Get Started Free
          <ArrowRight className="w-4 h-4 group-hover/btn:translate-x-0.5 transition-transform duration-200" />
        </Link>
      </motion.div>
    </div>
  );
}
