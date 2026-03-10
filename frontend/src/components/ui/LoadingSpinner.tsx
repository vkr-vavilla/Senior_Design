import { cn } from '@/lib/utils';

type SpinnerSize = 'sm' | 'md' | 'lg' | 'xl';
type SpinnerColor = 'indigo' | 'white' | 'slate' | 'emerald';

interface LoadingSpinnerProps {
  size?: SpinnerSize;
  color?: SpinnerColor;
  className?: string;
}

const sizeClasses: Record<SpinnerSize, string> = {
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
  lg: 'w-8 h-8 border-[3px]',
  xl: 'w-12 h-12 border-4',
};

const colorClasses: Record<SpinnerColor, string> = {
  indigo: 'border-indigo-500/20 border-t-indigo-500',
  white: 'border-white/20 border-t-white',
  slate: 'border-slate-600 border-t-slate-300',
  emerald: 'border-emerald-500/20 border-t-emerald-500',
};

export function LoadingSpinner({
  size = 'md',
  color = 'indigo',
  className,
}: LoadingSpinnerProps) {
  return (
    <div
      className={cn(
        'rounded-full animate-spin',
        sizeClasses[size],
        colorClasses[color],
        className
      )}
      role="status"
      aria-label="Loading"
    />
  );
}

interface LoadingPageProps {
  message?: string;
}

export function LoadingPage({ message = 'Loading...' }: LoadingPageProps) {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <LoadingSpinner size="xl" />
        <p className="text-slate-400 text-sm">{message}</p>
      </div>
    </div>
  );
}
