/**
 * server.js — Crypto Data Proxy
 *
 * Production-grade backend proxy that:
 *  1. Routes /api/v1/:provider/ticker and /api/v1/:provider/ohlcv requests.
 *  2. Injects API keys via the KeyManager rotation engine.
 *  3. Caches responses in an LRU cache with per-type TTLs.
 *  4. Provides /health, /health/keys, and /health/providers endpoints.
 *  5. Enforces a global rate limit on the proxy itself.
 *  6. Returns normalised JSON that matches the frontend's expected format.
 *
 * Usage:
 *   cp .env.example .env   # fill in your keys
 *   npm install
 *   npm start
 *   # → http://localhost:3210/api/v1/kraken/ticker?symbol=BTC/USD
 *   # → http://localhost:3210/api/v1/coinmarketcap/ticker?symbol=BTC/USD
 *   # → http://localhost:3210/api/v1/binance/ohlcv?symbol=BTC/USD&timeframe=1h&limit=100
 *   # → http://localhost:3210/health
 *   # → http://localhost:3210/health/keys
 */

'use strict';

require('dotenv').config();

const express = require('express');
const { LRUCache } = require('lru-cache');
const winston = require('winston');
const { providers, byId } = require('./providers');

// ===================== LOGGING =====================
const logLevel = process.env.LOG_LEVEL || 'info';
const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'ISO8601' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});

// ===================== APP =====================
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3210;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===================== LRU CACHE =====================
const tickerTtl  = parseInt(process.env.CACHE_TTL_TICKER_MS, 10)    || 5_000;
const ohlcvTtl   = parseInt(process.env.CACHE_TTL_OHLCV_MS, 10)     || 15_000;
const refTtl     = parseInt(process.env.CACHE_TTL_REFERENCE_MS, 10) || 60_000;
const maxEntries = parseInt(process.env.CACHE_MAX_ENTRIES, 10)      || 2000;

const cache = new LRUCache({
  max: maxEntries,
  ttl: refTtl, // default
});

function cacheKey(provider, type, symbol, extra = '') {
  return `${provider}:${type}:${symbol}:${extra}`;
}

function getTtl(providerId, type) {
  // Reference/validation providers get longer TTL
  if (['coingecko', 'coinpaprika', 'dexscreener', 'coinmarketcap', 'coinapi'].includes(providerId)) {
    return refTtl;
  }
  return type === 'ticker' ? tickerTtl : ohlcvTtl;
}

// ===================== GLOBAL RATE LIMITER (token bucket) =====================
const GLOBAL_RPM   = parseInt(process.env.GLOBAL_RATE_LIMIT_RPM, 10)   || 600;
const GLOBAL_BURST = parseInt(process.env.GLOBAL_RATE_LIMIT_BURST, 10) || 50;
let _bucket = GLOBAL_BURST;
let _lastRefill = Date.now();

function rateLimitGuard(req, res, next) {
  const now = Date.now();
  const elapsedMs = now - _lastRefill;
  const refill = (elapsedMs / 60_000) * GLOBAL_RPM;
  _bucket = Math.min(GLOBAL_BURST, _bucket + refill);
  _lastRefill = now;
  if (_bucket < 1) {
    return res.status(429).json({
      error: 'Proxy rate limit exceeded',
      retryAfterMs: Math.ceil((1 - _bucket) / GLOBAL_RPM * 60_000),
    });
  }
  _bucket -= 1;
  next();
}

app.use(rateLimitGuard);

// ===================== VALIDATION =====================
const VALID_SYMBOLS = ['BTC/USD', 'ETH/USD'];
const VALID_TF = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

function validateRequest(req, res) {
  const { provider: pid } = req.params;
  const provider = byId[pid];
  if (!provider) {
    return res.status(404).json({ error: `Unknown provider: ${pid}. Available: ${Object.keys(byId).join(', ')}` });
  }
  if (!provider.enabled) {
    return res.status(503).json({ error: `Provider ${pid} is disabled (check .env or API keys)` });
  }
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!VALID_SYMBOLS.includes(symbol)) {
    return res.status(400).json({ error: `Invalid symbol. Supported: ${VALID_SYMBOLS.join(', ')}` });
  }
  return { provider, symbol, providerId: pid }; // null means we already responded
}

// ===================== ROUTES =====================

// --- Ticker ---
app.get('/api/v1/:provider/ticker', async (req, res) => {
  const ctx = validateRequest(req, res);
  if (!ctx) return;
  const { provider, symbol, providerId } = ctx;
  const ck = cacheKey(providerId, 'ticker', symbol);
  const cached = cache.get(ck);
  if (cached) {
    return res.json({ ...cached, _cached: true });
  }
  try {
    const data = await provider.getTicker(symbol);
    const payload = { data, _proxy: { provider: providerId, ts: Date.now() } };
    cache.set(ck, payload, { ttl: getTtl(providerId, 'ticker') });
    res.json(payload);
  } catch (err) {
    logger.warn(`[TICKER] ${providerId} ${symbol}: ${err.message}`);
    res.status(502).json({ error: err.message, provider: providerId });
  }
});

