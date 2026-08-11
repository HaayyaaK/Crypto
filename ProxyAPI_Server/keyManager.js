/**
 * keyManager.js — API-Key Rotation Engine
 *
 * Features:
 *  - Round-robin rotation across N keys per provider.
 *  - Per-key sliding-window rate-limit tracking.
 *  - Automatic cooldown when a key hits its rate limit.
 *  - Cooldown back-off (1x → 2x → 4x the rate-limit window) on repeat offences.
 *  - Health scoring: keys that consistently succeed rise in priority.
 *  - Thread-safe by design (single-threaded Node.js, no mutex needed).
 *
 * Usage:
 *   const km = new KeyManager({
 *     keys: ['key-a', 'key-b', 'key-c'],
 *     headerName: 'X-CMC_PRO_API_KEY',
 *     rateLimitPerKey: 30,       // calls per window
 *     rateLimitWindowMs: 60000,  // 1-minute window
 *   });
 *   const { key, headers } = km.getNextKey();
 *   // later:
 *   km.recordSuccess(key);
 *   km.recordFailure(key, 429);   // rate-limited
 */

'use strict';

class KeyManager {
  /**
   * @param {object} opts
   * @param {string[]}  opts.keys             - Array of raw API key strings.
   * @param {string}    [opts.headerName]     - HTTP header to attach the key to.
   * @param {string}    [opts.queryParam]     - Alternatively, query-param name for the key.
   * @param {number}    opts.rateLimitPerKey  - Max calls per key in the window.
   * @param {number}    [opts.rateLimitWindowMs=60000] - Sliding window duration.
   */
  constructor(opts) {
    if (!opts.keys || opts.keys.length === 0) {
      throw new Error('KeyManager requires at least one key.');
    }
    this.headerName = opts.headerName || null;
    this.queryParam = opts.queryParam || null;
    this.rateLimitPerKey = opts.rateLimitPerKey || 30;
    this.rateLimitWindowMs = opts.rateLimitWindowMs || 60_000;

    // Build per-key state
    this._keys = opts.keys.map((raw, idx) => ({
      raw,
      idx,
      // Sliding-window call timestamps
      callLog: [],
      // Cooldown state
      cooldownUntil: 0,          // epoch ms — key is skipped until this time
      cooldownMultiplier: 1,     // doubles on each successive rate-limit hit
      consecutive429s: 0,
      // Health scoring (higher = preferred)
      successCount: 0,
      failCount: 0,
      totalLatencyMs: 0,
      requestCount: 0,
    }));

    // Round-robin pointer (index into this._keys)
    this._rrIdx = 0;
  }

  /**
   * Returns the next available key, attaching it to the correct header or query param.
   * If all keys are in cooldown, returns the one that cools down soonest.
   *
   * @returns {{ key: string, headers: object, queryParam: object|null, keyIndex: number, waitForMs: number }}
   */
  getNextKey() {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindowMs;

    // Prune old call-log entries across all keys
    for (const ks of this._keys) {
      while (ks.callLog.length > 0 && ks.callLog[0] < windowStart) {
        ks.callLog.shift();
      }
    }

    // Find keys that are NOT in cooldown and NOT at capacity
    const available = this._keys.filter(ks => {
      if (now < ks.cooldownUntil) return false;
      if (ks.callLog.length >= this.rateLimitPerKey) return false;
      return true;
    });

    if (available.length > 0) {
      // Pick the one with the best health score, breaking ties with round-robin
      available.sort((a, b) => {
        const scoreA = this._healthScore(a);
        const scoreB = this._healthScore(b);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return a.idx - b.idx;
      });

      // Advance round-robin past the chosen key
      const chosen = available[0];
      this._rrIdx = (chosen.idx + 1) % this._keys.length;
      return this._buildResult(chosen, now);
    }

    // All keys exhausted — pick the one that cools down soonest
    const soonest = this._keys.reduce((best, ks) => {
      const wait = Math.max(0, ks.cooldownUntil - now);
      const bestWait = Math.max(0, best.cooldownUntil - now);
      // If key is window-limited (not cooldown-limited), wait for oldest call to expire
      const windowWait = ks.callLog.length > 0
        ? Math.max(0, ks.callLog[0] + this.rateLimitWindowMs - now)
        : 0;
      const effectiveWait = Math.max(wait, windowWait);
      const bestEffectiveWait = best.cooldownUntil > now
        ? bestWait
        : (best.callLog.length > 0 ? Math.max(0, best.callLog[0] + this.rateLimitWindowMs - now) : Infinity);
      return effectiveWait < bestEffectiveWait ? ks : best;
    });

    const waitForMs = Math.max(0, soonest.cooldownUntil - now);
    return this._buildResult(soonest, now, waitForMs);
  }

