import { Bot } from 'lucide-react';

type LogoSize = 'sm' | 'md' | 'lg';

interface LogoProps {
  size?: LogoSize;
  showTagline?: boolean;
  showStatus?: boolean;
}

const SIZE_CONFIG: Record<
  LogoSize,
  { tile: string; icon: string; text: string; gap: string; tagline: string; dot: string }
> = {
  sm: {
    tile: 'w-7 h-7 rounded-lg',
    icon: 'w-3.5 h-3.5',
    text: 'text-sm',
    gap: 'gap-2',
    tagline: 'text-[8px]',
    dot: 'w-1.5 h-1.5 -top-0.5 -right-0.5',
  },
  md: {
    tile: 'w-9 h-9 rounded-xl',
    icon: 'w-4 h-4',
    text: 'text-lg',
    gap: 'gap-2.5',
    tagline: 'text-[9px]',
    dot: 'w-2 h-2 -top-0.5 -right-0.5',
  },
  lg: {
    tile: 'w-12 h-12 rounded-2xl',
    icon: 'w-6 h-6',
    text: 'text-2xl',
    gap: 'gap-3',
    tagline: 'text-[11px]',
    dot: 'w-2.5 h-2.5 -top-0.5 -right-0.5',
  },
};

export function Logo({ size = 'md', showTagline = true, showStatus = true }: LogoProps) {
  const cfg = SIZE_CONFIG[size];

  return (
    <div className={`group flex items-center ${cfg.gap} shrink-0`}>
      <div
        className={`relative ${cfg.tile} bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-600 flex items-center justify-center shadow-lg shadow-indigo-500/30 group-hover:shadow-indigo-500/50 transition-shadow`}
      >
        <Bot className={`${cfg.icon} text-white`} />
        {showStatus && (
          <span
            className={`absolute ${cfg.dot} rounded-full bg-emerald-400 ring-2 ring-slate-950`}
          />
        )}
      </div>
      <div className="flex flex-col leading-none">
        <span
          className={`${cfg.text} font-bold tracking-tight bg-gradient-to-r from-white via-slate-200 to-indigo-200 bg-clip-text text-transparent`}
        >
          Final
          <span className="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
            Round
          </span>
        </span>
        {showTagline && (
          <span
            className={`${cfg.tagline} font-semibold tracking-[0.18em] text-slate-500 uppercase mt-0.5`}
          >
            AI Interview Coach
          </span>
        )}
      </div>
    </div>
  );
}
