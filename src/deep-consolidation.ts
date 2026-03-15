/**
 * Deep Consolidation — LLM-powered dream cycle.
 *
 * Sends session observations to Claude (via `claude --print`) for
 * semantic pattern extraction. Produces higher-quality Tier 2 patterns
 * and Tier 3 identity facts than the heuristic extractors.
 *
 * Usage:
 *   engram dream --deep           # CLI
 *   ENGRAM_DEEP_DREAM=1 on Stop   # automatic (if env var set)
 *
 * Uses existing Claude Code auth — no API key needed.
 */

import { execSync } from 'node:child_process';
import type { Statements } from './db.js';

interface Observation {
  id: number;
  tool_name: string;
  input_summary: string;
  output_summary: string;
  salience: number;
  ts: string;
}

interface DeepPattern {
  kind: 'workflow' | 'error_fix' | 'insight' | 'decision' | 'identity';
  summary: string;
  detail: string;
  confidence: number;
  source_ids: number[];
}

const PROMPT_TEMPLATE = `You are a memory consolidation agent. You are reviewing observations from a coding session and extracting durable patterns.

Below are the session's observations — tool uses that scored above salience threshold. Each has a tool name, input summary, output summary, salience score, and timestamp.

Your job: extract patterns that would be useful in FUTURE sessions. Not a session log — durable knowledge.

Respond with a JSON array of patterns. Each pattern has:
- kind: "workflow" (recurring sequence), "error_fix" (problem→solution), "insight" (something learned), "decision" (architectural choice made), or "identity" (persistent project fact)
- summary: one-line description (what someone needs to know)
- detail: supporting context (2-3 sentences max)
- confidence: 0.0-1.0 (how confident are you this pattern is real and reusable?)
- source_ids: array of observation IDs that support this pattern

Rules:
- Only extract patterns you're confident about (>= 0.5)
- Prefer fewer high-quality patterns over many weak ones
- "identity" patterns become permanent project facts — be very conservative (>= 0.8 confidence)
- Do NOT include session-specific details (timestamps, exact commands) — extract the reusable knowledge
- Do NOT hallucinate patterns not supported by the observations
- If the observations don't contain meaningful patterns, return an empty array []

OBSERVATIONS:
`;

export async function deepConsolidate(
  stmts: Statements,
  observations: Observation[],
): Promise<{ patternsCreated: number; identityFacts: number }> {
  if (observations.length < 3) {
    return { patternsCreated: 0, identityFacts: 0 };
  }

  // Format observations for the prompt
  const obsText = observations.map(o =>
    `[#${o.id}] ${o.ts} | ${o.tool_name} | salience: ${o.salience.toFixed(2)}\n  input: ${o.input_summary.slice(0, 200)}\n  output: ${o.output_summary.slice(0, 200)}`
  ).join('\n\n');

  const prompt = PROMPT_TEMPLATE + obsText + '\n\nRespond with ONLY a JSON array. No markdown, no explanation.';

  // Call claude --print
  let response: string;
  try {
    response = execSync(
      `claude --print "${escapeBash(prompt)}"`,
      {
        timeout: 60_000, // 60 second timeout
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (e: any) {
    // claude CLI not available or timed out
    console.error(`[engram] Deep consolidation failed: ${e.message?.slice(0, 100)}`);
    return { patternsCreated: 0, identityFacts: 0 };
  }

  // Parse response — extract JSON array
  let patterns: DeepPattern[];
  try {
    // Handle markdown code blocks if Claude wraps the response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[engram] Deep consolidation: no JSON array in response');
      return { patternsCreated: 0, identityFacts: 0 };
    }
    patterns = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(patterns)) throw new Error('not an array');
  } catch (e) {
    console.error(`[engram] Deep consolidation: failed to parse response`);
    return { patternsCreated: 0, identityFacts: 0 };
  }

  let patternsCreated = 0;
  let identityFacts = 0;

  for (const p of patterns) {
    // Validate
    if (!p.kind || !p.summary || p.confidence === undefined) continue;
    if (p.confidence < 0.5) continue; // skip low confidence

    if (p.kind === 'identity' && p.confidence >= 0.8) {
      // Promote to Tier 3
      stmts.upsertIdentity.run(
        p.summary.split(':')[0]?.trim() || p.summary,
        p.detail || p.summary,
        'deep-dream',
        p.confidence,
      );
      identityFacts++;
    } else {
      // Tier 2 pattern
      stmts.insertPattern.run(
        `deep_${p.kind}`,
        p.summary,
        p.detail || '',
        1,
        JSON.stringify(p.source_ids || []),
        p.confidence,
      );
      patternsCreated++;
    }
  }

  return { patternsCreated, identityFacts };
}

/** Escape string for bash double-quoted context */
function escapeBash(s: string): string {
  return s.replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}
