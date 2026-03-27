#!/usr/bin/env node
/**
 * PreCompact hook — extract semantic content from conversation BEFORE compaction.
 *
 * This is the critical moment: the full conversation transcript is about to be
 * compressed. Tool-use hooks capture the hands (what was typed/edited/committed).
 * This hook captures the mind (what was discussed, realized, decided, connected).
 *
 * Reads the transcript JSONL, extracts user prompts and assistant responses,
 * scores them on semantic salience, and stores high-value turns as Tier 1
 * observations with kind='conversation'.
 *
 * Must complete in <10 seconds — reads local file, no LLM calls.
 */

import { readFileSync } from 'node:fs';
import { EngramMemory } from '../../src/memory.js';
import { getDbPath } from '../../src/db.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { membotStore } from '../../src/membot-bridge.js';

// Patterns indicating semantic content worth preserving
const INSIGHT_PATTERNS = /\b(principle|insight|reali[zs]e|discover|the key|fundamental|axiom|breakthrough|novel|reframe|connection between|maps to|implies|therefore|this means|the real)\b/i;
const CONCEPT_PATTERNS = /\b(reification|synthon|attractor|MRH|T3|V3|LCT|ATP|trust tensor|consciousness|coherence|emergence|federation|governance|salience|witness|posture|metabolic|fractal)\b/;
const DECISION_PATTERNS = /\b(let's|we should|the fix|the approach|going forward|the plan|decided|choosing|commit to|priority)\b/i;
const QUESTION_PATTERNS = /\b(why does|how do we|what if|what makes|the question is|worth exploring|open question)\b/i;
const ANALOGY_PATTERNS = /\b(like a|analogous to|same as|maps to|equivalent of|think of it as|just as|the way)\b/i;
const IDENTITY_PATTERNS = /\b(you are|i am|we are|this is who|the nature of|what it means to|affordance|cognitive autonomy|self-actuali[zs])\b/i;

// Patterns indicating low-value content (procedural, not semantic)
const PROCEDURAL_PATTERNS = /^(ok|done|yes|no|good|thanks|cool|got it|sounds good|let's do it|perfect|nice|awesome)\s*[.!]?\s*$/i;
const TOOL_OUTPUT_PATTERNS = /^\s*\[?(Bash|Edit|Write|Read|Grep|Glob|Agent)\]?\s/;
const GIT_PATTERNS = /^(commit|push|pull|merge|rebase|diff|status|log)\b/i;

interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  ts?: string;
}

function parseTranscript(transcriptPath: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Claude Code transcript format: each line is a message
        if (entry.type === 'human' || entry.role === 'user') {
          const content = extractTextContent(entry);
          if (content && content.length > 20) {
            turns.push({ role: 'user', content, ts: entry.timestamp || entry.ts });
          }
        } else if (entry.type === 'assistant' || entry.role === 'assistant') {
          const content = extractTextContent(entry);
          if (content && content.length > 50) {
            turns.push({ role: 'assistant', content, ts: entry.timestamp || entry.ts });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Transcript not readable
  }
  return turns;
}

function extractTextContent(entry: any): string {
  // Handle various transcript formats
  if (typeof entry.content === 'string') return entry.content;
  if (Array.isArray(entry.content)) {
    return entry.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('\n');
  }
  if (entry.message?.content) return extractTextContent(entry.message);
  if (entry.text) return entry.text;
  return '';
}

function scoreConversationTurn(content: string, role: 'user' | 'assistant'): number {
  // Skip short procedural messages
  if (content.length < 30) return 0;
  if (PROCEDURAL_PATTERNS.test(content)) return 0;
  if (TOOL_OUTPUT_PATTERNS.test(content)) return 0;

  let score = 0;

  // Base score by length (longer = more likely substantive, but with diminishing returns)
  const lengthScore = Math.min(content.length / 500, 0.3);
  score += lengthScore;

  // Insight language
  const insightMatches = content.match(INSIGHT_PATTERNS);
  if (insightMatches) score += Math.min(insightMatches.length * 0.15, 0.4);

  // Domain concepts
  const conceptMatches = content.match(CONCEPT_PATTERNS);
  if (conceptMatches) score += Math.min(conceptMatches.length * 0.1, 0.3);

  // Decision language
  if (DECISION_PATTERNS.test(content)) score += 0.2;

  // Questions (especially deep ones)
  if (QUESTION_PATTERNS.test(content)) score += 0.15;

  // Analogies and connections
  if (ANALOGY_PATTERNS.test(content)) score += 0.2;

  // Identity/meta observations
  if (IDENTITY_PATTERNS.test(content)) score += 0.25;

  // User messages that are short but directive get a boost
  // (dp's reframes are often one sentence that changes everything)
  if (role === 'user' && content.length < 200 && (INSIGHT_PATTERNS.test(content) || DECISION_PATTERNS.test(content))) {
    score += 0.2;
  }

  // Assistant messages with principle/conclusion formatting
  if (role === 'assistant' && /\*\*.*\*\*/.test(content)) score += 0.1;

  return Math.min(score, 1.0);
}

function summarizeForStorage(content: string, maxLen: number = 500): string {
  // Keep first maxLen chars, try to break at sentence boundary
  if (content.length <= maxLen) return content;
  const truncated = content.slice(0, maxLen);
  const lastSentence = truncated.lastIndexOf('. ');
  if (lastSentence > maxLen * 0.5) return truncated.slice(0, lastSentence + 1);
  return truncated + '...';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const data = JSON.parse(input || '{}');
    const transcriptPath = data.transcript_path;
    const sessionId = data.session_id || process.env.SESSION_ID || 'compact';
    const projectRoot = resolveProjectRoot(data.cwd || process.cwd());

    if (!transcriptPath) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const turns = parseTranscript(transcriptPath);
    if (turns.length === 0) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const memory = new EngramMemory(getDbPath(projectRoot));
    memory.initSession(sessionId);

    const CONVERSATION_THRESHOLD = 0.3; // Higher than tool-use threshold (0.1)
    let captured = 0;

    for (const turn of turns) {
      const score = scoreConversationTurn(turn.content, turn.role);

      if (score >= CONVERSATION_THRESHOLD) {
        const summary = summarizeForStorage(turn.content);
        const roleLabel = turn.role === 'user' ? 'Human' : 'Claude';
        const taggedSummary = `[${roleLabel}] ${summary}`;

        // Store as observation with tool_name='Conversation'
        // Use the semantic score across SNARC dimensions heuristically
        memory.capture(
          'Conversation',
          taggedSummary,
          '', // no "output" for conversation turns
          data.cwd || process.cwd(),
        );

        // EXPERIMENT: dual-write to membot for embedding-based retrieval
        // Fire-and-forget — don't block on membot availability
        membotStore(taggedSummary, 'conversation').catch(() => {});

        captured++;
      }
    }

    memory.close();

    if (captured > 0) {
      process.stderr.write(`[snarc] Pre-compact: captured ${captured}/${turns.length} conversation turns\n`);
    }
  } catch (e) {
    // Silent failure — never block compaction
  }

  process.stdout.write(JSON.stringify({ continue: true }));
}

main();
