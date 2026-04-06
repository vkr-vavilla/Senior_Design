'use client';

import { useEffect, useState } from 'react';

interface RotatingTextProps {
  words: string[];
  className?: string;
  typeSpeed?: number;   // ms per character when typing
  deleteSpeed?: number; // ms per character when deleting
  pauseTime?: number;   // ms to hold full word before deleting
}

export function RotatingText({
  words,
  className = '',
  typeSpeed = 90,
  deleteSpeed = 45,
  pauseTime = 1600,
}: RotatingTextProps) {
  const [wordIndex, setWordIndex] = useState(0);
  const [text, setText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const currentWord = words[wordIndex % words.length];
    const atFull = !isDeleting && text === currentWord;
    const atEmpty = isDeleting && text === '';

    let timeout: ReturnType<typeof setTimeout>;

    if (atFull) {
      timeout = setTimeout(() => setIsDeleting(true), pauseTime);
    } else if (atEmpty) {
      setIsDeleting(false);
      setWordIndex((i) => (i + 1) % words.length);
    } else {
      timeout = setTimeout(
        () => {
          setText((t) =>
            isDeleting ? currentWord.slice(0, t.length - 1) : currentWord.slice(0, t.length + 1)
          );
        },
        isDeleting ? deleteSpeed : typeSpeed
      );
    }

    return () => clearTimeout(timeout);
  }, [text, isDeleting, wordIndex, words, typeSpeed, deleteSpeed, pauseTime]);

  return (
    <span className={className}>
      {text}
      <span
        aria-hidden
        className="inline-block w-[3px] h-[0.85em] -mb-[0.05em] ml-1 bg-current align-middle animate-pulse-cursor"
      />
    </span>
  );
}
