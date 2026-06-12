// app/page.tsx — RepoScout main dashboard
// Hero strip with live counters + RepositoryRiskGrid

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getDashboardStats, getRepositories } from '@/lib/db';
import type { DashboardStats, RepoRow } from '@/lib/db';
import { RepositoryRiskGrid } from './components/RepositoryRiskGrid';
import { HeroStrip } from './components/HeroStrip';
import { ParticleBackground } from './components/ParticleBackground';
import { BookmarksPanel } from './components/BookmarksPanel';

export const runtime = 'edge';
export const revalidate = 60; // revalidate every minute

export default async function DashboardPage() {
  let stats: DashboardStats = {
    totalRepos: 0,
    criticalFindings: 0,
    analystQueueCount: 0,
    lastScanAt: null,
  };
  let repos: RepoRow[] = [];

  try {
    const { env } = await getCloudflareContext();
    [stats, repos] = await Promise.all([
      getDashboardStats(env.DB),
      getRepositories(env.DB, 50),
    ]);
  } catch {
    // Dev fallback — no CF context in `next dev`
  }

  return (
    <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
      <ParticleBackground />
      <HeroStrip stats={stats} />
      <BookmarksPanel />
      <RepositoryRiskGrid repos={repos} />
    </main>
  );
}
