'use client';

import { Suspense, lazy, useEffect, useRef } from 'react';
const Spline = lazy(() => import('@splinetool/react-spline'));

interface InteractiveRobotSplineProps {
  scene: string;
  className?: string;
}

function removeSplineWatermark(container: HTMLElement) {
  // Spline injects a watermark as #logo or an <a> pointing to spline.design
  const targets = [
    container.querySelector('#logo'),
    ...Array.from(container.querySelectorAll('a[href*="spline.design"]')),
  ].filter(Boolean) as HTMLElement[];

  targets.forEach((el) => {
    el.style.setProperty('display', 'none', 'important');
  });
}

export function InteractiveRobotSpline({ scene, className }: InteractiveRobotSplineProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // Run once immediately in case it's already there
    removeSplineWatermark(wrapper);

    // Watch for the watermark being injected after the scene loads
    const observer = new MutationObserver(() => removeSplineWatermark(wrapper));
    observer.observe(wrapper, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={wrapperRef} className={`relative ${className ?? ''}`}>
      <Suspense
        fallback={
          <div className="w-full h-full flex items-center justify-center bg-slate-900">
            <svg
              className="animate-spin h-6 w-6 text-indigo-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l2-2.647z"
              />
            </svg>
          </div>
        }
      >
        <Spline scene={scene} className="w-full h-full" />
      </Suspense>
    </div>
  );
}
