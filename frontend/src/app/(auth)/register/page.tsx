import Link from 'next/link';
import { RegisterForm } from '@/components/auth/RegisterForm';
import { NeuralNetworkBackground } from '@/components/ui/NeuralNetworkBackground';
import { Logo } from '@/components/ui/Logo';

export default function RegisterPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4 py-12 relative overflow-hidden">
      {/* Neural network — full background */}
      <div className="absolute inset-0 pointer-events-none">
        <NeuralNetworkBackground className="w-full h-full" />
      </div>

      {/* Centre ambient glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[400px] bg-violet-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex">
            <Logo size="lg" />
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-white">Create your account</h1>
          <p className="mt-2 text-slate-400 text-sm">
            Start practicing and ace your next interview
          </p>
        </div>

        {/* Card */}
        <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-black/60">
          <RegisterForm />

          <div className="mt-6 pt-6 border-t border-slate-800 text-center">
            <p className="text-sm text-slate-400">
              Already have an account?{' '}
              <Link
                href="/login"
                className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          By creating an account, you agree to our terms of service.
        </p>
      </div>
    </div>
  );
}
