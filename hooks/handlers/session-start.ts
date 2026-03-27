#!/usr/bin/env node
/**
 * SessionStart hook — initialize snarc and inject relevant context.
 *
 * Plain text to stdout goes directly into Claude's context.
 * This is how snarc surfaces past observations without being asked.
 *
 * EXPERIMENT: Also queries membot for semantic results alongside
 * SNARC's FTS5 keyword results. Labels source for comparison.
 */

import { EngramMemory } from '../../src/memory.js';
import { getDbPath } from '../../src/db.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { membotDualSearch, membotEnsureMounted } from '../../src/membot-bridge.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

async function main() {
  const sessionId = process.env.SESSION_ID || randomUUID().slice(0, 8);
  const cwd = process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const projectHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);

  try {
    const memory = new EngramMemory(getDbPath(projectRoot));
    memory.initSession(sessionId, projectRoot);

    // Generate session briefing from past memories (SNARC FTS5)
    const t0 = Date.now();
    const briefing = memory.getSessionBriefing(projectRoot);
    const snarcTimeMs = Date.now() - t0;

    // EXPERIMENT: try membot semantic search for comparison
    let membotSection = '';
    try {
      await membotEnsureMounted(projectHash);

      // Use recent patterns as search queries for membot
      const patterns = memory.getPatterns()
        .filter((p: any) => p.confidence >= 0.6 && p.kind !== 'proposed_identity')
        .slice(0, 3);

      if (patterns.length > 0) {
        // Search membot with the top pattern as query
        const query = patterns[0].summary || '';
        if (query.length > 10) {
          const snarcResults = patterns.map((p: any) => ({
            summary: p.summary,
            salience: p.confidence,
            tier: 2,
          }));

          const membotResults = await membotDualSearch(query, snarcResults, snarcTimeMs);

          // Only include membot results that SNARC didn't find
          const snarcSummaries = new Set(patterns.map((p: any) => (p.summary || '').toLowerCase().slice(0, 60)));
          const uniqueMembot = membotResults.filter(mr => {
            const mrKey = mr.text.toLowerCase().slice(0, 60);
            return ![...snarcSummaries].some(s => s.includes(mrKey) || mrKey.includes(s));
          });

          if (uniqueMembot.length > 0) {
            membotSection = '\nSemantic recall (embedding-based, may surface connections FTS5 misses):';
            for (const r of uniqueMembot.slice(0, 3)) {
              membotSection += `\n  - ${r.text.slice(0, 120)} (${r.score.toFixed(2)})`;
            }
          }
        }
      }
    } catch {
      // membot not available — silent fallback
    }

    memory.close();

    // Inject into Claude's context
    if (briefing || membotSection) {
      const lines = [];
      if (briefing) lines.push(briefing);
      if (membotSection) lines.push(membotSection);
      process.stdout.write(`<snarc-context>\n${lines.join('\n')}\n</snarc-context>\n`);
    }
  } catch (e) {
    // Silent failure — snarc should never block Claude Code
  }
}

main();
