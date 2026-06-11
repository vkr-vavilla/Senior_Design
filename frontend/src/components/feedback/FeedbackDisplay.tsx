'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Code2,
  Lightbulb,
  MessageSquare,
  Sparkles,
  Star,
  Target,
  TrendingUp,
} from 'lucide-react';

interface FeedbackDisplayProps {
  feedback: string;
  sessionId: string;
}

type SectionCategory =
  | 'strengths'
  | 'improvements'
  | 'weaknesses'
  | 'communication'
  | 'technical'
  | 'coding'
  | 'takeaways'
  | 'overall'
  | 'general';

interface FeedbackItem {
  title: string | null;  // e.g. "Justification" — bold prefix if present
  body: string;
}

interface FeedbackCard {
  sectionTitle: string;
  category: SectionCategory;
  items: FeedbackItem[];
}

// ----- Score parsing -----

function parseScore(text: string): number | null {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*\/\s*10/i,
    /score[:\s]+(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s+out\s+of\s+10/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const score = parseFloat(match[1]);
      if (score >= 0 && score <= 10) return score;
    }
  }
  return null;
}

function getScoreLabel(score: number): string {
  if (score >= 9) return 'Outstanding';
  if (score >= 8) return 'Excellent';
  if (score >= 7) return 'Strong';
  if (score >= 6) return 'Solid';
  if (score >= 5) return 'Developing';
  return 'Needs Work';
}

function getScoreTheme(score: number) {
  if (score >= 8) {
    return {
      text: 'text-emerald-400',
      stroke: 'stroke-emerald-400',
      bg: 'from-emerald-500/10 via-emerald-500/5 to-transparent',
      border: 'border-emerald-500/20',
      pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    };
  }
  if (score >= 6) {
    return {
      text: 'text-indigo-400',
      stroke: 'stroke-indigo-400',
      bg: 'from-indigo-500/10 via-violet-500/5 to-transparent',
      border: 'border-indigo-500/20',
      pill: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    };
  }
  if (score >= 4) {
    return {
      text: 'text-amber-400',
      stroke: 'stroke-amber-400',
      bg: 'from-amber-500/10 via-amber-500/5 to-transparent',
      border: 'border-amber-500/20',
      pill: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
    };
  }
  return {
    text: 'text-red-400',
    stroke: 'stroke-red-400',
    bg: 'from-red-500/10 via-red-500/5 to-transparent',
    border: 'border-red-500/20',
    pill: 'bg-red-500/10 text-red-300 border-red-500/20',
  };
}

// ----- Category styling -----

function categorize(title: string): SectionCategory {
  const lower = title.toLowerCase();
  if (lower.includes('strength')) return 'strengths';
  if (lower.includes('coding') || lower.includes('code')) return 'coding';
  if (lower.includes('weakness')) return 'weaknesses';
  if (lower.includes('improve') || lower.includes('areas')) return 'improvements';
  if (lower.includes('communicat') || lower.includes('clarity')) return 'communication';
  if (lower.includes('technical') || lower.includes('accuracy')) return 'technical';
  if (lower.includes('takeaway') || lower.includes('key') || lower.includes('focus'))
    return 'takeaways';
  if (lower.includes('overall') || lower.includes('summary') || lower.includes('score'))
    return 'overall';
  return 'general';
}

const CATEGORY_STYLE: Record<
  SectionCategory,
  {
    icon: React.ElementType;
    iconColor: string;
    iconBg: string;
    accent: string;
    pill: string;
    label: string;
  }
