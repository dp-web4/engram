#!/usr/bin/env node
/**
 * SessionStart hook — initialize engram and inject relevant context.
 *
 * Plain text to stdout goes directly into Claude's context.
 * This is how engram surfaces past observations without being asked.
 */

import { EngramMemory } from '../../src/memory.js';
import { getDbPath } from '../../src/db.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { randomUUID } from 'node:crypto';

const sessionId = process.env.SESSION_ID || randomUUID().slice(0, 8);
const cwd = process.cwd();
const projectRoot = resolveProjectRoot(cwd);

try {
  const memory = new EngramMemory(getDbPath(projectRoot));
  memory.initSession(sessionId, projectRoot);

  // Generate session briefing from past memories
  const briefing = memory.getSessionBriefing(projectRoot);

  memory.close();

  // Inject into Claude's context (plain text to stdout on SessionStart)
  if (briefing) {
    process.stdout.write(`<engram-context>\n${briefing}\n</engram-context>\n`);
  }
} catch (e) {
  // Silent failure — engram should never block Claude Code
}
