'use client';

import { LandingNavActions } from '@/components/ui/LandingNavActions';
import { Logo } from '@/components/ui/Logo';
import {
  Check,
  Copy,
  Cpu,
  Database,
  Download,
  Mic,
  RefreshCw,
  Terminal,
  Volume2,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

// Bundles are published by .github/workflows/desktop-release.yml, which builds
// the Tauri shell on all three runners and attaches the artifacts to a release.
// `releases/latest/download/<asset>` always resolves to the newest release, so
// these links don't need touching when the version bumps — only ASSETS does,
// since Tauri stamps the version into each filename.
const REPO = 'https://github.com/vkr-vavilla/Senior_Design';
const VERSION = '0.1.2';
const DL = `${REPO}/releases/latest/download`;

type OSKey = 'mac' | 'windows' | 'linux';

const ASSETS: Record<
  OSKey,
  { name: string; sub: string; file: string; alt?: { label: string; file: string } }
> = {
  mac: {
    name: 'macOS',
    sub: 'Apple Silicon · universal',
    file: `FinalRound_${VERSION}_universal.dmg`,
  },
  windows: {
    name: 'Windows',
    sub: 'Windows 10/11 · 64-bit',
    file: `FinalRound_${VERSION}_x64-setup.exe`,
  },
  linux: {
    name: 'Linux',
    sub: 'Debian / Ubuntu · .deb',
    file: `FinalRound_${VERSION}_amd64.deb`,
    alt: { label: 'Prefer a portable AppImage?', file: `FinalRound_${VERSION}_amd64.AppImage` },
  },
};

const OS_ICONS: Record<OSKey, React.ReactNode> = {
  mac: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6" aria-hidden="true">
      <path d="M17.05 12.54c-.03-2.7 2.2-4 2.3-4.06-1.25-1.83-3.2-2.08-3.9-2.11-1.66-.17-3.24.98-4.08.98-.84 0-2.14-.96-3.52-.93-1.81.03-3.48 1.05-4.4 2.67-1.88 3.26-.48 8.08 1.35 10.72.9 1.29 1.96 2.74 3.36 2.69 1.35-.06 1.86-.87 3.49-.87 1.63 0 2.09.87 3.52.84 1.45-.02 2.37-1.31 3.25-2.61 1.03-1.5 1.45-2.95 1.47-3.02-.03-.01-2.82-1.08-2.85-4.3M14.4 4.6c.74-.9 1.24-2.15 1.1-3.4-1.07.05-2.36.71-3.13 1.61-.68.79-1.28 2.06-1.12 3.28 1.19.09 2.41-.6 3.15-1.49" />
    </svg>
  ),
  windows: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6" aria-hidden="true">
      <path d="M3 5.5 10.2 4.5v7.05H3V5.5m8.1-1.13L21 3v8.55h-9.9V4.37M3 12.45h7.2v7.06L3 18.5v-6.05m8.1 0H21V21l-9.9-1.36v-7.19Z" />
    </svg>
  ),
  linux: <Terminal className="w-6 h-6" aria-hidden="true" />,
};

const MODES = {
  gpu: {
    label: 'NVIDIA GPU',
    tag: 'Fastest',
    blurb: 'Runs the fine-tuned model locally on your own card. Fully offline.',
    accent: 'text-indigo-400',
    force: './setup_local.sh --gpu',
    rows: [
      ['Operating system', 'Linux', 'Linux, kernel headers installed'],
      ['GPU', 'NVIDIA · 10 GB VRAM', 'NVIDIA · 12 GB+ VRAM'],
      ['NVIDIA driver', '535+ (you install this)', '570'],
      ['System RAM', '16 GB', '32 GB'],
      ['Free disk', '20 GB', '25 GB SSD'],
      ['Also needed', 'Docker, Compose, Container Toolkit — installed for you', '—'],
    ],
    note: 'The app installs Docker, Compose and the NVIDIA Container Toolkit itself. The GPU driver is the one thing it will not touch — see the setup steps below. Without a working driver it falls back to Cloud mode automatically. First launch downloads ~5.5 GB of weights once.',
  },
  mac: {
    label: 'Apple Silicon',
    tag: 'Mac',
    blurb:
      'Metal + unified memory — the GPU reads the same memory pool, so there is no transfer penalty.',
    accent: 'text-violet-400',
    force: './setup_local.sh --ollama',
    rows: [
      ['Operating system', 'macOS 13+', 'macOS 14+'],
      ['Chip', 'M1 / M2 / M3 / M4', 'M2 Pro or better'],
      ['Unified memory', '16 GB', '24 GB+'],
      ['Free disk', '12 GB', '16 GB SSD'],
      ['Also needed', 'Docker Desktop, Ollama (installed natively)', '—'],
    ],
    note: 'Ollama must run natively on macOS, not in Docker — containers cannot reach Metal. The installer checks for it and tells you how to fix it.',
  },
  api: {
    label: 'Cloud API',
    tag: 'No GPU',
    blurb:
      'No local model at all. Use this on any machine without a supported GPU — speech and the coding round still run on your device.',
    accent: 'text-cyan-400',
    force: './setup_local.sh --api',
    rows: [
      ['Operating system', 'macOS / Linux / Windows', 'any'],
      ['GPU', 'None', 'None'],
      ['System RAM', '8 GB', '16 GB'],
      ['Free disk', '6 GB', '8 GB'],
      ['Also needed', 'Docker + Compose v2, free Gemini API key', '—'],
    ],
    note: 'Only interview text leaves your machine. Transcription, voice and code execution stay local.',
  },
} as const;

