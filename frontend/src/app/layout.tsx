import type { Metadata, Viewport } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  display: 'swap',
  weight: ['500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'FinalRound — Your AI Interview Coach',
  description:
    'Ace your next interview with FinalRound. Practice with our AI interviewer, get real-time feedback, and land your dream job.',
  keywords: ['mock interview', 'AI interview', 'interview prep', 'job preparation'],
};

export const viewport: Viewport = {
  themeColor: '#020617',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceGrotesk.variable} dark`}
      suppressHydrationWarning
    >
      <body className="bg-slate-950 text-white antialiased min-h-screen">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
