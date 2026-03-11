import { CheckCircle, AlertCircle, MessageSquare, Star, TrendingUp, Award } from 'lucide-react';

interface FeedbackDisplayProps {
  feedback: string;
  sessionId: string;
}

interface ParsedSection {
  title: string;
  content: string;
}

function parseScore(text: string): string | null {
  // Look for patterns like "8/10", "7.5/10", "Score: 8", "8 out of 10"
  const patterns = [
    /(\d+(?:\.\d+)?)\s*\/\s*10/i,
    /score[:\s]+(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s+out\s+of\s+10/i,
    /overall[:\s]+(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const score = parseFloat(match[1]);
      if (score >= 0 && score <= 10) {
        return score.toString();
      }
    }
  }
  return null;
}

function getScoreColor(score: number): string {
  if (score >= 8) return 'text-emerald-400';
  if (score >= 6) return 'text-indigo-400';
  if (score >= 4) return 'text-amber-400';
  return 'text-red-400';
}

function getScoreBg(score: number): string {
  if (score >= 8) return 'from-emerald-500/20 to-emerald-600/20 border-emerald-500/20';
  if (score >= 6) return 'from-indigo-500/20 to-violet-600/20 border-indigo-500/20';
  if (score >= 4) return 'from-amber-500/20 to-amber-600/20 border-amber-500/20';
  return 'from-red-500/20 to-red-600/20 border-red-500/20';
}

function getScoreLabel(score: number): string {
  if (score >= 9) return 'Outstanding';
  if (score >= 8) return 'Excellent';
  if (score >= 7) return 'Good';
  if (score >= 6) return 'Satisfactory';
  if (score >= 5) return 'Needs Improvement';
  return 'Needs Work';
}

function parseSections(text: string): ParsedSection[] {
  const sectionKeywords = [
    'overview',
    'summary',
    'strengths',
    'areas for improvement',
    'improvements',
    'communication',
    'technical',
    'behavioral',
    'feedback',
    'score',
    'overall',
    'recommendation',
    'key points',
    'highlights',
  ];

  const lines = text.split('\n');
  const sections: ParsedSection[] = [];
  let currentTitle = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect section headers (lines with ** or ## or that match keywords followed by : or ending with :)
    const isHeader =
      /^#{1,3}\s+/.test(trimmed) ||
      /^\*{1,2}[A-Z][^*]+\*{1,2}:?$/.test(trimmed) ||
      (trimmed.endsWith(':') &&
        sectionKeywords.some((k) => trimmed.toLowerCase().includes(k)));

    if (isHeader) {
      if (currentTitle && currentContent.length > 0) {
        sections.push({ title: currentTitle, content: currentContent.join('\n') });
      }
      currentTitle = trimmed
        .replace(/^#{1,3}\s+/, '')
        .replace(/\*{1,2}/g, '')
        .replace(/:$/, '')
        .trim();
      currentContent = [];
    } else {
      currentContent.push(trimmed);
    }
  }

  if (currentTitle && currentContent.length > 0) {
    sections.push({ title: currentTitle, content: currentContent.join('\n') });
  }

  // If no sections were parsed, treat entire text as one section
  if (sections.length === 0) {
    return [{ title: 'Interview Feedback', content: text }];
  }

  return sections;
}

function getSectionIcon(title: string) {
  const lower = title.toLowerCase();
  if (lower.includes('strength')) return <CheckCircle className="w-4 h-4 text-emerald-400" />;
  if (lower.includes('improve') || lower.includes('weakness'))
    return <AlertCircle className="w-4 h-4 text-amber-400" />;
  if (lower.includes('communicat')) return <MessageSquare className="w-4 h-4 text-indigo-400" />;
  if (lower.includes('score') || lower.includes('overall'))
    return <Star className="w-4 h-4 text-violet-400" />;
  if (lower.includes('technical')) return <TrendingUp className="w-4 h-4 text-blue-400" />;
  return <Award className="w-4 h-4 text-slate-400" />;
}

function formatContent(content: string): React.ReactNode {
  const lines = content.split('\n');
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;

        // Bullet points
        if (/^[-•*]\s+/.test(trimmed)) {
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
              <span className="text-slate-300 text-sm leading-relaxed">
                {trimmed.replace(/^[-•*]\s+/, '')}
              </span>
            </div>
          );
        }

        // Numbered list
        if (/^\d+\.\s+/.test(trimmed)) {
          const num = trimmed.match(/^(\d+)\./)?.[1];
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-xs font-bold text-indigo-400 w-5 shrink-0">{num}.</span>
              <span className="text-slate-300 text-sm leading-relaxed">
                {trimmed.replace(/^\d+\.\s+/, '')}
              </span>
            </div>
          );
        }

        return (
          <p key={i} className="text-slate-300 text-sm leading-relaxed">
            {trimmed}
          </p>
        );
      })}
    </div>
  );
}

export function FeedbackDisplay({ feedback, sessionId }: FeedbackDisplayProps) {
  const scoreStr = parseScore(feedback);
  const score = scoreStr ? parseFloat(scoreStr) : null;
  const sections = parseSections(feedback);

  return (
    <div className="space-y-6">
      {/* Score Card */}
      {score !== null && (
        <div
          className={`p-6 bg-gradient-to-br ${getScoreBg(score)} border rounded-2xl flex items-center gap-6`}
        >
          <div className="text-center">
            <div className={`text-5xl font-bold ${getScoreColor(score)}`}>
              {score}
            </div>
            <div className="text-slate-400 text-sm mt-1">/ 10</div>
          </div>
          <div>
            <div className={`text-xl font-semibold ${getScoreColor(score)}`}>
              {getScoreLabel(score)}
            </div>
            <p className="text-slate-400 text-sm mt-1">Overall Interview Score</p>
            <div className="mt-3 w-48 h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${
                  score >= 8
                    ? 'bg-emerald-500'
                    : score >= 6
                    ? 'bg-indigo-500'
                    : score >= 4
                    ? 'bg-amber-500'
                    : 'bg-red-500'
                }`}
                style={{ width: `${(score / 10) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Session Info */}
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>Session ID:</span>
        <code className="font-mono bg-slate-800 px-2 py-0.5 rounded text-slate-400">
          {sessionId}
        </code>
      </div>

      {/* Feedback Sections */}
      <div className="space-y-4">
        {sections.map((section, i) => {
          // Skip a section if it's just about the score (already shown above)
          if (score !== null && section.title.toLowerCase().includes('score')) return null;

          return (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden"
            >
              <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-800">
                {getSectionIcon(section.title)}
                <h3 className="font-semibold text-white text-sm">{section.title}</h3>
              </div>
              <div className="px-5 py-4">{formatContent(section.content)}</div>
            </div>
          );
        })}
      </div>

      {/* Raw feedback fallback if no sections parsed */}
      {sections.length === 1 && sections[0].title === 'Interview Feedback' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{feedback}</p>
        </div>
      )}
    </div>
  );
}
