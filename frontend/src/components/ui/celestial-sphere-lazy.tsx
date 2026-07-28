'use client';

import dynamic from 'next/dynamic';

// three.js is ~140 kB gzipped — keep it out of the landing page's initial
// bundle. The shader is a decorative background, so it can stream in after
// hydration; until then the page's dark base color shows, which is what the
// shader fades up from anyway. ssr:false because it renders to a WebGL canvas.
const CelestialSphere = dynamic(() => import('./celestial-sphere'), { ssr: false });

export default CelestialSphere;
