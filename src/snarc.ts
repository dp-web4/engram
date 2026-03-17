/**
 * SNARC Heuristic Scorer v2
 *
 * Scores observations on 5 dimensions without any LLM calls:
 *   S — Surprise:  how unexpected was this tool transition?
 *   N — Novelty:   are the files/symbols/concepts new?
 *   A — Arousal:   errors, warnings, state changes, outputs?
 *   R — Reward:    did this advance the task? (output-aware)
 *   C — Conflict:  does this contradict recent observations?
 *
 * v2 philosophy: T1 threshold is very low — the job of T1 is to remember
 * the conversation. Salience scoring differentiates for T2 promotion and
 * search ranking, but should NOT gatekeep most observations out of T1.
 * A memory system that doesn't remember isn't useful.
 *
 * Adapted from SAGE's neural SNARC scorer (sage/services/snarc/)
 * into pure heuristic TypeScript. No model, no embeddings, <10ms per score.
 */

import type { Statements } from './db.js';
import type { CircularBuffer, RawObservation } from './buffer.js';

export interface SNARCScores {
  surprise: number;
  novelty: number;
  arousal: number;
  reward: number;
  conflict: number;
  salience: number;
}

// Salience weights — rebalanced for v2
// Reduced reward weight (was the main flattener), increased arousal
const WEIGHTS = {
  surprise: 0.20,
  novelty: 0.25,
  arousal: 0.25,
  reward: 0.20,
  conflict: 0.10,
};

// v2: Very low T1 threshold — remember the conversation.
// Salience still matters for ranking and T2 promotion, but T1 should
// capture nearly everything. Only truly empty/redundant observations
// should be dropped.
const SALIENCE_THRESHOLD = 0.1;

// Error/warning patterns
const ERROR_PATTERNS = /\b(error|Error|ERROR|FAIL|fail|panic|exception|Exception|EXCEPTION|fatal|Fatal)\b/;
const WARNING_PATTERNS = /\b(warning|Warning|WARN|warn|deprecated|Deprecated)\b/;
const SUCCESS_PATTERNS = /\b(pass|Pass|PASS|success|Success|OK|ok|✓|passed|succeeded|completed)\b/;
const STATE_CHANGE_PATTERNS = /\b(created|Created|deleted|Deleted|modified|Modified|renamed|moved|installed|removed|updated)\b/;

export class SNARCScorer {
  private stmts: Statements;
  private buffer: CircularBuffer;
  // Track recent results per tool+target for conflict detection
  private recentResults = new Map<string, boolean>(); // tool:target → success?

  constructor(stmts: Statements, buffer: CircularBuffer) {
    this.stmts = stmts;
    this.buffer = buffer;
  }

  score(obs: RawObservation): SNARCScores {
    const surprise = this.scoreSurprise(obs);
    const novelty = this.scoreNovelty(obs);
    const arousal = this.scoreArousal(obs);
    const reward = this.scoreReward(obs);
    const conflict = this.scoreConflict(obs);

    const salience =
      WEIGHTS.surprise * surprise +
      WEIGHTS.novelty * novelty +
      WEIGHTS.arousal * arousal +
      WEIGHTS.reward * reward +
      WEIGHTS.conflict * conflict;

    return { surprise, novelty, arousal, reward, conflict, salience };
  }

  get threshold(): number {
    return SALIENCE_THRESHOLD;
  }

  private scoreSurprise(obs: RawObservation): number {
    const prevTool = this.buffer.lastToolName;
    if (!prevTool) return 0.5; // first observation — moderate surprise

    // Look up transition frequency
    const row = this.stmts.getTransitionCount.get(prevTool, obs.toolName) as { count: number } | undefined;
    const count = row?.count || 0;

    const maxRow = this.stmts.getMaxTransition.get(prevTool) as { max_count: number } | undefined;
    const maxCount = maxRow?.max_count || 1;

    // Record this transition
    this.stmts.upsertTransition.run(prevTool, obs.toolName);

    // Surprise = 1 - normalized frequency
    return count === 0 ? 0.8 : 1.0 - Math.min(count / maxCount, 1.0);
  }

