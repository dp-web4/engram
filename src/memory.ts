/**
 * Memory Manager — orchestrates capture → score → store → consolidate.
 * Central coordinator wiring db, buffer, and snarc scorer.
 */

import Database from 'better-sqlite3';
import { openDatabase, prepareStatements, type Statements } from './db.js';
import { CircularBuffer, type RawObservation } from './buffer.js';
import { SNARCScorer, type SNARCScores } from './snarc.js';
import { consolidate } from './consolidation.js';

export interface CaptureResult {
  salience: number;
  stored: boolean; // true if promoted to Tier 1
  scores: SNARCScores;
}

export interface SearchResult {
  tier: number;
  id: number;
  summary: string;
  salience?: number;
  ts?: string;
  kind?: string;
}

export interface MemoryStats {
  observations: number;
  patterns: number;
  identityFacts: number;
  seenTokens: number;
  sessions: number;
  avgSalience: number | null;
  lastObservation: string | null;
  bufferSize: number;
}

export class EngramMemory {
  private db: Database.Database;
  private stmts: Statements;
  private buffer: CircularBuffer;
  private scorer: SNARCScorer;
  private sessionId: string = '';

  constructor(dbPath?: string) {
    this.db = openDatabase(dbPath);
    this.stmts = prepareStatements(this.db);
    this.buffer = new CircularBuffer(50);
    this.scorer = new SNARCScorer(this.stmts, this.buffer);
  }

  initSession(sessionId: string, cwd?: string): void {
    this.sessionId = sessionId;
    this.buffer = new CircularBuffer(50);
    this.scorer = new SNARCScorer(this.stmts, this.buffer);
    this.stmts.initSession.run(sessionId, cwd || '');
  }

  capture(toolName: string, input: string, output: string, cwd: string, exitCode?: number): CaptureResult {
    const inputSummary = summarize(input, 300);
    const outputSummary = summarize(output, 300);

    const obs: RawObservation = {
      toolName,
      inputSummary,
      outputSummary,
      cwd,
      ts: new Date().toISOString(),
      exitCode,
    };

    // Tier 0: always goes in the buffer
    this.buffer.push(obs);

    // Score with SNARC
    const scores = this.scorer.score(obs);

    // Tier 1: promote if above salience threshold
    const stored = scores.salience >= this.scorer.threshold;
    if (stored) {
      const tags = extractTags(toolName, inputSummary, outputSummary);
      this.stmts.insertObservation.run(
        this.sessionId,
        toolName,
        inputSummary,
        outputSummary,
        scores.surprise,
        scores.novelty,
        scores.arousal,
        scores.reward,
        scores.conflict,
        scores.salience,
        cwd,
        JSON.stringify(tags),
      );
    }

    return { salience: scores.salience, stored, scores };
  }

  endSession(): { patternsCreated: number } {
    // Run consolidation on this session's observations
    const sessionObs = this.stmts.getSessionObservations.all(this.sessionId) as any[];
    const result = consolidate(this.db, this.stmts, sessionObs, this.sessionId);

    // Close session record
    this.stmts.endSession.run(this.sessionId, this.sessionId);

    return result;
  }

