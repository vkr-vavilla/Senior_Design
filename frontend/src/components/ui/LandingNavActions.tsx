'use client';

import { useAuthContext } from '@/contexts/AuthContext';
import { ArrowRight, LayoutDashboard } from 'lucide-react';
import Link from 'next/link';

// Small client island so the landing page (a server component) can still
// show auth-aware nav actions. A signed-in user who clicks through to the
// landing page keeps their session — this just makes that visible instead
// of showing "Sign In / Get Started" regardless of auth state, which reads
// as having been logged out even though nothing was actually cleared.
export function LandingNavActions() {
  const { user, isLoading } = useAuthContext();

  if (isLoading) {
    // Reserve the space so the buttons don't pop in after the auth check
    // resolves, avoiding a flash of "Sign In" for an already-logged-in user.
    return <div className="w-[132px] h-9" />;
  }

  if (user) {
    return (
      <Link
        href="/dashboard"
        className="group/btn relative inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white cursor-pointer overflow-hidden transition-all duration-200"
      >
        <span className="absolute inset-0 bg-gradient-to-r from-indigo-600 to-violet-600 group-hover/btn:from-indigo-500 group-hover/btn:to-violet-500 transition-all duration-200" />
        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
        <span className="relative">Dashboard</span>
        <LayoutDashboard className="relative w-3.5 h-3.5 group-hover/btn:translate-x-0.5 transition-transform duration-200" />
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Link
        href="/login"
        className="text-sm text-slate-400 hover:text-white transition-colors duration-200 px-4 py-2 rounded-xl hover:bg-white/[0.05] cursor-pointer"
      >
        Sign In
      </Link>

      <div className="h-4 w-px bg-slate-700/60 mx-1" />

      <Link
        href="/register"
        className="group/btn relative inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white cursor-pointer overflow-hidden transition-all duration-200"
      >
        <span className="absolute inset-0 bg-gradient-to-r from-indigo-600 to-violet-600 group-hover/btn:from-indigo-500 group-hover/btn:to-violet-500 transition-all duration-200" />
        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
        <span className="relative">Get Started</span>
        <ArrowRight className="relative w-3.5 h-3.5 group-hover/btn:translate-x-0.5 transition-transform duration-200" />
      </Link>
    </div>
  );
}
