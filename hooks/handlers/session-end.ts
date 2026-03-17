#!/usr/bin/env node
/**
 * SessionEnd hook — run consolidation (dream cycle).
 * Gets 30 seconds — enough for heuristic pattern extraction.
 */

import { EngramMemory } from '../../src/memory.js';
import { getDbPath } from '../../src/db.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { deepConsolidate } from '../../src/deep-consolidation.js';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const data = JSON.parse(input || '{}');
    const sessionId = data.session_id || process.env.SESSION_ID || 'unknown';
    const projectRoot = resolveProjectRoot(data.cwd || process.cwd());

    const memory = new EngramMemory(getDbPath(projectRoot));
    memory.initSession(sessionId);

    // Heuristic consolidation (always runs)
    const result = memory.endSession();

    const parts = [];
    if (result.patternsCreated > 0) parts.push(`${result.patternsCreated} created`);
    if (result.patternsDecayed > 0) parts.push(`${result.patternsDecayed} decayed`);
    if (result.patternsPruned > 0) parts.push(`${result.patternsPruned} pruned`);

    // Deep consolidation (LLM-powered, opt-in via env var)
    if (process.env.ENGRAM_DEEP_DREAM === '1') {
      const obs = memory.getContext(sessionId);
      if (obs.length >= 3) {
        const autoPromote = memory.getSetting('auto_promote_identity') === '1';
        const stmts = (memory as any).stmts;
        const deep = await deepConsolidate(stmts, obs, autoPromote);
        if (deep.patternsCreated > 0) parts.push(`${deep.patternsCreated} deep patterns`);
        if (deep.proposedIdentity > 0) parts.push(`${deep.proposedIdentity} proposed identity (quarantined)`);
        if (deep.autoPromoted > 0) parts.push(`${deep.autoPromoted} identity auto-promoted`);
      }
    }

    memory.close();

    if (parts.length > 0) {
      process.stderr.write(`[engram] Dream cycle: ${parts.join(', ')}\n`);
    }
  } catch (e) {
    // Silent failure
  }

  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

main();
