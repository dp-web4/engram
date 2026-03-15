#!/usr/bin/env node
/**
 * SessionEnd hook — run consolidation (dream cycle).
 * Gets 30 seconds — enough for heuristic pattern extraction.
 */

import { EngramMemory } from '../../src/memory.js';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const data = JSON.parse(input || '{}');
    const sessionId = data.session_id || process.env.SESSION_ID || 'unknown';

    const memory = new EngramMemory();
    memory.initSession(sessionId);
    const result = memory.endSession();
    memory.close();

    const parts = [];
    if (result.patternsCreated > 0) parts.push(`${result.patternsCreated} created`);
    if (result.patternsDecayed > 0) parts.push(`${result.patternsDecayed} decayed`);
    if (result.patternsPruned > 0) parts.push(`${result.patternsPruned} pruned`);
    if (parts.length > 0) {
      process.stderr.write(`[engram] Dream cycle: ${parts.join(', ')}\n`);
    }
  } catch (e) {
    // Silent failure
  }

  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

main();
