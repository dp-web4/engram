/**
 * Membot Bridge — dual-write and comparison instrumentation for SNARC.
 *
 * EXPERIMENT: Testing whether embedding-based retrieval (membot) provides
 * materially better context recall than keyword-based FTS5 (SNARC).
 *
 * This bridge:
 * 1. Dual-writes: stores content in both SNARC (SQLite/FTS5) and membot (embeddings)
 * 2. Dual-searches: queries both systems and logs comparison data
 * 3. Logs metrics to experiment_log.jsonl for analysis
 *
 * Membot must be running as HTTP MCP server on localhost:8000.
 * If membot is unavailable, all operations silently fall back to SNARC-only.
 *
 * 2026-03-26 — Experiment Phase 1
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostname } from 'node:os';

const MEMBOT_URL = process.env.MEMBOT_URL || 'http://localhost:8001'; // REST bridge port (not MCP 8000)
const EXPERIMENT_DIR = join(homedir(), '.snarc', 'membot');
const EXPERIMENT_LOG = join(EXPERIMENT_DIR, 'experiment_log.jsonl');

// Ensure experiment directory exists
try { mkdirSync(EXPERIMENT_DIR, { recursive: true }); } catch {}

interface MembotResult {
  text: string;
  score: number;
}

interface ComparisonEntry {
  ts: string;
  event: 'dual_search' | 'dual_store';
  query?: string;
  content_preview?: string;
  snarc_results?: Array<{ summary: string; score: number; tier: number }>;
  membot_results?: MembotResult[];
  overlap_count?: number;
  snarc_unique?: number;
  membot_unique?: number;
  snarc_time_ms?: number;
  membot_time_ms?: number;
  membot_store_ms?: number;
  membot_available: boolean;
  machine: string;
}

function logExperiment(entry: ComparisonEntry): void {
  try {
    appendFileSync(EXPERIMENT_LOG, JSON.stringify(entry) + '\n');
  } catch {
    // Non-critical — don't block on logging
  }
}

/**
 * Call membot via its REST bridge (plain HTTP POST, no MCP protocol).
 * The REST bridge runs on port 8001 alongside the MCP server on 8000.
 * Endpoints: /store, /search, /mount, /save, /status
 */
async function callMembot(tool: string, args: Record<string, any>): Promise<string | null> {
  // Map MCP tool names to REST endpoints
  const endpointMap: Record<string, string> = {
    memory_store: '/store',
    memory_search: '/search',
    mount_cartridge: '/mount',
    save_cartridge: '/save',
    get_status: '/status',
  };

  const endpoint = endpointMap[tool];
  if (!endpoint) return null;

  try {
    const method = endpoint === '/status' ? 'GET' : 'POST';
    const opts: RequestInit = {
      method,
      signal: AbortSignal.timeout(10000),
    };

    if (method === 'POST') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(args);
    }

    const resp = await fetch(`${MEMBOT_URL}${endpoint}`, opts);
    if (!resp.ok) return null;

    const data = await resp.json() as any;
    // REST bridge returns {ok, msg, raw}
    return data.msg || data.raw || JSON.stringify(data);
  } catch {
    return null; // membot not available — silent fallback
  }
}

function parseMembotSearchResults(raw: string): MembotResult[] {
  const results: MembotResult[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('Search')) continue;
    // Format: "N. [0.xyz] text..."
    if (trimmed[0] >= '0' && trimmed[0] <= '9' && trimmed.includes('] ')) {
      try {
        const parts = trimmed.split('] ', 1);
        const scoreMatch = trimmed.match(/\[([0-9.]+)\]/);
        if (scoreMatch) {
          const score = parseFloat(scoreMatch[1]);
          const text = trimmed.split('] ').slice(1).join('] ').trim();
          results.push({ text: text.slice(0, 200), score });
        }
      } catch {}
    }
  }
  return results;
}

/**
 * Store content in membot (in addition to SNARC's normal SQLite storage).
 * Call this after SNARC stores an observation or pattern.
 */
export async function membotStore(content: string, tags: string = ''): Promise<boolean> {
  const t0 = Date.now();
  const result = await callMembot('memory_store', { content, tags });
  const elapsed = Date.now() - t0;

  const stored = result !== null && result.includes('Stored');

  logExperiment({
    ts: new Date().toISOString(),
    event: 'dual_store',
    content_preview: content.slice(0, 100),
    membot_store_ms: elapsed,
    membot_available: result !== null,
    machine: hostname(),
  });

  return stored;
}

/**
 * Search both SNARC (FTS5) and membot (embeddings), log comparison.
 * Returns membot results for blending into briefing.
 */
export async function membotDualSearch(
  query: string,
  snarcResults: Array<{ summary: string; salience?: number; tier?: number }>,
  snarcTimeMs: number,
): Promise<MembotResult[]> {
  const t0 = Date.now();
  const raw = await callMembot('memory_search', { query, top_k: 5 });
  const membotTimeMs = Date.now() - t0;

  if (!raw) {
    logExperiment({
      ts: new Date().toISOString(),
      event: 'dual_search',
      query,
      snarc_results: snarcResults.map(r => ({
        summary: r.summary?.slice(0, 100) || '',
        score: r.salience || 0,
        tier: r.tier || 1,
      })),
      membot_results: [],
      overlap_count: 0,
      snarc_unique: snarcResults.length,
      membot_unique: 0,
      snarc_time_ms: snarcTimeMs,
      membot_time_ms: membotTimeMs,
      membot_available: false,
      machine: hostname(),
    });
    return [];
  }

  const membotResults = parseMembotSearchResults(raw);

  // Compute overlap (simple: check if any membot result text appears in snarc summaries)
  const snarcTexts = new Set(snarcResults.map(r => (r.summary || '').toLowerCase().slice(0, 80)));
  let overlapCount = 0;
  for (const mr of membotResults) {
    const mrKey = mr.text.toLowerCase().slice(0, 80);
    if ([...snarcTexts].some(st => st.includes(mrKey) || mrKey.includes(st))) {
      overlapCount++;
    }
  }

  logExperiment({
    ts: new Date().toISOString(),
    event: 'dual_search',
    query,
    snarc_results: snarcResults.map(r => ({
      summary: r.summary?.slice(0, 100) || '',
      score: r.salience || 0,
      tier: r.tier || 1,
    })),
    membot_results: membotResults,
    overlap_count: overlapCount,
    snarc_unique: snarcResults.length - overlapCount,
    membot_unique: membotResults.length - overlapCount,
    snarc_time_ms: snarcTimeMs,
    membot_time_ms: membotTimeMs,
    membot_available: true,
    machine: hostname(),
  });

  return membotResults;
}

/**
 * Ensure membot has a cartridge mounted for this project.
 */
export async function membotEnsureMounted(projectHash: string): Promise<boolean> {
  const name = `snarc-${projectHash}`;
  const result = await callMembot('mount_cartridge', { name });
  if (result && result.includes('Mounted')) return true;
  if (result && result.includes('not found')) {
    // No cartridge yet — that's fine, will be created on first store
    return false;
  }
  return false;
}

/**
 * Save the current cartridge to disk.
 */
export async function membotSave(): Promise<boolean> {
  const result = await callMembot('save_cartridge', {});
  return result !== null && result.includes('Saved');
}