// --- OHLCV ---
app.get('/api/v1/:provider/ohlcv', async (req, res) => {
  const ctx = validateRequest(req, res);
  if (!ctx) return;
  const { provider, symbol, providerId } = ctx;
  const tf = (req.query.timeframe || '1h').toLowerCase();
  if (!VALID_TF.includes(tf)) {
    return res.status(400).json({ error: `Invalid timeframe. Supported: ${VALID_TF.join(', ')}` });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
  const ck = cacheKey(providerId, 'ohlcv', symbol, `${tf}:${limit}`);
  const cached = cache.get(ck);
  if (cached) {
    return res.json({ ...cached, _cached: true });
  }
  try {
    const data = await provider.getOHLCV(symbol, tf, limit);
    const payload = { data, _proxy: { provider: providerId, tf, count: data.length, ts: Date.now() } };
    cache.set(ck, payload, { ttl: getTtl(providerId, 'ohlcv') });
    res.json(payload);
  } catch (err) {
    logger.warn(`[OHLCV] ${providerId} ${symbol} ${tf}: ${err.message}`);
    res.status(502).json({ error: err.message, provider: providerId });
  }
});

// --- Aggregated Ticker (best canonical + validation consensus) ---
app.get('/api/v1/aggregated/ticker', async (req, res) => {
  const symbol = (req.query.symbol || 'BTC/USD').toUpperCase();
  if (!VALID_SYMBOLS.includes(symbol)) {
    return res.status(400).json({ error: `Invalid symbol. Supported: ${VALID_SYMBOLS.join(', ')}` });
  }

  const results = [];
  const errors = [];

  // Fire all enabled providers in parallel
  const promises = providers
    .filter(p => p.enabled)
    .map(async (p) => {
      try {
        const data = await p.getTicker(symbol);
        results.push({ provider: p.id, role: p.role, data });
      } catch (err) {
        errors.push({ provider: p.id, error: err.message });
      }
    });

  await Promise.allSettled(promises);

  // Compute consensus price from non-null results
  const prices = results.filter(r => r.data.price != null && !isNaN(r.data.price));
  const avgPrice = prices.length > 0
    ? prices.reduce((s, r) => s + r.data.price, 0) / prices.length
    : null;
  const deviation = avgPrice !== null
    ? prices.map(r => Math.abs(r.data.price - avgPrice) / avgPrice * 100)
    : [];
  const maxDeviation = deviation.length > 0 ? Math.max(...deviation) : 0;

  res.json({
    symbol,
    timestamp: Date.now(),
    consensus: { avgPrice, sourceCount: prices.length, maxDeviationPct: Math.round(maxDeviation * 100) / 100 },
    sources: results,
    errors,
  });
});

// ===================== HEALTH ENDPOINTS =====================

app.get('/health', (req, res) => {
  const statuses = providers.map(p => p.getStatus());
  const live = statuses.filter(s => s.status === 'LIVE' || s.status === 'HEALTHY').length;
  const total = statuses.filter(s => s.status !== 'DISABLED').length;
  res.json({
    service: 'crypto-data-proxy',
    uptime: process.uptime(),
    providers: { live, total, degraded: total - live },
    cache: { size: cache.size, max: maxEntries },
    rateLimit: { bucketRemaining: Math.round(_bucket) },
    providersDetail: statuses,
  });
});

app.get('/health/keys', (req, res) => {
  const keyHealth = {};
  for (const p of providers) {
    if (p.keyManager) {
      keyHealth[p.id] = p.keyManager.getHealth();
    }
  }
  if (Object.keys(keyHealth).length === 0) {
    return res.json({ message: 'No providers with key rotation configured.' });
  }
  res.json(keyHealth);
});

app.get('/health/providers', (req, res) => {
  res.json(providers.map(p => p.getStatus()));
});

// ===================== START =====================

app.listen(PORT, () => {
  logger.info(`Crypto Data Proxy listening on port ${PORT}`);
  const enabledList = providers.filter(p => p.enabled).map(p => `${p.id} (${p.role})`).join(', ');
  const disabledList = providers.filter(p => !p.enabled).map(p => `${p.id} (missing keys?)`).join(', ');
  logger.info(`Enabled:  ${enabledList || 'none'}`);
  if (disabledList) logger.warn(`Disabled: ${disabledList}`);
});

module.exports = app;