> = {
  strengths: {
    icon: CheckCircle,
    iconColor: 'text-emerald-400',
    iconBg: 'bg-emerald-500/10 border-emerald-500/20',
    accent: 'from-emerald-500/20 to-transparent',
    pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    label: 'Strengths',
  },
  improvements: {
    icon: Target,
    iconColor: 'text-amber-400',
    iconBg: 'bg-amber-500/10 border-amber-500/20',
    accent: 'from-amber-500/20 to-transparent',
    pill: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
    label: 'Improve',
  },
  weaknesses: {
    icon: AlertTriangle,
    iconColor: 'text-rose-400',
    iconBg: 'bg-rose-500/10 border-rose-500/20',
    accent: 'from-rose-500/20 to-transparent',
    pill: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
    label: 'Weaknesses',
  },
  communication: {
    icon: MessageSquare,
    iconColor: 'text-sky-400',
    iconBg: 'bg-sky-500/10 border-sky-500/20',
    accent: 'from-sky-500/20 to-transparent',
    pill: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
    label: 'Communication',
  },
  technical: {
    icon: TrendingUp,
    iconColor: 'text-violet-400',
    iconBg: 'bg-violet-500/10 border-violet-500/20',
    accent: 'from-violet-500/20 to-transparent',
    pill: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
    label: 'Technical',
  },
  coding: {
    icon: Code2,
    iconColor: 'text-cyan-400',
    iconBg: 'bg-cyan-500/10 border-cyan-500/20',
    accent: 'from-cyan-500/20 to-transparent',
    pill: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',
    label: 'Coding',
  },
  takeaways: {
    icon: Lightbulb,
    iconColor: 'text-yellow-400',
    iconBg: 'bg-yellow-500/10 border-yellow-500/20',
    accent: 'from-yellow-500/20 to-transparent',
    pill: 'bg-yellow-500/10 text-yellow-300 border-yellow-500/20',
    label: 'Takeaways',
  },
  overall: {
    icon: Star,
    iconColor: 'text-indigo-400',
    iconBg: 'bg-indigo-500/10 border-indigo-500/20',
    accent: 'from-indigo-500/20 to-transparent',
    pill: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    label: 'Overall',
  },
  general: {
    icon: Award,
    iconColor: 'text-slate-400',
    iconBg: 'bg-slate-800 border-slate-700',
    accent: 'from-slate-700/40 to-transparent',
    pill: 'bg-slate-800 text-slate-300 border-slate-700',
    label: 'Notes',
  },
};

// ----- Parser: flatten feedback into individual cards -----

function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*{1,2}/, '')
    .replace(/\*{1,2}$/, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/:$/, '')
    .trim();
}

function isSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  // Markdown heading
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  // Bold-wrapped header like **1. Overall Score: 1/10** or **Strengths**
  if (/^\*\*[^*]+\*\*:?$/.test(trimmed)) return true;
  // Numbered bold header that may have inline content: **1. Title:** value
  if (/^\*\*\d+\.\s+[^*]+\*\*/.test(trimmed)) return true;
  return false;
}