  private scoreNovelty(obs: RawObservation): number {
    const tokens = extractTokens(obs.inputSummary);
    if (tokens.length === 0) return 0.3; // v2: no tokens ≠ no novelty, just unknown

    // Batch check which tokens are already seen
    // SQLite IN clause — check up to 20 at a time
    const batch = tokens.slice(0, 20);
    const seen = new Set<string>();

    try {
      const rows = this.stmts.checkSeen.raw().all(
        ...batch.concat(Array(20 - batch.length).fill(''))
      ) as string[][];
      for (const row of rows) {
        if (row[0]) seen.add(row[0]);
      }
    } catch {
      // If query fails (placeholder mismatch), fall back to individual checks
    }

    // Update seen_set for all tokens
    for (const token of tokens) {
      this.stmts.upsertSeen.run(token);
    }

    // Novelty = fraction of tokens that were NOT in seen_set
    const newCount = tokens.filter(t => !seen.has(t)).length;
    return newCount / tokens.length;
  }

  private scoreArousal(obs: RawObservation): number {
    let arousal = 0;
    const output = obs.outputSummary || '';
    const input = obs.inputSummary || '';

    // v2: Arousal is not just errors — it's "anything happened worth noting"

    // Errors and warnings (high arousal)
    if (obs.exitCode !== undefined && obs.exitCode !== 0) arousal += 0.5;
    if (ERROR_PATTERNS.test(output)) arousal += 0.3;
    if (WARNING_PATTERNS.test(output)) arousal += 0.15;

    // State changes (moderate arousal)
    if (STATE_CHANGE_PATTERNS.test(output)) arousal += 0.15;

    // Git operations (shared state changes)
    if (obs.toolName === 'Bash' && /\bgit\s+(commit|push|merge|rebase|reset|checkout)/.test(input)) {
      arousal += 0.25;
    }

    // v2: Output-producing operations are inherently arousing
    // Writing/creating files is an event worth noting
    if (obs.toolName === 'Write') arousal += 0.4;
    if (obs.toolName === 'Edit') arousal += 0.3;

    // Bash commands that produce output (not just reads)
    if (obs.toolName === 'Bash' && output.length > 50) arousal += 0.15;

    // Agent tool use (delegation = significant action)
    if (obs.toolName === 'Agent') arousal += 0.35;

    // Successful completions with substantial output
    if (SUCCESS_PATTERNS.test(output)) arousal += 0.1;

    // Large output suggests something meaningful happened
    if (output.length > 200) arousal += 0.1;

    // v2: Base arousal floor — every tool use is at least a little notable
    // This prevents the 0.0 arousal that was flattening everything
    arousal = Math.max(arousal, 0.15);

    return Math.min(arousal, 1.0);
  }

