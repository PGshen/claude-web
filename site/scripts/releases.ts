// Writes site/src/data/site-data.json from the GitHub API: the latest release, its installers, the stars.
//   node site/scripts/releases.ts          (GITHUB_TOKEN, when set, lifts the API's rate limit)
// When the API cannot be reached the committed file stays as it is and the build goes on with it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteData, type GhRelease } from '../src/data/releases.ts';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/data/site-data.json');
const REPO = 'PGshen/claude-web';
const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'claude-web-site' };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function get(url: string): Promise<unknown> {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

try {
  const [releases, repo] = await Promise.all([
    get(`https://api.github.com/repos/${REPO}/releases?per_page=100`) as Promise<GhRelease[]>,
    get(`https://api.github.com/repos/${REPO}`) as Promise<{ stargazers_count: number }>,
  ]);
  const data = siteData(releases, repo.stargazers_count, new Date().toISOString());
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`site data: ${data.release?.version ?? 'no release'}, ${data.stars} stars, ${data.releases} releases`);
} catch (e) {
  console.warn(`site data: kept the committed file (${(e as Error).message})`);
}
