/**
 * _base.js — Base Provider Adapter
 *
 * Every provider extends this class. It provides:
 *  - Circuit-breaker (open / half-open / closed states)
 *  - Latency tracking & error counters
 *  - Standardised upstream fetch with timeout
 *  - Normalised OHLCV & ticker response format
 */

'use strict';

class BaseProvider {
  /**
   * @param {string} id         - Unique provider id (e.g. 'kraken')
   * @param {string} name       - Human-readable name
   * @param {string} role       - canonical | fallback | validation | reference | context
   * @param {object} opts
   * @param {string}  opts.baseUrl
   * @param {number}  [opts.timeoutMs=8000]
   * @param {boolean} [opts.requiresAuth=false]
   */
  constructor(id, name, role, opts) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs || 8_000;
    this.requiresAuth = opts.requiresAuth || false;
    this.enabled = opts.enabled !== false;

    // Circuit-breaker state
    this._cbState = 'CLOSED';          // CLOSED | OPEN | HALF_OPEN
    this._cbFailures = 0;
    this._cbLastFailure = 0;
    this._cbHalfOpenProbes = 0;

    // Metrics
    this._successCount = 0;
    this._failCount = 0;
    this._lastLatencyMs = 0;
    this._avgLatencyMs = 0;
    this._lastSuccessTs = 0;
    this._lastError = null;
    this._consecutiveErrors = 0;

