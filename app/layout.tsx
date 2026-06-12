import type { Metadata } from 'next';
import './globals.css';
import { Navbar } from './components/Navbar';
import { ScrollProgress } from './components/ScrollProgress';
import { BackgroundBeams } from './components/BackgroundBeams';

export const metadata: Metadata = {
  title: {
    default: 'RepoScout — Continuous GitHub Secret Scanning',
    template: '%s | RepoScout',
  },
  description:
    'AI-powered GitHub secret scanning with LangGraph verification pipeline. Real-time credential detection, triage, and risk scoring.',
  keywords: ['secret scanning', 'github security', 'credential leak', 'security dashboard', 'devsecops'],
  robots: { index: false, follow: false }, // internal tool — don't index
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-dark-bg text-white font-mono antialiased min-h-screen flex flex-col">
        <ScrollProgress />

        {/* Subtle grid background */}
        <div className="fixed inset-0 bg-grid pointer-events-none" aria-hidden="true" />

        {/* Ambient beam lines */}
        <BackgroundBeams />

        {/* Radial neon glow at top-center */}
        <div
          className="fixed top-0 left-1/2 -translate-x-1/2 w-[900px] h-[350px] pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at center top, rgba(255,26,26,0.06) 0%, transparent 70%)',
          }}
          aria-hidden="true"
        />

        <Navbar />

        <div className="relative flex-1 flex flex-col">
          {children}
        </div>

        <footer className="border-t border-neon-red/8 py-4 px-6 text-center text-[10px] font-mono text-neon-red/20">
          RepoScout · Cloudflare Workers AI · D1 · KV · SecretScout patterns
        </footer>
      </body>
    </html>
  );
}
