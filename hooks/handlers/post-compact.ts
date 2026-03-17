#!/usr/bin/env node
/**
 * PostCompact hook — consolidate + re-inject after context compaction.
 *
 * Compaction means the session has been long enough to fill the context
 * window — that's exactly when there are the most observations worth
 * consolidating. So we run the heuristic dream cycle here too, THEN
 * re-inject the (now-enriched) briefing.
 *
 * Deep dream is NOT run here — it's too slow for a compaction hook.
 * Heuristic consolidation is <100ms.
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
    const data = JSON.parse(input || '{}');
    const sessionId = data.session_id || process.env.SESSION_ID || 'compact';
    const projectRoot = resolveProjectRoot(data.cwd || process.cwd());

    const memory = new EngramMemory(getDbPath(projectRoot));
    memory.initSession(sessionId);

    // Run heuristic dream cycle — consolidate what we've seen so far
    const result = memory.endSession();

    // Re-inject the briefing (now includes any freshly consolidated patterns)
    const briefing = memory.getSessionBriefing();
    memory.close();

    if (briefing) {
      const parts = [];
      if (result.patternsCreated > 0) parts.push(`${result.patternsCreated} patterns consolidated`);

      const contextLines = [];
      if (parts.length > 0) contextLines.push(`[engram mid-session dream: ${parts.join(', ')}]`);
      contextLines.push(briefing);

      const output = JSON.stringify({
        additionalContext: `<engram-context>\n${contextLines.join('\n')}\n</engram-context>`,
      });
      process.stdout.write(output);
    }
  } catch (e) {
    // Silent failure
  }
}

main();
