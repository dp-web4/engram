#!/usr/bin/env node
/**
 * Engram CLI
 *
 * Usage:
 *   engram stats          — memory health dashboard
 *   snarc search <query> — search across all tiers
 *   snarc patterns       — list consolidated patterns
 *   snarc export         — dump Tier 2+3 to markdown (stdout)
 *   snarc dream          — trigger manual consolidation
 */

import { EngramMemory } from './memory.js';
import { exportMarkdown } from './export.js';
import { getDbPath } from './db.js';
import { deepConsolidate } from './deep-consolidation.js';

const cmd = process.argv[2];
const args = process.argv.slice(3);

const memory = new EngramMemory();

async function main() {
  switch (cmd) {
    case 'stats': {
      const stats = memory.getStats();
      const identity = memory.getIdentity();
      console.log('=== SNARC Memory ===');
      console.log(`Project:               ${process.cwd()}`);
      console.log(`Database:              ${getDbPath()}`);
      console.log(`Observations (Tier 1): ${stats.observations}`);
      console.log(`Patterns (Tier 2):     ${stats.patterns}`);
      console.log(`Identity (Tier 3):     ${stats.identityFacts}`);
      console.log(`Buffer (Tier 0):       ${stats.bufferSize}/50`);
      console.log(`Seen tokens:           ${stats.seenTokens}`);
      console.log(`Sessions:              ${stats.sessions}`);
      console.log(`Avg salience:          ${stats.avgSalience?.toFixed(3) || 'n/a'}`);
      console.log(`Last observation:      ${stats.lastObservation || 'none'}`);
      if (identity.length > 0) {
        console.log('\n--- Identity ---');
        for (const i of identity) {
          console.log(`  ${i.key}: ${i.value} (${i.confidence.toFixed(2)})`);
        }
      }
      break;
    }

    case 'search': {
      const query = args.join(' ');
      if (!query) { console.error('Usage: engram search <query>'); process.exit(1); }
      const results = memory.search(query, 20);
      if (results.length === 0) { console.log('No memories found.'); break; }
      for (const r of results) {
        console.log(`[Tier ${r.tier}${r.kind ? ` ${r.kind}` : ''}] ${r.summary}${r.salience ? ` (${r.salience.toFixed(3)})` : ''}`);
      }
      break;
    }

    case 'patterns': {
      const kind = args[0];
      const patterns = memory.getPatterns(kind);
      if (patterns.length === 0) { console.log('No patterns yet. Patterns are extracted during dream cycles.'); break; }
      for (const p of patterns) {
        console.log(`[${p.kind}] ${p.summary} (freq: ${p.frequency}, conf: ${p.confidence.toFixed(2)})`);
      }
      break;
    }

    case 'export': {
      console.log(exportMarkdown(memory));
      break;
    }

    case 'config': {
      const key = args[0];
      const value = args[1];

      if (!key) {
        // Show all settings
        const autoPromoteDb = memory.getSetting('auto_promote_identity') || '0';
        const autoPromoteEnv = process.env.SNARC_AUTO_PROMOTE === '1';
        const autoPromoteEffective = autoPromoteDb === '1' || autoPromoteEnv;
        console.log('=== SNARC Settings ===');
        console.log(`auto_promote_identity: ${autoPromoteEffective ? 'ON (dangerous)' : 'OFF (default, quarantine)'}${autoPromoteEnv ? ' [via SNARC_AUTO_PROMOTE env]' : ''}`);
        console.log('\nUsage: snarc config <key> <value>');
        console.log('  snarc config auto_promote_identity 1   # per-project DB setting');
        console.log('  snarc config auto_promote_identity 0   # back to quarantine');
        console.log('  export SNARC_AUTO_PROMOTE=1             # env var (all projects)');
        break;
      }

      if (key === 'auto_promote_identity') {
        if (value === '1') {
          memory.setSetting('auto_promote_identity', '1');
          console.log('auto_promote_identity: ON — deep dream identity facts will auto-promote to Tier 3.');
          console.log('This is dangerous. Deep dream can produce convincing but wrong identity facts.');
        } else {
          memory.setSetting('auto_promote_identity', '0');
          console.log('auto_promote_identity: OFF — identity facts quarantined for human review.');
        }
      } else {
        console.error(`Unknown setting: ${key}`);
      }
      break;
    }

    case 'review': {
      const proposals = memory.getProposedIdentity();
      if (proposals.length === 0) {
        console.log('No proposed identity facts to review.');
        break;
      }
      console.log(`${proposals.length} proposed identity fact(s) from deep dream:\n`);
      for (const p of proposals) {
        const summary = p.summary.replace(/^\[proposed\]\s*/, '');
        console.log(`  #${p.id} (confidence: ${p.confidence.toFixed(2)})`);
        console.log(`    ${summary}`);
        if (p.detail) console.log(`    ${p.detail}`);
        console.log();
      }
      console.log('To promote:  snarc promote <id> "<key>" "<value>"');
      console.log('To reject:   snarc reject <id>');
      break;
    }

    case 'promote': {
      const id = parseInt(args[0]);
      const key = args[1];
      const value = args.slice(2).join(' ');
      if (!id || !key || !value) {
        console.error('Usage: engram promote <id> "<key>" "<value>"');
        console.error('Example: engram promote 42 "test_framework" "Jest"');
        process.exit(1);
      }
      memory.promoteIdentity(id, key, value);
      console.log(`Promoted to Tier 3: ${key} = ${value} (source: human-confirmed)`);
      break;
    }

    case 'reject': {
      const id = parseInt(args[0]);
      if (!id) {
        console.error('Usage: engram reject <id>');
        process.exit(1);
      }
      memory.rejectIdentity(id);
      console.log(`Rejected and removed proposal #${id}`);
      break;
    }

    case 'dream': {
      const deep = args.includes('--deep');
      const sessionId = args.find(a => !a.startsWith('-')) || 'manual-dream';

      if (deep) {
        const autoPromote = memory.getSetting('auto_promote_identity') === '1'
          || process.env.SNARC_AUTO_PROMOTE === '1';
        console.log(`Running deep dream cycle (LLM-powered)${autoPromote ? ' [auto-promote ON]' : ''}...`);
        const obs = memory.getContext(undefined, undefined, 50);
        const stmts = (memory as any).stmts;
        const result = await deepConsolidate(stmts, obs, autoPromote);
        const parts = [];
        if (result.patternsCreated > 0) parts.push(`${result.patternsCreated} patterns`);
        if (result.proposedIdentity > 0) parts.push(`${result.proposedIdentity} proposed identity (quarantined)`);
        if (result.autoPromoted > 0) parts.push(`${result.autoPromoted} identity auto-promoted to Tier 3`);
        console.log(`Deep dream complete: ${parts.join(', ') || 'nothing extracted'}`);
      } else {
        memory.initSession(sessionId);
        const result = memory.endSession();
        console.log(`Dream cycle complete: ${result.patternsCreated} patterns created, ${result.patternsDecayed} decayed, ${result.patternsPruned} pruned`);
      }
      break;
    }

    default:
      console.log(`snarc — salience-gated memory for Claude Code

Usage:
  snarc stats              Memory health dashboard
  snarc search <query>     Search across all tiers
  snarc patterns [kind]    List consolidated patterns
  snarc export             Export Tier 2+3 to markdown
  snarc dream [--deep]     Trigger consolidation (--deep uses LLM)
  snarc review             List quarantined identity proposals
  snarc promote <id> k v   Promote proposal to Tier 3 identity
  snarc reject <id>        Delete a quarantined proposal
  snarc config [key] [val] View/set persistent settings`);
  }
}

main().catch(console.error).finally(() => memory.close());