  private scoreReward(obs: RawObservation): number {
    const output = obs.outputSummary || '';
    const input = obs.inputSummary || '';

    // v2: Much more granular reward scoring
    // The old 0.1 neutral default was the #1 cause of flat salience

    // === High reward (0.7-1.0): clear task advancement ===

    // Test passing
    if (SUCCESS_PATTERNS.test(output) && /test|spec/i.test(input)) return 0.8;

    // Git commit (task milestone)
    if (obs.toolName === 'Bash' && /git\s+commit/.test(input)) return 0.7;

    // Git push (shipping work)
    if (obs.toolName === 'Bash' && /git\s+push/.test(input)) return 0.75;

    // === Medium-high reward (0.5-0.7): productive output ===

    // Writing a new file (creation is significant)
    if (obs.toolName === 'Write' && !ERROR_PATTERNS.test(output)) {
      // Larger files = more reward (rough proxy for significance)
      const contentLen = input.length;
      if (contentLen > 5000) return 0.7;
      if (contentLen > 1000) return 0.6;
      return 0.5;
    }

    // Build success
    if (SUCCESS_PATTERNS.test(output) && /build|compile/i.test(input)) return 0.6;

    // === Medium reward (0.3-0.5): useful work ===

    // Editing existing file
    if (obs.toolName === 'Edit' && !ERROR_PATTERNS.test(output)) return 0.45;

    // Agent delegation (orchestrating work)
    if (obs.toolName === 'Agent') return 0.5;

    // Bash with substantial output (something happened)
    if (obs.toolName === 'Bash' && !ERROR_PATTERNS.test(output) && output.length > 100) return 0.4;

    // Install/setup operations
    if (/install|setup|init|create/i.test(input)) return 0.4;

    // === Low-medium reward (0.2-0.3): information gathering ===

    // Reading files (research/understanding)
    if (obs.toolName === 'Read') return 0.25;

    // Search operations (grep, glob)
    if (obs.toolName === 'Grep' || obs.toolName === 'Glob') return 0.2;

    // Bash reads/queries
    if (obs.toolName === 'Bash' && /\b(ls|cat|head|tail|find|grep|which|echo)\b/.test(input)) return 0.2;

    // === Negative reward ===
    if (ERROR_PATTERNS.test(output)) return 0.05; // v2: not zero — errors are still worth remembering

    // v2: Default is 0.25 (was 0.1) — neutral operations still have some value
    return 0.25;
  }

  private scoreConflict(obs: RawObservation): number {
    const key = `${obs.toolName}:${extractTarget(obs.inputSummary)}`;
    const output = obs.outputSummary || '';
    const currentSuccess = !ERROR_PATTERNS.test(output) && (obs.exitCode === undefined || obs.exitCode === 0);

    const previousSuccess = this.recentResults.get(key);
    this.recentResults.set(key, currentSuccess);

    // Conflict: previous succeeded, now fails (or vice versa)
    if (previousSuccess !== undefined && previousSuccess !== currentSuccess) {
      return previousSuccess && !currentSuccess ? 0.8 : 0.4; // fail-after-success is higher conflict
    }

    // Same file edited multiple times in recent buffer
    const recent = this.buffer.getLast(5);
    const sameTarget = recent.filter(r =>
      r.toolName === obs.toolName && extractTarget(r.inputSummary) === extractTarget(obs.inputSummary)
    ).length;
    if (sameTarget >= 2) return 0.3;

    return 0;
  }
}

/** Extract searchable tokens from tool input — file paths, commands, packages */
function extractTokens(input: string): string[] {
  if (!input) return [];
  const tokens = new Set<string>();

  // File paths
  const paths = input.match(/[\w./\-]+\.\w{1,10}/g);
  if (paths) paths.forEach(p => tokens.add(p));

  // Package names (from npm/pip/cargo commands)
  const packages = input.match(/(?:install|add|require)\s+([\w@/.-]+)/g);
  if (packages) packages.forEach(p => tokens.add(p.split(/\s+/)[1]));

  // Error codes
  const errors = input.match(/[A-Z][A-Z0-9_]{3,}/g);
  if (errors) errors.forEach(e => tokens.add(e));

  // v2: Also extract meaningful words from the input (function names, identifiers)
  const identifiers = input.match(/\b[a-zA-Z_]\w{4,30}\b/g);
  if (identifiers) {
    // Skip common stop-words
    const stop = new Set(['false', 'true', 'null', 'undefined', 'const', 'function', 'return', 'import', 'export', 'string', 'number', 'boolean']);
    identifiers
      .filter(id => !stop.has(id.toLowerCase()))
      .slice(0, 10)
      .forEach(id => tokens.add(id));
  }

  return [...tokens].slice(0, 20); // cap at 20
}

/** Extract the primary target (file path or command) from tool input */
function extractTarget(input: string): string {
  if (!input) return '';
  // Try file path first
  const pathMatch = input.match(/([\w./\-]+\.\w{1,10})/);
  if (pathMatch) return pathMatch[1];
  // Fall back to first 50 chars
  return input.slice(0, 50);
}
