/**
 * Engram MCP Server — 4 retrieval tools for Claude Code.
 *
 * Tools:
 *   engram_search   — query across all tiers, ranked by salience
 *   engram_context  — observations around a timestamp or session
 *   engram_patterns — consolidated patterns from dream cycles
 *   engram_stats    — memory health dashboard
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EngramMemory } from './memory.js';
import { getDbPath } from './db.js';

// Determine project directory for DB path:
// 1. ENGRAM_PROJECT_DIR env var (explicit override)
// 2. CLI arg: node server.js /path/to/project
// 3. Fallback: scan ~/.engram/projects/ for most recently modified DB
//
// The hooks write to a DB keyed by the project cwd they receive from
// Claude Code. The MCP server must read the same DB.
function resolveProjectDb(): string {
  // Explicit env var
  if (process.env.ENGRAM_PROJECT_DIR) {
    return getDbPath(process.env.ENGRAM_PROJECT_DIR);
  }
  // CLI arg
  if (process.argv[2]) {
    return getDbPath(process.argv[2]);
  }
  // Scan for most recently modified DB (most likely the active project)
  try {
    const { readdirSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const { homedir } = require('node:os');
    const projectsDir = join(homedir(), '.engram', 'projects');
    const entries = readdirSync(projectsDir);
    let newest = { path: '', mtime: 0 };
    for (const entry of entries) {
      const dbPath = join(projectsDir, entry, 'engram.db');
      try {
        const stat = statSync(dbPath);
        if (stat.mtimeMs > newest.mtime) {
          newest = { path: dbPath, mtime: stat.mtimeMs };
        }
      } catch { /* no db in this dir */ }
    }
    if (newest.path) return newest.path;
  } catch { /* scan failed */ }
  // Final fallback: cwd-based
  return getDbPath();
}

const memory = new EngramMemory(resolveProjectDb());

const server = new Server(
  { name: 'engram', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'engram_search',
      description: 'Search engram memory across all tiers — observations, patterns, and identity. Results ranked by salience and tier.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (FTS5 syntax supported)' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'engram_context',
      description: 'Get observations around a specific timestamp or from a specific session. Useful for "what happened around the time of this error?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID to retrieve observations from' },
          timestamp: { type: 'string', description: 'ISO timestamp to center the context window on' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'engram_patterns',
      description: 'Retrieve consolidated patterns from dream cycles — recurring workflows, error-fix chains, concept clusters.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Optional search query to filter patterns' },
          kind: { type: 'string', description: 'Filter by kind: tool_sequence, error_fix, concept_cluster' },
        },
      },
    },
    {
      name: 'engram_stats',
      description: 'Memory health dashboard — tier sizes, salience distribution, session count, seen token count.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'engram_search': {
      const query = (args as any).query as string;
      const limit = (args as any).limit as number || 10;
      const results = memory.search(query, limit);
      return {
        content: [{
          type: 'text',
          text: results.length === 0
            ? 'No memories found.'
            : results.map(r =>
                `[Tier ${r.tier}${r.kind ? ` ${r.kind}` : ''}] ${r.summary}${r.salience ? ` (salience: ${r.salience.toFixed(3)})` : ''}${r.ts ? ` — ${r.ts}` : ''}`
              ).join('\n'),
        }],
      };
    }

    case 'engram_context': {
      const sessionId = (args as any).session_id as string | undefined;
      const timestamp = (args as any).timestamp as string | undefined;
      const limit = (args as any).limit as number || 20;
      const obs = memory.getContext(sessionId, timestamp, limit);
      return {
        content: [{
          type: 'text',
          text: obs.length === 0
            ? 'No observations found.'
            : obs.map((o: any) =>
                `${o.ts} [${o.tool_name}] ${o.input_summary} → salience: ${o.salience?.toFixed(3) || '?'}`
              ).join('\n'),
        }],
      };
    }

    case 'engram_patterns': {
      const query = (args as any).query as string | undefined;
      const kind = (args as any).kind as string | undefined;

      let patterns: any[];
      if (query) {
        patterns = memory.search(query, 20).filter(r => r.tier === 2);
      } else {
        patterns = memory.getPatterns(kind);
      }

      return {
        content: [{
          type: 'text',
          text: patterns.length === 0
            ? 'No patterns consolidated yet. Patterns are extracted during session-end dream cycles.'
            : patterns.map((p: any) =>
                `[${p.kind || 'pattern'}] ${p.summary} (frequency: ${p.frequency || '?'}, confidence: ${p.confidence?.toFixed(2) || '?'})`
              ).join('\n'),
        }],
      };
    }

    case 'engram_stats': {
      const stats = memory.getStats();
      const identity = memory.getIdentity();
      return {
        content: [{
          type: 'text',
          text: [
            '=== Engram Memory Stats ===',
            `Observations (Tier 1): ${stats.observations}`,
            `Patterns (Tier 2):     ${stats.patterns}`,
            `Identity (Tier 3):     ${stats.identityFacts}`,
            `Buffer (Tier 0):       ${stats.bufferSize}/50`,
            `Seen tokens:           ${stats.seenTokens}`,
            `Sessions:              ${stats.sessions}`,
            `Avg salience:          ${stats.avgSalience?.toFixed(3) || 'n/a'}`,
            `Last observation:      ${stats.lastObservation || 'none'}`,
            '',
            identity.length > 0 ? '--- Identity ---' : '',
            ...identity.map((i: any) => `  ${i.key}: ${i.value} (${i.confidence.toFixed(2)})`),
          ].filter(Boolean).join('\n'),
        }],
      };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
