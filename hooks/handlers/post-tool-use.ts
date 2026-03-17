#!/usr/bin/env node
/**
 * PostToolUse hook — capture tool observation, score with SNARC, store if salient.
 * Must complete in <5 seconds. No LLM calls.
 */

import { EngramMemory } from '../../src/memory.js';
import { getDbPath } from '../../src/db.js';
import { resolveProjectRoot } from '../lib/project-root.js';

async function main() {
  // Read hook input from stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName || 'unknown';
    const toolInput = typeof data.tool_input === 'string'
      ? data.tool_input
      : JSON.stringify(data.tool_input || '');
    const toolOutput = typeof data.tool_result === 'string'
      ? data.tool_result
      : JSON.stringify(data.tool_result || '');
    const cwd = data.cwd || process.cwd();
    const sessionId = data.session_id || process.env.SESSION_ID || 'unknown';

    // Resolve project root — don't let subdirectory cwd split the DB
    const projectRoot = resolveProjectRoot(cwd);

    const memory = new EngramMemory(getDbPath(projectRoot));
    memory.initSession(sessionId, projectRoot);
    memory.capture(toolName, toolInput, toolOutput, cwd);
    memory.close();
  } catch (e) {
    // Silent failure — never block Claude Code
  }

  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

main();