type ModeKey = keyof typeof MODES;

const STACK = [
  { icon: Cpu, title: 'Interviewer model', desc: 'Qwen2.5-7B with a fine-tuned interviewer adapter — the persona that runs your mock interview.' },
  { icon: Mic, title: 'Speech-to-text', desc: 'faster-whisper transcribes your spoken answers on-device. No cloud, no key.', local: true },
  { icon: Volume2, title: 'Text-to-speech', desc: 'Questions read aloud via Google Cloud TTS. Optional — needs Google credentials; interviews run fine without it.' },
  { icon: Database, title: 'MongoDB', desc: 'Bundled database for accounts, transcripts and generated feedback.' },
  { icon: Terminal, title: 'Coding sandbox', desc: 'Runs your code in the live coding round, with 50 problems pre-seeded.' },
  { icon: RefreshCw, title: 'Crash recovery', desc: 'Redis snapshots every turn, so an interrupted interview resumes where it stopped.' },
];

// Per-OS "you downloaded it, now what" steps. Kept as data so the section
// below stays a dumb renderer. `code` lines render in a copyable mono block.
const RUN_STEPS: Record<OSKey, { text: React.ReactNode; code?: string }[]> = {
  linux: [
    {
      text: 'Install the .deb, then launch "FinalRound" from your app menu:',
      code: `sudo apt install ./${ASSETS.linux.file}`,
    },
    {
      text: 'Using the portable AppImage instead? Make it executable and run it. Ubuntu 22.04+ ships FUSE 3 only, so the AppImage needs libfuse2 — install it if you see "Cannot mount AppImage":',
      code: `chmod +x ${ASSETS.linux.alt!.file}\n./${ASSETS.linux.alt!.file}\n\n# only if it refuses to mount:\nsudo apt install libfuse2`,
    },
    {
      text: 'On first launch the app checks for Docker. If anything is missing, click "Install Docker" — after your admin password it installs Docker, Docker Compose, the docker group and (on NVIDIA machines) the container toolkit, then continues on its own. Everything else it needs ships inside the app.',
    },
  ],
  mac: [
    { text: 'Open the .dmg and drag FinalRound into Applications.' },
    {
      text: 'First launch only: right-click FinalRound in Applications and choose "Open", then confirm. macOS blocks the double-click because this build isn’t Apple-notarized yet — nothing is wrong with the app. Terminal alternative:',
      code: 'xattr -cr /Applications/FinalRound.app',
    },
    {
      text: 'The app then checks for Docker (and Ollama on Apple Silicon) and offers to install whichever is missing — no manual setup.',
    },
  ],
  windows: [
    {
      text: `Run ${ASSETS.windows.file}. If SmartScreen shows "Windows protected your PC", click "More info" → "Run anyway" — the build isn’t code-signed yet.`,
    },
    {
      text: 'Install Docker Desktop from docker.com if you don’t have it — on Windows the app checks for it but can’t install it for you yet.',
    },
  ],
};

function detectOS(): OSKey {
  if (typeof navigator === 'undefined') return 'mac';
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') || p.includes('android')) return 'linux';
  return 'mac';
}

