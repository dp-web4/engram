/**
 * Consolidation — the "dream cycle."
 *
 * Runs at SessionEnd. Takes Tier 1 observations and extracts patterns:
 * - Tool sequence patterns (recurring workflows)
 * - Error-fix chains (error followed by fix on same target)
 * - Concept clusters (observations grouped by shared files/tokens)
 */

import type Database from 'better-sqlite3';
import type { Statements } from './db.js';

interface Observation {
  id: number;
  tool_name: string;
  input_summary: string;
  output_summary: string;
  salience: number;
  ts: string;
  tags: string;
}

export function consolidate(
  db: Database.Database,
  stmts: Statements,
  sessionObs: Observation[],
  sessionId: string,
): { patternsCreated: number; patternsDecayed: number; patternsPruned: number } {
  // Always run decay/prune, even if no observations this session
  const decayResult = stmts.decayPatterns.run();
  const patternsDecayed = decayResult.changes;
  stmts.decayObservations.run();
  const pruneResult = stmts.prunePatterns.run();
  const patternsPruned = pruneResult.changes;

  if (sessionObs.length < 3) return { patternsCreated: 0, patternsDecayed, patternsPruned };

  let created = 0;

  // 1. Tool sequence patterns
  created += extractToolSequences(stmts, sessionObs);

  // 2. Error-fix chains
  created += extractErrorFixChains(stmts, sessionObs);

  // 3. Concept clusters
  created += extractConceptClusters(stmts, sessionObs);

  return { patternsCreated: created, patternsDecayed, patternsPruned };
}

/**
 * Find repeated tool sequences (e.g., Edit → Bash → Edit = TDD loop)
 */
function extractToolSequences(stmts: Statements, obs: Observation[]): number {
  const windowSize = 3;
  const sequences = new Map<string, { count: number; ids: number[] }>();

  for (let i = 0; i <= obs.length - windowSize; i++) {
    const seq = obs.slice(i, i + windowSize).map(o => o.tool_name).join(' → ');
    const entry = sequences.get(seq) || { count: 0, ids: [] };
    entry.count++;
    entry.ids.push(...obs.slice(i, i + windowSize).map(o => o.id));
    sequences.set(seq, entry);
  }

  let created = 0;
  for (const [seq, entry] of sequences) {
    if (entry.count >= 2) {
      stmts.upsertPattern.run(
        'tool_sequence',
        `Recurring workflow: ${seq}`,
        JSON.stringify({ sequence: seq.split(' → '), count: entry.count }),
        entry.count,
        JSON.stringify([...new Set(entry.ids)]),
        Math.min(0.5 + entry.count * 0.1, 0.9),
      );
      created++;
    }
  }
  return created;
}

/**
 * Find error → fix chains: high-arousal observation followed by success on same target
 */
function extractErrorFixChains(stmts: Statements, obs: Observation[]): number {
  let created = 0;

  for (let i = 0; i < obs.length - 1; i++) {
    const current = obs[i];
    if (!isError(current)) continue;

    // Look ahead up to 5 observations for a fix
    for (let j = i + 1; j < Math.min(i + 6, obs.length); j++) {
      const candidate = obs[j];
      if (isSuccess(candidate) && shareTarget(current, candidate)) {
        const errorSig = extractErrorSignature(current.output_summary);
        const fixApproach = candidate.input_summary.slice(0, 200);

        stmts.upsertPattern.run(
          'error_fix',
          `Error: ${errorSig} → Fix: ${fixApproach}`,
          JSON.stringify({
            error: current.output_summary.slice(0, 300),
            fix: candidate.input_summary.slice(0, 300),
            tool: current.tool_name,
            steps: j - i,
          }),
          1,
          JSON.stringify([current.id, candidate.id]),
          0.6,
        );
        created++;
        break; // don't double-count
      }
    }
  }
  return created;
}

/**
 * Group observations by shared files/tokens into concept clusters
 */
function extractConceptClusters(stmts: Statements, obs: Observation[]): number {
  // Extract file paths from each observation
  const fileToObs = new Map<string, number[]>();

  for (const o of obs) {
    const files = extractFiles(o.input_summary);
    for (const f of files) {
      const list = fileToObs.get(f) || [];
      list.push(o.id);
      fileToObs.set(f, list);
    }
  }

  let created = 0;
  for (const [file, ids] of fileToObs) {
    if (ids.length >= 3) {
      stmts.upsertPattern.run(
        'concept_cluster',
        `Focused work on ${file}`,
        JSON.stringify({ file, observation_count: ids.length }),
        ids.length,
        JSON.stringify([...new Set(ids)]),
        Math.min(0.4 + ids.length * 0.05, 0.8),
      );
      created++;
    }
  }
  return created;
}

function isError(obs: Observation): boolean {
  return /\b(error|Error|ERROR|FAIL|fail|exception|Exception)\b/.test(obs.output_summary);
}

function isSuccess(obs: Observation): boolean {
  return /\b(pass|Pass|success|Success|OK|ok|fixed|resolved)\b/.test(obs.output_summary) ||
    (obs.tool_name === 'Edit' && !isError(obs));
}

function shareTarget(a: Observation, b: Observation): boolean {
  const filesA = extractFiles(a.input_summary);
  const filesB = extractFiles(b.input_summary);
  return filesA.some(f => filesB.includes(f));
}

function extractErrorSignature(output: string): string {
  // Try to extract the first error line
  const match = output.match(/(?:error|Error|ERROR|FAIL)[:\s].{0,100}/);
  return match ? match[0].slice(0, 100) : output.slice(0, 80);
}

function extractFiles(input: string): string[] {
  const matches = input.match(/[\w./\-]+\.\w{1,8}/g);
  return matches ? [...new Set(matches)] : [];
}