  search(query: string, limit = 10): SearchResult[] {
    const results: SearchResult[] = [];

    try {
      // Search Tier 1 (observations)
      const obsRows = this.stmts.searchObservations.all(query, limit) as any[];
      for (const row of obsRows) {
        results.push({
          tier: 1,
          id: row.id,
          summary: `[${row.tool_name}] ${row.input_summary}`,
          salience: row.salience,
          ts: row.ts,
        });
      }
    } catch { /* FTS query syntax error — skip */ }

    try {
      // Search Tier 2 (patterns)
      const patRows = this.stmts.searchPatterns.all(query, limit) as any[];
      for (const row of patRows) {
        results.push({
          tier: 2,
          id: row.id,
          summary: row.summary,
          kind: row.kind,
        });
      }
    } catch { /* FTS query syntax error — skip */ }

    // Sort: patterns first (higher value), then by salience
    results.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier; // lower tier = higher value
      return (b.salience || 0) - (a.salience || 0);
    });

    return results.slice(0, limit);
  }

  getContext(sessionId?: string, timestamp?: string, limit = 20): any[] {
    if (sessionId) {
      return this.stmts.getSessionObservations.all(sessionId);
    }
    if (timestamp) {
      return this.stmts.getObservationContext.all(timestamp, timestamp);
    }
    return this.stmts.getRecentObservations.all(limit);
  }

  getPatterns(kind?: string): any[] {
    if (kind) {
      return this.stmts.getPatternsByKind.all(kind);
    }
    return this.stmts.getAllPatterns.all();
  }

  getIdentity(): any[] {
    return this.stmts.getAllIdentity.all();
  }

  getStats(): MemoryStats {
    const row = this.stmts.getStats.get() as any;
    return {
      observations: row.obs_count,
      patterns: row.pattern_count,
      identityFacts: row.identity_count,
      seenTokens: row.seen_count,
      sessions: row.session_count,
      avgSalience: row.avg_salience,
      lastObservation: row.last_obs,
      bufferSize: this.buffer.size,
    };
  }

  /** Get a session briefing — recent patterns and high-salience observations for a cwd */
  getSessionBriefing(cwd?: string, maxTokens = 500): string {
    const lines: string[] = [];

    // Recent patterns (Tier 2) — most valuable context
    const patterns = this.getPatterns();
    if (patterns.length > 0) {
      lines.push('Recurring patterns from past sessions:');
      for (const p of patterns.slice(0, 5)) {
        lines.push(`  - [${p.kind}] ${p.summary}`);
      }
    }

    // Recent high-salience observations (Tier 1) — last 5 sessions
    const recent = this.stmts.getRecentObservations.all(15) as any[];
    const highSalience = recent.filter((o: any) => o.salience >= 0.5);
    if (highSalience.length > 0) {
      lines.push('Recent high-salience observations:');
      for (const o of highSalience.slice(0, 5)) {
        lines.push(`  - [${o.tool_name}] ${o.input_summary.slice(0, 100)} (salience: ${o.salience.toFixed(2)})`);
      }
    }

    // Identity facts (Tier 3)
    const identity = this.getIdentity();
    if (identity.length > 0) {
      lines.push('Known project facts:');
      for (const i of identity.slice(0, 5)) {
        lines.push(`  - ${i.key}: ${i.value}`);
      }
    }

    if (lines.length === 0) return '';

    // Rough token estimate: ~1 token per 4 chars
    const full = lines.join('\n');
    if (full.length > maxTokens * 4) {
      return full.slice(0, maxTokens * 4) + '\n  ...';
    }
    return full;
  }

  /** Find observations related to a query, for reactive injection */
  findRelated(query: string, limit = 5): string {
    const results = this.search(query, limit);
    if (results.length === 0) return '';

    const lines = ['Related engram memories:'];
    for (const r of results) {
      lines.push(`  - [Tier ${r.tier}${r.kind ? ` ${r.kind}` : ''}] ${r.summary}`);
    }
    return lines.join('\n');
  }

  close(): void {
    this.db.close();
  }
}

/** Truncate and clean text for storage */
function summarize(text: string, maxLen: number): string {
  if (!text) return '';
  // For objects, stringify first
  if (typeof text === 'object') text = JSON.stringify(text);
  // Strip ANSI escape codes
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/** Extract tags from tool usage for search */
function extractTags(toolName: string, input: string, output: string): string[] {
  const tags = [toolName.toLowerCase()];

  // File extensions
  const exts = input.match(/\.([a-z]{1,8})\b/gi);
  if (exts) tags.push(...exts.map(e => e.toLowerCase()));

  // Error tag
  if (/error|fail|exception/i.test(output)) tags.push('error');
  if (/pass|success|ok/i.test(output)) tags.push('success');

  // Git operations
  if (/git\s+(commit|push|pull|merge)/i.test(input)) tags.push('git');

  // Test operations
  if (/test|spec|jest|pytest|vitest/i.test(input)) tags.push('test');

  return [...new Set(tags)];
}