export default function DownloadPage() {
  // Default to macOS for SSR, then correct on mount — the server has no way to
  // know the visitor's platform, and guessing wrong for one frame is cheaper
  // than blocking the whole hero on a client-only render.
  const [os, setOs] = useState<OSKey>('mac');
  const [mode, setMode] = useState<ModeKey>('gpu');
  const [copied, setCopied] = useState(false);

  useEffect(() => setOs(detectOS()), []);

  const primary = ASSETS[os];
  const spec = MODES[mode];

  const copyCmd = `git clone ${REPO}.git\ncd Senior_Design\n./setup_local.sh`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyCmd);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-950">
      {/* Ambient orbs — static, matching the landing page's toned-down set */}
      <div className="fixed top-0 -left-40 w-[600px] h-[600px] bg-[radial-gradient(circle,rgba(79,70,229,0.10)_0%,transparent_65%)] pointer-events-none -z-10" />
      <div className="fixed top-1/3 -right-40 w-[500px] h-[500px] bg-[radial-gradient(circle,rgba(124,58,237,0.10)_0%,transparent_65%)] pointer-events-none -z-10" />

      {/* ── Navbar ────────────────────────────────────────────── */}
      <nav className="absolute top-4 inset-x-4 z-50 max-w-6xl mx-auto">
        <div className="absolute -inset-px rounded-[18px] bg-gradient-to-r from-indigo-500/15 via-violet-500/10 to-indigo-500/15 blur-sm pointer-events-none" />
        <div className="relative flex items-center justify-between px-4 py-2.5 rounded-2xl bg-slate-950/95 border border-white/[0.07] shadow-2xl shadow-black/50">
          <Link href="/" className="cursor-pointer">
            <Logo size="md" />
          </Link>
          <LandingNavActions />
        </div>
      </nav>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="relative pt-36 pb-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700/80 text-slate-400 text-xs font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Free · open source · runs on your machine
          </span>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-white mb-6 leading-[1.08]">
            Download FinalRound
            <br />
            <span className="gradient-text">for your desktop</span>
          </h1>

          <p className="text-slate-400 text-lg max-w-2xl mx-auto mb-10">
            A native app that runs the whole interview stack — the AI interviewer, offline speech,
            a coding sandbox and its own database — privately on your own hardware.
          </p>

          {/* Primary, OS-detected download */}
          <div className="flex flex-col items-center gap-3">
            <a
              href={`${DL}/${primary.file}`}
              className="group inline-flex items-center gap-3 px-8 py-4 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:-translate-y-0.5 cursor-pointer text-base"
            >
              <Download className="w-5 h-5" />
              Download for {primary.name}
              <span className="text-indigo-200/70 text-sm font-normal">{primary.sub}</span>
            </a>
            <p className="text-slate-500 text-sm">
              Version {VERSION} · or{' '}
              <a href="#platforms" className="text-slate-400 hover:text-white underline underline-offset-4 transition-colors">
                pick another platform
              </a>
            </p>
          </div>
        </div>
      </section>

      {/* ── Platforms ─────────────────────────────────────────── */}
      <section id="platforms" className="relative py-16 border-y border-slate-800/40 bg-slate-950/70">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {(Object.keys(ASSETS) as OSKey[]).map((key) => {
              const a = ASSETS[key];
              const isCurrent = key === os;
              return (
                <div
                  key={key}
                  className={`relative p-6 rounded-2xl border transition-all duration-200 ${
                    isCurrent
                      ? 'bg-slate-900 border-indigo-500/40 shadow-lg shadow-indigo-500/10'
                      : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {isCurrent && (
                    <span className="absolute top-4 right-4 text-[10px] font-medium uppercase tracking-wider text-indigo-400">
                      Your system
                    </span>
                  )}
                  <div className={isCurrent ? 'text-indigo-400' : 'text-slate-400'}>
                    {OS_ICONS[key]}
                  </div>
                  <h3 className="text-lg font-bold text-white mt-4 mb-1">{a.name}</h3>
                  <p className="text-sm text-slate-500 mb-5">{a.sub}</p>
                  <a
                    href={`${DL}/${a.file}`}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-sm font-medium transition-colors duration-200 w-full justify-center cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    Download
                  </a>
                  {a.alt && (
                    <a
                      href={`${DL}/${a.alt.file}`}
                      className="block text-center text-xs text-slate-500 hover:text-slate-300 mt-3 transition-colors cursor-pointer"
                    >
                      {a.alt.label}
                    </a>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-center text-slate-500 text-sm mt-8">
            All builds are produced by CI from the public source.{' '}
            <a
              href={`${REPO}/releases`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400 hover:text-white underline underline-offset-4 transition-colors"
            >
              Browse all releases
            </a>
          </p>

          {/* After downloading — per-OS run instructions */}
          <div className="mt-12 rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <div className="flex items-center justify-between gap-4 flex-wrap px-6 py-4 border-b border-slate-800 bg-slate-900">
              <h3 className="font-bold text-white">After downloading</h3>
              <div className="flex gap-1.5">
                {(Object.keys(ASSETS) as OSKey[]).map((key) => (
                  <button
                    key={key}
                    onClick={() => setOs(key)}
                    aria-pressed={key === os}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                      key === os
                        ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                        : 'text-slate-400 border border-slate-700 hover:text-white hover:border-slate-600'
                    }`}
                  >
                    {ASSETS[key].name}
                  </button>
                ))}
              </div>
            </div>
            <ol className="px-6 py-5 space-y-4">
              {RUN_STEPS[os].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-xs font-medium flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-400 leading-relaxed">{step.text}</p>
                    {step.code && (
                      <pre className="mt-2 px-4 py-3 rounded-lg bg-slate-950 border border-slate-800 overflow-x-auto text-xs font-mono text-slate-300 leading-relaxed">
                        <code>{step.code}</code>
                      </pre>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── Requirements ──────────────────────────────────────── */}
      <section className="relative py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700/80 text-slate-400 text-xs font-medium mb-4">
              System requirements
            </span>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
              How the model <span className="text-indigo-400">runs on your machine</span>
            </h2>
            <p className="text-slate-400 text-lg max-w-2xl mx-auto">
              The app detects your hardware and picks the right engine automatically. Local
              inference is GPU-only by design — a 7B model on CPU is too slow for a live
              conversation, so machines without a supported GPU use the cloud instead.
            </p>
          </div>

          {/* Mode selector */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {(Object.keys(MODES) as ModeKey[]).map((key) => {
              const m = MODES[key];
              const active = key === mode;
              return (
                <button
                  key={key}
                  onClick={() => setMode(key)}
                  aria-pressed={active}
                  className={`text-left p-5 rounded-2xl border transition-all duration-200 cursor-pointer ${
                    active
                      ? 'bg-slate-900 border-indigo-500/50 shadow-lg shadow-indigo-500/10 -translate-y-0.5'
                      : 'bg-slate-900/40 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-xs font-medium uppercase tracking-wider ${m.accent}`}>
                      {m.tag}
                    </span>
                    {active && <Check className="w-4 h-4 text-indigo-400" />}
                  </div>
                  <h3 className="text-lg font-bold text-white mb-1.5">{m.label}</h3>
                  <p className="text-sm text-slate-500 leading-relaxed">{m.blurb}</p>
                </button>
              );
            })}
          </div>

          {/* Spec sheet */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <div className="flex items-center justify-between gap-4 flex-wrap px-6 py-4 border-b border-slate-800 bg-slate-900">
              <h3 className="font-bold text-white">{spec.label}</h3>
              <code className="text-xs text-slate-500 font-mono">
                force with <span className="text-slate-300">{spec.force}</span>
              </code>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="text-left font-medium text-slate-500 text-xs uppercase tracking-wider px-6 py-3">
                      Component
                    </th>
                    <th className="text-left font-medium text-slate-500 text-xs uppercase tracking-wider px-6 py-3">
                      Minimum
                    </th>
                    <th className="text-left font-medium text-slate-500 text-xs uppercase tracking-wider px-6 py-3">
                      Recommended
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {spec.rows.map(([label, min, rec]) => (
                    <tr key={label} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-6 py-3.5 text-slate-400">{label}</td>
                      <td className="px-6 py-3.5 text-slate-400 font-mono text-xs">{min}</td>
                      <td className="px-6 py-3.5 text-white font-mono text-xs">{rec}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-3 px-6 py-4 bg-indigo-500/[0.07] border-t border-slate-800">
              <Zap className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-slate-400">{spec.note}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── NVIDIA driver prerequisite ─────────────────────────── */}
      <section id="nvidia" className="relative py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-900">
              <h3 className="font-bold text-white">Running the model on your own NVIDIA GPU</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Only needed for local GPU inference — skip it entirely if you're using Cloud mode.
              </p>
            </div>
            <div className="px-6 py-5 space-y-4 text-sm text-slate-400 leading-relaxed">
              <p>
                FinalRound installs Docker, Docker Compose and the NVIDIA Container Toolkit for
                you. It deliberately does <span className="text-slate-300">not</span> install the
                GPU driver: that builds a kernel module, needs a reboot, and a failed attempt
                leaves your package manager wedged. Install it yourself first.
              </p>
              <div>
                <p className="text-slate-300 font-medium mb-2">Ubuntu / Debian</p>
                <pre className="px-4 py-3 rounded-lg bg-slate-950 border border-slate-800 overflow-x-auto text-xs font-mono text-slate-300 leading-relaxed">
                  <code>{`sudo apt update
sudo apt install linux-headers-$(uname -r)
sudo ubuntu-drivers install          # picks the right driver for your card
# or pin a version explicitly:
sudo apt install nvidia-driver-570
sudo reboot`}</code>
                </pre>
              </div>
              <div>
                <p className="text-slate-300 font-medium mb-2">Then confirm it works</p>
                <pre className="px-4 py-3 rounded-lg bg-slate-950 border border-slate-800 overflow-x-auto text-xs font-mono text-slate-300 leading-relaxed">
                  <code>{`nvidia-smi        # must list your GPU
dpkg --audit      # must print nothing`}</code>
                </pre>
              </div>
              <div className="flex gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-3.5 py-3">
                <Zap className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-slate-400">
                  <span className="text-amber-300 font-medium">If a driver install fails</span>{' '}
                  (a broken <code className="font-mono">nvidia-dkms-*</code> build is the usual
                  culprit), no further software can install until it's cleared. Run{' '}
                  <code className="font-mono text-slate-300">sudo dpkg --configure -a</code>, then{' '}
                  <code className="font-mono text-slate-300">sudo apt-get -f install</code>. The
                  most common cause is kernel headers that don't match{' '}
                  <code className="font-mono">uname -r</code>.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── What's included ───────────────────────────────────── */}
      <section className="relative py-24 border-y border-slate-800/40 bg-slate-950/70">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700/80 text-slate-400 text-xs font-medium mb-4">
              Everything included
            </span>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
              One download, the <span className="gradient-text">whole platform</span>
            </h2>
            <p className="text-slate-400 text-lg max-w-2xl mx-auto">
              No accounts to create, no services to wire up. On a GPU or Apple Silicon machine the
              entire pipeline runs locally.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {STACK.map((c) => (
              <div
                key={c.title}
                className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-colors duration-200"
              >
                <div className="flex items-center gap-3 mb-3">
                  <c.icon className="w-5 h-5 text-indigo-400 flex-shrink-0" />
                  <h3 className="font-bold text-white">{c.title}</h3>
                  {c.local && (
                    <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-emerald-400">
                      Offline
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-400 leading-relaxed">{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── From source ───────────────────────────────────────── */}
      <section className="relative py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700/80 text-slate-400 text-xs font-medium mb-4">
              Advanced
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              Or run it <span className="text-indigo-400">from source</span>
            </h2>
            <p className="text-slate-400">
              Prefer the terminal? The desktop app is a wrapper around these three commands.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900">
              <span className="text-xs text-slate-500 font-mono">bash</span>
              <button
                onClick={copy}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:text-white hover:border-slate-600 transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="px-5 py-4 overflow-x-auto text-sm font-mono leading-relaxed text-slate-300">
              <code>
                <span className="text-slate-600"># clone, then let setup detect your hardware</span>
                {'\n'}git clone {REPO}.git{'\n'}cd Senior_Design{'\n'}
                <span className="text-indigo-400">./setup_local.sh</span>
                <span className="text-slate-600">   # --gpu / --ollama / --api to force a mode</span>
              </code>
            </pre>
          </div>

          <p className="text-center text-slate-500 text-sm mt-6">
            Updating later is <code className="text-slate-400 font-mono">git pull</code>, then
            restart FinalRound — the app rebuilds itself on the next launch.
          </p>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="py-10 border-t border-slate-800/40 bg-slate-950/85">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <Logo size="sm" showTagline={false} showStatus={false} />
            <p className="text-slate-500 text-sm">
              &copy; {new Date().getFullYear()} FinalRound. Built with AI to help you succeed.
            </p>
            <div className="flex items-center gap-6 text-sm text-slate-500">
              <Link href="/" className="hover:text-slate-300 transition-colors duration-200 cursor-pointer">
                Home
              </Link>
              <a
                href={REPO}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-slate-300 transition-colors duration-200 cursor-pointer"
              >
                Source
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