function isBullet(line: string): boolean {
  return /^\s*[-•*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
}

function stripBulletMarker(line: string): string {
  return line.replace(/^\s*[-•*]\s+/, '').replace(/^\s*\d+\.\s+/, '');
}

/**
 * Splits a bullet line into a (title, body) pair if it begins with **Bold:** prefix.
 * Returns { title: null, body } if there's no prefix.
 */
function splitTitleBody(text: string): { title: string | null; body: string } {
  const match = text.match(/^\*\*([^*]+?)\*\*[:\s]*(.*)$/);
  if (match) {
    const title = match[1].trim().replace(/:$/, '');
    const body = match[2].trim();
    return { title, body: body || '' };
  }
  return { title: null, body: text.trim() };
}

function isJunkLine(line: string): boolean {
  // Horizontal rules, decorative separators
  if (/^[-=_*]{3,}$/.test(line)) return true;
  // Preamble like "Here's my detailed feedback:" or "Here is my feedback"
  if (/^here'?s?\s+(is\s+)?(my\s+)?(detailed\s+)?feedback/i.test(line)) return true;
  if (/^below\s+is\s+(my\s+)?feedback/i.test(line)) return true;
  return false;
}

function isJunkBody(body: string): boolean {
  const stripped = body.replace(/[*_\-=\s]/g, '');
  return stripped.length === 0;
}

function parseCards(text: string): FeedbackCard[] {
  const lines = text.split('\n');
  const cards: FeedbackCard[] = [];
  let current: FeedbackCard | null = null;
  let pendingParagraph: string[] = [];

  const ensureCurrent = () => {
    if (!current) {
      current = { sectionTitle: 'Feedback', category: 'general', items: [] };
    }
    return current;
  };

  const pushItem = (item: FeedbackItem) => {
    if (isJunkBody(item.body) && !item.title) return;
    ensureCurrent().items.push(item);
  };

  const flushParagraph = () => {
    if (pendingParagraph.length === 0) return;
    const joined = pendingParagraph.join(' ').trim();
    pendingParagraph = [];
    if (!joined || isJunkLine(joined)) return;
    const { title, body } = splitTitleBody(joined);
    pushItem({ title, body: body || joined });
  };

  const startSection = (title: string, inlineValue: string) => {
    flushParagraph();
    if (current && current.items.length > 0) cards.push(current);
    const next: FeedbackCard = {
      sectionTitle: title,
      category: categorize(title),
      items: [],
    };
    if (inlineValue && !isJunkBody(inlineValue)) {
      next.items.push({ title: null, body: inlineValue });
    }
    current = next;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (isJunkLine(trimmed)) {
      flushParagraph();
      continue;
    }

    if (isSectionHeader(trimmed) && !isBullet(trimmed)) {
      const fullMatch = trimmed.match(/^\*\*([^*]+?)\*\*[:\s]*(.*)$/);
      if (fullMatch) {
        const headerText = fullMatch[1]
          .trim()
          .replace(/^\d+\.\s*/, '')
          .replace(/:$/, '')
          .trim();
        startSection(headerText, fullMatch[2].trim());
      } else {
        startSection(stripMarkdown(trimmed).replace(/^\d+\.\s*/, '').trim(), '');
      }
      continue;
    }

    if (isBullet(trimmed)) {
      flushParagraph();
      const bulletText = stripBulletMarker(trimmed);
      if (isJunkLine(bulletText)) continue;
      const { title, body } = splitTitleBody(bulletText);
      pushItem({ title, body: body || bulletText });
      continue;
    }

    pendingParagraph.push(trimmed);
  }
  flushParagraph();
  const finalCard = current as FeedbackCard | null;
  if (finalCard && finalCard.items.length > 0) cards.push(finalCard);

  // Drop sections that only contain a score (already shown in hero)
  return cards.filter((c) => {
    if (c.items.length === 0) return false;
    if (
      c.category === 'overall' &&
      c.items.length === 1 &&
      /^\s*\d+(\.\d+)?\s*\/\s*10\s*$/.test(c.items[0].body)
    ) {
      return false;
    }
    return true;
  });
}

// ----- Inline markdown (bold) renderer -----

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="text-white font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// Detects a bullet whose body merely restates its title — e.g. title "Clear"
// with body "Your communication was clear." — so we can show just the title.
// Only collapses true tautologies; real short insights are kept.
function bodyRestatesTitle(title: string, body: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(title);
  const b = norm(body);
  if (!b) return true;
  if (!t || !b.includes(t)) return false;
  const FILLER = new Set([
    'you', 'your', 'the', 'a', 'an', 'is', 'was', 'were', 'are', 'and',
    'communication', 'response', 'responses', 'answer', 'answers', 'overall',
    'very', 'quite', 'generally', 'it', 'this', 'that', 'their', 'they',
    'candidate', 'style', 'well', 'be', 'been', 'pretty', 'mostly',
  ]);
  const leftover = b
    .replace(t, ' ')
    .split(' ')
    .filter((w) => w && !FILLER.has(w));
  return leftover.length === 0;
}

// ----- Score Hero -----

function ScoreHero({ score }: { score: number }) {
  const theme = getScoreTheme(score);
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 10) * circumference;

  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-br ${theme.bg} border ${theme.border} rounded-3xl p-8 sm:p-10`}
    >
      <div className="absolute top-6 right-6 opacity-30">
        <Sparkles className={`w-5 h-5 ${theme.text}`} />
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-8">
        <div className="relative shrink-0">
          <svg width="140" height="140" className="-rotate-90">
            <circle
              cx="70"
              cy="70"
              r={radius}
              className="stroke-slate-800"
              strokeWidth="10"
              fill="none"
            />
            <circle
              cx="70"
              cy="70"
              r={radius}
              className={theme.stroke}
              strokeWidth="10"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              style={{ transition: 'stroke-dashoffset 1.2s ease-out' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-4xl font-bold ${theme.text}`}>{score}</span>
            <span className="text-xs text-slate-500 font-medium">out of 10</span>
          </div>
        </div>

        <div className="flex-1 text-center sm:text-left">
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium ${theme.pill}`}
          >
            <Star className="w-3 h-3" />
            Overall Performance
          </span>
          <h2 className={`text-3xl sm:text-4xl font-bold ${theme.text} mt-3`}>
            {getScoreLabel(score)}
          </h2>
          <p className="text-slate-400 text-sm mt-2 max-w-md leading-relaxed">
            Step through each piece of feedback at your own pace using the arrows below.
          </p>
        </div>
      </div>
    </div>
  );
}

// ----- Card View (one bullet at a time) -----

function CardView({
  card,
  index,
  total,
}: {
  card: FeedbackCard;
  index: number;
  total: number;
}) {
  const style = CATEGORY_STYLE[card.category];
  const Icon = style.icon;

  return (
    <div className="relative bg-slate-900/60 backdrop-blur-sm border border-slate-800 rounded-3xl overflow-hidden min-h-[420px] flex flex-col">
      {/* Top gradient accent */}
      <div
        className={`absolute inset-x-0 top-0 h-32 bg-gradient-to-b ${style.accent} pointer-events-none`}
      />

      {/* Header */}
      <div className="relative px-8 sm:px-10 pt-8 pb-6 border-b border-slate-800/60 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div
            className={`w-12 h-12 rounded-2xl border flex items-center justify-center shrink-0 ${style.iconBg}`}
          >
            <Icon className={`w-6 h-6 ${style.iconColor}`} />
          </div>
          <div className="min-w-0">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${style.pill}`}
            >
              {style.label}
            </span>
            <h3 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-1.5">
              {card.sectionTitle}
            </h3>
          </div>
        </div>
        <div className="text-xs text-slate-600 font-mono shrink-0 pt-1">
          {index + 1} / {total}
        </div>
      </div>

      {/* Body — list of items */}
      <div className="relative flex-1 px-8 sm:px-10 py-7 space-y-5 overflow-y-auto">
        {card.items.map((item, i) => {
          const bodyIsRedundant = item.title ? bodyRestatesTitle(item.title, item.body) : false;
          return (
            <div key={i} className="flex gap-3">
              <span className={`mt-2.5 w-1.5 h-1.5 rounded-full shrink-0 ${style.iconColor.replace('text-', 'bg-')}`} />
              <div className="flex-1 min-w-0">
                {item.title && (
                  <p className="text-white font-semibold text-[15px] mb-1">{item.title}</p>
                )}
                {!bodyIsRedundant && (
                  <p className="text-slate-300 text-[15px] leading-relaxed">
                    {renderInline(item.body)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ----- Pagination Controls -----

function PaginationControls({
  index,
  total,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <div className="flex items-center justify-between gap-4">
      <button
        onClick={onPrev}
        disabled={isFirst}
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:border-slate-700 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-slate-900 disabled:hover:border-slate-800 transition-all"
      >
        <ChevronLeft className="w-4 h-4" />
        Previous
      </button>

      <div className="flex items-center gap-1.5 max-w-[40%] overflow-hidden">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all shrink-0 ${
              i === index
                ? 'w-6 bg-indigo-400'
                : i < index
                ? 'w-1.5 bg-slate-600'
                : 'w-1.5 bg-slate-800'
            }`}
          />
        ))}
      </div>

      <button
        onClick={onNext}
        disabled={isLast}
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:from-indigo-600 disabled:hover:to-violet-600 transition-all"
      >
        Next
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ----- Main Display -----

export function FeedbackDisplay({ feedback, sessionId }: FeedbackDisplayProps) {
  const score = parseScore(feedback);
  const cards = useMemo(() => parseCards(feedback), [feedback]);

  const [activeIndex, setActiveIndex] = useState(0);
  const safeIndex = Math.min(activeIndex, Math.max(cards.length - 1, 0));
  const activeCard = cards[safeIndex];

  const handleNext = () => setActiveIndex((i) => Math.min(i + 1, cards.length - 1));
  const handlePrev = () => setActiveIndex((i) => Math.max(i - 1, 0));

  return (
    <div className="space-y-8">
      {score !== null && <ScoreHero score={score} />}

      {cards.length > 0 && activeCard && (
        <div className="space-y-5">
          <CardView card={activeCard} index={safeIndex} total={cards.length} />
          <PaginationControls
            index={safeIndex}
            total={cards.length}
            onPrev={handlePrev}
            onNext={handleNext}
          />
        </div>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-slate-800/60 text-xs text-slate-600">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3 h-3" />
          <span>Generated by AI · Session {sessionId.slice(0, 8)}…</span>
        </div>
      </div>
    </div>
  );
}