    // KeyManager instance (set externally if provider needs key rotation)
    this.keyManager = null;
  }

  // ---- Abstract methods (override in subclass) ----

  /**
   * Fetch normalised OHLCV candles.
   * @param {string} symbol   - e.g. 'BTC/USD'
   * @param {string} tf       - e.g. '1h', '1d'
   * @param {number} [limit]
   * @returns {Promise<Array<{timestamp,open,high,low,close,volume}>>}
   */
  async getOHLCV(symbol, tf, limit = 300) {
    throw new Error(`getOHLCV not implemented for ${this.id}`);
  }

  /**
   * Fetch normalised ticker.
   * @param {string} symbol
   * @returns {Promise<{symbol,price,bid,ask,high24h,low24h,volume24h,change24hPct,timestamp,source}>}
   */
  async getTicker(symbol) {
    throw new Error(`getTicker not implemented for ${this.id}`);
  }

  // ---- Core fetch with circuit-breaker ----

  /**
   * Perform upstream HTTP request with circuit-breaker, timeout, and optional auth headers.
   * @param {string} path     - URL path (appended to baseUrl)
   * @param {object} [opts]
   * @param {object} [opts.query]  - Query params object
   * @param {object} [opts.extraHeaders]
   * @returns {Promise<{data: any, latencyMs: number, statusCode: number}>}
   */
  async _upstreamFetch(path, opts = {}) {
    // Circuit-breaker guard
    if (this._cbState === 'OPEN') {
      const elapsed = Date.now() - this._cbLastFailure;
      const resetMs = parseInt(process.env.CB_RESET_TIMEOUT_MS, 10) || 30_000;
      if (elapsed < resetMs) {
        throw new Error(`[CB-OPEN] ${this.id}: circuit breaker open, retry after ${resetMs - elapsed}ms`);
      }
      // Transition to HALF_OPEN
      this._cbState = 'HALF_OPEN';
      this._cbHalfOpenProbes = 0;
    }

    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;
    const halfOpenMax = parseInt(process.env.CB_HALF_OPEN_MAX, 10) || 2;

    if (this._cbState === 'HALF_OPEN' && this._cbHalfOpenProbes >= halfOpenMax) {
      throw new Error(`[CB-HALF_OPEN] ${this.id}: max half-open probes reached`);
    }
    if (this._cbState === 'HALF_OPEN') {
      this._cbHalfOpenProbes++;
    }

    // Build URL
    let url = this.baseUrl + path;
    const headers = { 'Accept': 'application/json', ...opts.extraHeaders };

    // Inject API key if KeyManager is present
    if (this.keyManager) {
      const keyResult = this.keyManager.getNextKey();
      if (keyResult.waitForMs > 0) {
        throw new Error(`[KEY-EXHAUSTED] ${this.id}: all keys in cooldown, wait ${keyResult.waitForMs}ms`);
      }
      Object.assign(headers, keyResult.headers);
      // Merge query-param key if used
      if (keyResult.queryParam) {
        opts.query = { ...opts.query, ...keyResult.queryParam };
      }
    }

    // Append query string
    if (opts.query) {
      const params = new URLSearchParams(opts.query);
      url += (url.includes('?') ? '&' : '?') + params.toString();
    }

    const start = Date.now();
    let statusCode = 0;
    let data = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);

      statusCode = res.status;
      const latencyMs = Date.now() - start;

      if (!res.ok) {
        // Rate limited?
        if (statusCode === 429 && this.keyManager) {
          // Determine which key was used (from headers)
          const usedKey = Object.entries(headers).find(([, v]) => v && v.length > 8)?.[1];
          if (usedKey) this.keyManager.recordFailure(usedKey, 429);
        }
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${statusCode}: ${body.slice(0, 200)}`);
      }

      data = await res.json();

      // Record success
      this._onSuccess(latencyMs);
      if (this.keyManager) {
        const usedKey = Object.values(headers).find(v => v && v.length > 8);
        if (usedKey) this.keyManager.recordSuccess(usedKey, latencyMs);
      }

      return { data, latencyMs, statusCode };
    } catch (err) {
      const latencyMs = Date.now() - start;
      this._onError(err);
      if (this.keyManager && err.message?.includes('HTTP ')) {
        const usedKey = Object.values(headers).find(v => v && v.length > 8);
        if (usedKey) this.keyManager.recordFailure(usedKey, statusCode || 0);
      }
      throw err;
    }
  }

  // ---- Circuit breaker callbacks ----

  _onSuccess(latencyMs) {
    this._successCount++;
    this._consecutiveErrors = 0;
    this._lastLatencyMs = latencyMs;
    this._avgLatencyMs = this._avgLatencyMs === 0
      ? latencyMs
      : Math.round((this._avgLatencyMs * 0.9) + (latencyMs * 0.1)); // EMA
    this._lastSuccessTs = Date.now();
    this._lastError = null;
    // Reset circuit breaker on success in HALF_OPEN
    if (this._cbState === 'HALF_OPEN') {
      this._cbState = 'CLOSED';
      this._cbFailures = 0;
    }
  }

  _onError(err) {
    this._failCount++;
    this._consecutiveErrors++;
    this._lastError = err.message;
    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;
    this._cbFailures++;
    this._cbLastFailure = Date.now();
    if (this._cbFailures >= threshold) {
      this._cbState = 'OPEN';
    }
  }

  // ---- Health snapshot ----

  getStatus() {
    let status = 'DISABLED';
    if (!this.enabled) return { provider: this.id, status, role: this.role };
    if (this._cbState === 'OPEN') status = 'FAILED';
    else if (this._consecutiveErrors > 0 && this._lastSuccessTs === 0) status = 'FAILED';
    else if (this._lastSuccessTs === 0) status = 'IDLE';
    else if (Date.now() - this._lastSuccessTs > 60_000) status = 'STALE';
    else if (this._consecutiveErrors > 0) status = 'DEGRADED';
    else status = 'LIVE';

    return {
      provider: this.id,
      name: this.name,
      status,
      role: this.role,
      circuitBreaker: this._cbState,
      successes: this._successCount,
      failures: this._failCount,
      lastLatencyMs: this._lastLatencyMs,
      avgLatencyMs: this._avgLatencyMs,
      lastSuccessTs: this._lastSuccessTs,
      lastError: this._lastError,
      keyRotation: this.keyManager ? this.keyManager.getHealth() : null,
    };
  }
}

module.exports = BaseProvider;