  /**
   * Record a successful call for the given key.
   * @param {string} key
   * @param {number} [latencyMs]
   */
  recordSuccess(key, latencyMs = 0) {
    const ks = this._find(key);
    if (!ks) return;
    ks.callLog.push(Date.now());
    ks.successCount++;
    ks.requestCount++;
    ks.totalLatencyMs += latencyMs;
    // Reset consecutive 429 counter on success
    ks.consecutive429s = 0;
  }

  /**
   * Record a failed call.
   * @param {string} key
   * @param {number} [statusCode] - HTTP status; 429 triggers cooldown.
   */
  recordFailure(key, statusCode) {
    const ks = this._find(key);
    if (!ks) return;
    ks.failCount++;
    ks.requestCount++;

    if (statusCode === 429) {
      ks.consecutive429s++;
      // Back-off cooldown: 1x → 2x → 4x the rate-limit window, capped at 10 min
      ks.cooldownMultiplier = Math.min(ks.cooldownMultiplier * 2, 10);
      const cooldownMs = this.rateLimitWindowMs * ks.cooldownMultiplier;
      ks.cooldownUntil = Date.now() + cooldownMs;
    }
  }

  /**
   * Get a snapshot of key health for monitoring / health endpoints.
   * @returns {Array}
   */
  getHealth() {
    const now = Date.now();
    return this._keys.map(ks => {
      const avgLatency = ks.requestCount > 0 ? Math.round(ks.totalLatencyMs / ks.requestCount) : 0;
      const windowStart = now - this.rateLimitWindowMs;
      const recentCalls = ks.callLog.filter(t => t >= windowStart).length;
      return {
        keyIndex: ks.idx,
        keyPreview: ks.raw.slice(0, 8) + '...',
        inCooldown: now < ks.cooldownUntil,
        cooldownUntil: ks.cooldownUntil,
        cooldownMs: Math.max(0, ks.cooldownUntil - now),
        callsInWindow: recentCalls,
        callsRemaining: Math.max(0, this.rateLimitPerKey - recentCalls),
        successCount: ks.successCount,
        failCount: ks.failCount,
        avgLatencyMs: avgLatency,
        healthScore: this._healthScore(ks),
      };
    });
  }

  // ---- Private helpers ----

  _find(key) {
    return this._keys.find(ks => ks.raw === key) || null;
  }

  _healthScore(ks) {
    if (ks.requestCount === 0) return 50; // neutral for unused keys
    const successRate = ks.successCount / ks.requestCount;
    const avgLatency = ks.totalLatencyMs / ks.requestCount;
    // Latency penalty: +10 for <500ms, 0 for 500-2000ms, -20 for >2000ms
    const latencyBonus = avgLatency < 500 ? 10 : avgLatency < 2000 ? 0 : -20;
    // Cooldown penalty
    const cooldownPenalty = Date.now() < ks.cooldownUntil ? -30 : 0;
    return Math.round(successRate * 80 + latencyBonus + cooldownPenalty);
  }

  _buildResult(ks, now, waitForMs = 0) {
    const result = {
      key: ks.raw,
      headers: {},
      queryParam: null,
      keyIndex: ks.idx,
      waitForMs,
    };
    if (this.headerName) {
      result.headers[this.headerName] = ks.raw;
    }
    if (this.queryParam) {
      result.queryParam = { [this.queryParam]: ks.raw };
    }
    return result;
  }
}

module.exports = KeyManager;
