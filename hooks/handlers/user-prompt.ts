#!/usr/bin/env node
/**
 * UserPromptSubmit hook — check if the user's prompt relates to past memories.
 *
 * Extracts keywords from the prompt, searches engram, and injects
 * related observations via the `additionalContext` JSON field.
 *
 * Only fires when there's a relevant match — most prompts pass through silently.
 * Keeps injection under ~200 tokens to avoid context bloat.
 */

import { EngramMemory } from '../../src/memory.js';
import { getDbPath } from '../../src/db.js';
import { resolveProjectRoot } from '../lib/project-root.js';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const data = JSON.parse(input);
    const prompt = data.prompt || data.message || '';

    if (!prompt || prompt.length < 10) {
      // Too short to meaningfully search — skip
      process.exit(0);
      return;
    }

    // Extract search terms: skip common words, use meaningful tokens
    const searchQuery = extractSearchTerms(prompt);
    if (!searchQuery) {
      process.exit(0);
      return;
    }

    const projectRoot = resolveProjectRoot(data.cwd || process.cwd());
    const memory = new EngramMemory(getDbPath(projectRoot));
    const related = memory.findRelated(searchQuery, 3);
    memory.close();

    if (related) {
      // Inject via additionalContext — Claude sees this as part of the conversation
      const output = JSON.stringify({ additionalContext: related });
      process.stdout.write(output);
    }
  } catch (e) {
    // Silent failure
  }

  process.exit(0);
}

/**
 * Extract meaningful search terms from a user prompt.
 * Skip common words, keep file paths, technical terms, error messages.
 */
function extractSearchTerms(prompt: string): string {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'these',
    'those', 'i', 'you', 'we', 'they', 'he', 'she', 'me', 'my', 'your',
    'and', 'or', 'but', 'not', 'no', 'yes', 'if', 'then', 'else', 'when',
    'what', 'how', 'why', 'where', 'which', 'who', 'so', 'just', 'also',
    'please', 'thanks', 'let', 'lets', "let's", 'make', 'get', 'use',
    'now', 'here', 'there', 'some', 'all', 'any', 'each', 'every',
  ]);

  const words = prompt
    .toLowerCase()
    .replace(/[^\w\s./\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Keep at most 5 terms for the FTS query
  const terms = words.slice(0, 5);
  if (terms.length === 0) return '';

  // FTS5 OR query
  return terms.join(' OR ');
}

main();
