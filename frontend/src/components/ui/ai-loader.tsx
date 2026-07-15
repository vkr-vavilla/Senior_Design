import * as React from 'react';

interface AILoaderProps {
  size?: number;
  /** Letters shown inside the orb — defaults to the interviewer's name. */
  text?: string;
  className?: string;
}

/**
 * Animated orb avatar for the AI interviewer: a rotating glowing ring with
 * the interviewer's name pulsing letter by letter. Renders inline (sized by
 * `size`), so it can sit above the chat transcript rather than covering the
 * page.
 */
export const AILoader: React.FC<AILoaderProps> = ({
  size = 140,
  text = 'Alex',
  className = '',
}) => {
  const letters = text.split('');

  return (
    <div
      className={`relative flex items-center justify-center select-none ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${text} — AI interviewer`}
    >
      <div className="flex" style={{ fontSize: Math.max(14, size * 0.14) }}>
        {letters.map((letter, index) => (
          <span
            key={index}
            className="inline-block font-semibold tracking-wide text-white opacity-40 ai-loader-letter"
            style={{ animationDelay: `${index * 0.1}s` }}
          >
            {letter === ' ' ? ' ' : letter}
          </span>
        ))}
      </div>

      <div className="absolute inset-0 rounded-full ai-loader-circle" />

      <style>{`
        @keyframes aiLoaderCircle {
          0% {
            transform: rotate(90deg);
            box-shadow:
              0 6px 12px 0 #38bdf8 inset,
              0 12px 18px 0 #005dff inset,
              0 36px 36px 0 #1e40af inset,
              0 0 3px 1.2px rgba(56, 189, 248, 0.3),
              0 0 6px 1.8px rgba(0, 93, 255, 0.2);
          }
          50% {
            transform: rotate(270deg);
            box-shadow:
              0 6px 12px 0 #60a5fa inset,
              0 12px 6px 0 #0284c7 inset,
              0 24px 36px 0 #005dff inset,
              0 0 3px 1.2px rgba(56, 189, 248, 0.3),
              0 0 6px 1.8px rgba(0, 93, 255, 0.2);
          }
          100% {
            transform: rotate(450deg);
            box-shadow:
              0 6px 12px 0 #4dc8fd inset,
              0 12px 18px 0 #005dff inset,
              0 36px 36px 0 #1e40af inset,
              0 0 3px 1.2px rgba(56, 189, 248, 0.3),
              0 0 6px 1.8px rgba(0, 93, 255, 0.2);
          }
        }

        @keyframes aiLoaderLetter {
          0%, 100% {
            opacity: 0.4;
            transform: translateY(0);
          }
          20% {
            opacity: 1;
            transform: scale(1.15);
          }
          40% {
            opacity: 0.7;
            transform: translateY(0);
          }
        }

        .ai-loader-circle {
          animation: aiLoaderCircle 5s linear infinite;
        }

        .ai-loader-letter {
          animation: aiLoaderLetter 3s infinite;
        }
      `}</style>
    </div>
  );
};

// Alias kept for compatibility with the original snippet's `Component` export.
export { AILoader as Component };
