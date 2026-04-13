import { AnimateIn } from '@/components/ui/AnimateIn';
import CelestialSphere from '@/components/ui/celestial-sphere';
import { ContainerScroll } from '@/components/ui/container-scroll-animation';
import { FeatureCards } from '@/components/ui/FeatureCards';
import { InteractiveRobotSpline } from '@/components/ui/interactive-3d-robot';
import { Logo } from '@/components/ui/Logo';
import { AISessionCard } from '@/components/ui/RobotHUD';
import { RotatingText } from '@/components/ui/RotatingText';
import {
  ArrowRight,
  Bot,
  MessageSquare,
  Star,
  Target,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

const ROBOT_SCENE = 'https://prod.spline.design/PyzDhpQ9E5f1E3MT/scene.splinecode';

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      {/* WebGL shader background */}
      <CelestialSphere
        hue={230}
        speed={0.4}
        zoom={1.2}
        particleSize={4.0}
        className="fixed inset-0 w-full h-full -z-10"
      />
      {/* Dark overlay so content sections stay readable */}
      <div className="fixed inset-0 bg-slate-950/55 pointer-events-none -z-[5]" />

      {/* ── Navbar ────────────────────────────────────────────── */}
      <nav className="absolute top-4 inset-x-4 z-50 max-w-6xl mx-auto">
        {/* Outer glow halo */}
        <div className="absolute -inset-px rounded-[18px] bg-gradient-to-r from-indigo-500/15 via-violet-500/10 to-indigo-500/15 blur-sm pointer-events-none" />

        <div className="relative flex items-center justify-between px-4 py-2.5 rounded-2xl bg-slate-950/80 backdrop-blur-2xl border border-white/[0.07] shadow-2xl shadow-black/50">

          {/* ── Brand ── */}
          <Link href="/" className="cursor-pointer">
            <Logo size="md" />
          </Link>

          {/* ── Nav actions ── */}
          <div className="flex items-center gap-1">
            <Link
              href="/login"
              className="text-sm text-slate-400 hover:text-white transition-colors duration-200 px-4 py-2 rounded-xl hover:bg-white/[0.05] cursor-pointer"
            >
              Sign In
            </Link>

            {/* Divider */}
            <div className="h-4 w-px bg-slate-700/60 mx-1" />

            <Link
              href="/register"
              className="group/btn relative inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white cursor-pointer overflow-hidden transition-all duration-200"
            >
              {/* Button gradient bg */}
              <span className="absolute inset-0 bg-gradient-to-r from-indigo-600 to-violet-600 group-hover/btn:from-indigo-500 group-hover/btn:to-violet-500 transition-all duration-200" />
              {/* Bottom glow */}
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
              <span className="relative">Get Started</span>
              <ArrowRight className="relative w-3.5 h-3.5 group-hover/btn:translate-x-0.5 transition-transform duration-200" />
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero — split layout ───────────────────────────────── */}
      <section className="relative min-h-screen flex items-center pt-20 pb-8 overflow-hidden">
        {/* Ambient orb — left side behind text */}
        <div className="absolute top-1/3 -left-32 w-[600px] h-[600px] bg-indigo-600/12 rounded-full blur-[130px] pointer-events-none animate-float" />
        {/* Ambient orb — right top */}
        <div
          className="absolute top-0 right-0 w-[500px] h-[500px] bg-violet-500/8 rounded-full blur-[100px] pointer-events-none animate-float"
          style={{ animationDelay: '4s' }}
        />

        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full py-16">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-8 items-center">

            {/* ── Left: text content ── */}
            <div className="flex flex-col order-2 lg:order-1">
              {/* Headline */}
              <h1
                className="animate-fade-up text-5xl sm:text-6xl lg:text-[3.75rem] xl:text-7xl font-bold tracking-tight text-white mb-6 leading-[1.07]"
                style={{ animationDelay: '80ms' }}
              >
                Land Your
                <br />
                <RotatingText
                  className="gradient-text inline-block min-h-[1.1em]"
                  words={['Dream Job', 'Top Offer', 'Big Tech Role', 'FAANG Seat', 'Next Chapter']}
                />
                <br />
                <span className="text-slate-300 text-4xl sm:text-5xl lg:text-[3rem] xl:text-6xl font-semibold">
                  with AI Interviews
                </span>
              </h1>


            </div>

            {/* ── Right: 3D Robot ── */}
            <div
              className="animate-fade-up relative order-1 lg:order-2 h-[380px] sm:h-[500px] lg:h-[640px]"
              style={{ animationDelay: '150ms' }}
            >
              {/* Outer glow */}
              <div className="absolute -inset-4 bg-indigo-500/8 rounded-3xl blur-2xl pointer-events-none" />

              {/* Robot container */}
              <div className="relative w-full h-full rounded-2xl overflow-hidden border border-slate-800/60">
                {/* Left blend — merges robot into dark bg */}
                <div className="absolute inset-0 pointer-events-none z-10 bg-gradient-to-r from-slate-950/60 via-transparent to-transparent" />
                {/* Bottom blend */}
                <div className="absolute bottom-0 inset-x-0 h-28 pointer-events-none z-10 bg-gradient-to-t from-slate-950 to-transparent" />
                {/* Top blend */}
                <div className="absolute top-0 inset-x-0 h-16 pointer-events-none z-10 bg-gradient-to-b from-slate-950/40 to-transparent" />

                <InteractiveRobotSpline scene={ROBOT_SCENE} className="w-full h-full" />
              </div>

              <AISessionCard />
            </div>

          </div>
        </div>
      </section>

      {/* ── Stats bar ─────────────────────────────────────────── */}
      <section className="relative border-y border-slate-800/40 py-14 bg-slate-950/50 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            {[
              { value: '50+', label: 'Role Types Supported', icon: Target },
              { value: '3', label: 'Difficulty Levels', icon: Zap },
              { value: 'Real-time', label: 'AI Feedback Every Session', icon: MessageSquare },
            ].map((stat, i) => (
              <AnimateIn key={stat.label} delay={i * 100} className="flex flex-col items-center text-center gap-2">
                <stat.icon className="w-5 h-5 text-indigo-400 mb-1" />
                <div className="text-3xl sm:text-4xl font-bold text-white">{stat.value}</div>
                <div className="text-sm text-slate-500">{stat.label}</div>
              </AnimateIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Product Showcase — ContainerScroll ───────────────── */}
      <section className="relative overflow-hidden bg-slate-950/30 backdrop-blur-sm">
        <ContainerScroll
          titleComponent={
            <div className="mb-6">
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700/80 text-slate-400 text-xs font-medium mb-5">
                Live Session
              </span>
              <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-4 leading-tight">
                Your AI interviewer,
                <br />
                <span className="gradient-text">ready when you are</span>
              </h2>
              <p className="text-slate-400 text-lg max-w-xl mx-auto">
                A real conversation. Real feedback. Every session sharpens your edge.
              </p>
            </div>
          }
        >
          {/* Mock interview UI inside the scroll card */}
          <div className="w-full h-full bg-slate-950 rounded-xl overflow-hidden flex flex-col">
            {/* Session top bar */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-900/80 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-white" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-white leading-none">Final Round AI</div>
                  <div className="text-[10px] text-emerald-400 mt-0.5 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse" />
                    Interviewing now
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 bg-slate-800 border border-slate-700/80 rounded-lg text-[11px] text-slate-400">
                  Software Engineer · Senior
                </span>
                <span className="px-2.5 py-1 bg-slate-800 border border-slate-700/80 rounded-lg text-[11px] text-slate-400">
                  Technical
                </span>
              </div>
            </div>

            {/* Chat area */}
            <div className="flex-1 overflow-hidden px-6 py-5 space-y-5">
              {/* AI message 1 */}
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-md shadow-indigo-500/20">
                  <Bot className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-[11px] text-indigo-400 font-medium mb-1.5">AI Interviewer</div>
                  <div className="bg-slate-800/80 border border-slate-700/50 rounded-xl rounded-tl-sm px-4 py-3 text-sm text-slate-200 leading-relaxed max-w-lg">
                    Let&apos;s start with a classic system design question. How would you design a
                    real-time messaging system like Slack that can scale to millions of concurrent
                    users?
                  </div>
                </div>
              </div>

              {/* User message */}
              <div className="flex gap-3 justify-end">
                <div className="text-right">
                  <div className="text-[11px] text-slate-500 font-medium mb-1.5">You</div>
                  <div className="inline-block bg-indigo-600/25 border border-indigo-500/30 rounded-xl rounded-tr-sm px-4 py-3 text-sm text-slate-200 leading-relaxed text-left max-w-lg">
                    I&apos;d start by clarifying requirements — DAU, message volume, latency
                    targets. For the core architecture I&apos;d use WebSocket connections managed
                    by a stateless gateway layer, with presence tracked via Redis pub/sub.
                    Messages would be persisted asynchronously to Cassandra for horizontal
                    write scalability...
                  </div>
                </div>
                <div className="w-8 h-8 rounded-lg bg-slate-700/80 border border-slate-600/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Users className="w-4 h-4 text-slate-300" />
                </div>
              </div>

              {/* AI message 2 — follow-up */}
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-md shadow-indigo-500/20">
                  <Bot className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-[11px] text-indigo-400 font-medium mb-1.5">AI Interviewer</div>
                  <div className="bg-slate-800/80 border border-slate-700/50 rounded-xl rounded-tl-sm px-4 py-3 text-sm text-slate-200 leading-relaxed max-w-lg">
                    Great — good instinct to clarify requirements first. How would you handle
                    message ordering guarantees across distributed nodes?
                  </div>
                </div>
              </div>
            </div>

            {/* Live feedback bar */}
            <div className="flex-shrink-0 border-t border-slate-800 px-6 py-4 bg-slate-900/60">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">Strong start</span>
                </div>
                <div className="flex-1 grid grid-cols-3 gap-3">
                  {[
                    { label: 'Clarity', val: 90, color: 'from-indigo-500 to-violet-400' },
                    { label: 'Technical', val: 85, color: 'from-violet-500 to-indigo-400' },
                    { label: 'Structure', val: 88, color: 'from-indigo-400 to-cyan-400' },
                  ].map(({ label, val, color }) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500 w-12">{label}</span>
                      <div className="flex-1 h-1 bg-slate-700 rounded-full overflow-hidden">
                        <div className={`h-full bg-gradient-to-r ${color} rounded-full`} style={{ width: `${val}%` }} />
                      </div>
                      <span className="text-[10px] text-slate-400 w-5 text-right">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </ContainerScroll>
      </section>

      {/* ── Features ─────────────────────────────────────────── */}
      <section className="py-28 relative bg-slate-950/60 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <AnimateIn className="text-center mb-14">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700/80 text-slate-400 text-xs font-medium mb-4">
              Features
            </span>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
              Everything you need to{' '}
              <span className="text-indigo-400">interview better</span>
            </h2>
            <p className="text-slate-400 text-lg max-w-xl mx-auto">
              A complete platform to practice, improve, and ace your next interview.
            </p>
          </AnimateIn>

          <FeatureCards />
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────── */}
      <section className="py-28 border-y border-slate-800/40 bg-slate-950/50 backdrop-blur-sm relative overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] bg-indigo-600/7 rounded-full blur-[120px] pointer-events-none" />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <AnimateIn className="text-center mb-20">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700/80 text-slate-400 text-xs font-medium mb-4">
              How It Works
            </span>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
              Start practicing in{' '}
              <span className="text-indigo-400">under a minute</span>
            </h2>
            <p className="text-slate-400 text-lg max-w-lg mx-auto">
              No setup required. Just sign up, pick your role, and start your mock interview.
            </p>
          </AnimateIn>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
            {/* Connector line */}
            <div className="hidden md:block absolute top-10 left-[calc(33.33%+2rem)] right-[calc(33.33%+2rem)] h-px bg-gradient-to-r from-indigo-500/40 via-violet-500/40 to-indigo-500/40" />

            {[
              {
                step: '01',
                title: 'Create Your Account',
                desc: 'Sign up for free in seconds. No credit card needed to get started with Final Round.',
                icon: Users,
                accent: { text: 'text-indigo-400', border: 'border-indigo-500/30', shadow: 'shadow-indigo-500/10' },
              },
              {
                step: '02',
                title: 'Configure Interview',
                desc: 'Select your target role, interview type (technical or behavioral), and difficulty level.',
                icon: Target,
                accent: { text: 'text-violet-400', border: 'border-violet-500/30', shadow: 'shadow-violet-500/10' },
              },
              {
                step: '03',
                title: 'Practice & Improve',
                desc: 'Complete the mock interview and receive detailed AI feedback with your performance score.',
                icon: TrendingUp,
                accent: { text: 'text-emerald-400', border: 'border-emerald-500/30', shadow: 'shadow-emerald-500/10' },
              },
            ].map((item, i) => (
              <AnimateIn key={item.step} delay={i * 130} className="flex flex-col items-center text-center">
                <div
                  className={`relative w-20 h-20 rounded-2xl bg-slate-900 border ${item.accent.border} shadow-lg ${item.accent.shadow} flex items-center justify-center mb-6 z-10`}
                >
                  <span className={`text-3xl font-bold ${item.accent.text}`}>{item.step}</span>
                </div>
                <h3 className="text-xl font-bold text-white mb-3">{item.title}</h3>
                <p className="text-slate-400 leading-relaxed max-w-xs">{item.desc}</p>
              </AnimateIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <section className="py-28 relative overflow-hidden bg-slate-950/40 backdrop-blur-sm">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] bg-indigo-600/18 rounded-full blur-[140px] pointer-events-none animate-float-slow" />

        <div className="relative max-w-4xl mx-auto px-4">
          <AnimateIn>
            <div className="relative p-10 sm:p-14 bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-3xl overflow-hidden text-center">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/8 via-transparent to-violet-600/8 rounded-3xl" />
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-px bg-gradient-to-r from-transparent via-indigo-500/60 to-transparent" />

              <div className="relative">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 text-sm font-medium mb-6">
                  <Star className="w-3.5 h-3.5" />
                  Join successful candidates
                </div>
                <h2 className="text-4xl sm:text-5xl font-bold text-white mb-4 text-balance">
                  Ready to ace your
                  <br />
                  <span className="gradient-text">next interview?</span>
                </h2>
                <p className="text-slate-400 text-lg mb-8 max-w-xl mx-auto">
                  Start practicing today. No setup required, no credit card needed.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                  <Link
                    href="/register"
                    className="group inline-flex items-center gap-2.5 px-8 py-4 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:-translate-y-0.5 cursor-pointer text-base w-full sm:w-auto justify-center"
                  >
                    Start for Free
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                  </Link>
                  <Link
                    href="/login"
                    className="text-slate-400 hover:text-white transition-colors duration-200 text-sm cursor-pointer"
                  >
                    Already have an account? Sign in
                  </Link>
                </div>
              </div>
            </div>
          </AnimateIn>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="py-10 border-t border-slate-800/40 bg-slate-950/70 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <Logo size="sm" showTagline={false} showStatus={false} />
            <p className="text-slate-500 text-sm">
              &copy; {new Date().getFullYear()} FinalRound. Built with AI to help you succeed.
            </p>
            <div className="flex items-center gap-6 text-sm text-slate-500">
              <Link href="/login" className="hover:text-slate-300 transition-colors duration-200 cursor-pointer">
                Sign In
              </Link>
              <Link href="/register" className="hover:text-slate-300 transition-colors duration-200 cursor-pointer">
                Sign Up
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
