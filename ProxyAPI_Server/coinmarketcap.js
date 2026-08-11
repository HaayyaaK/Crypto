/**
 * CoinMarketCap Provider Adapter
 *
 * Docs:     https://coinmarketcap.com/api/documentation/v1/
 * Auth:     REQUIRED — API key passed via X-CMC_PRO_API_KEY header.
 * Rate:     Basic: 10,000 calls/mo (~333/day).  Pro: 30,000+/mo.
 *          Key rotation distributes load across multiple keys.
 * Coins:    1 (BTC), 1027 (ETH)
 */

'use strict';
const BaseProvider = require('./_base');
const KeyManager = require('../keyManager');

class CoinMarketCapProvider extends BaseProvider {
  constructor() {
    const keysRaw = process.env.COINMARKETCAP_API_KEYS || '';
    const keys = keysRaw.split(',').map(k => k.trim()).filter(Boolean);
    const hasKeys = keys.length > 0;

    super('coinmarketcap', 'CoinMarketCap', 'validation', {
      baseUrl: process.env.COINMARKETCAP_BASE_URL || 'https://pro-api.coinmarketcap.com',
      timeoutMs: parseInt(process.env.COINMARKETCAP_TIMEOUT_MS, 10) || 10_000,
      requiresAuth: true,
      enabled: process.env.COINMARKETCAP_ENABLED === 'true' && hasKeys,
    });

    this.coinMap = { 'BTC/USD': '1', 'ETH/USD': '1027' };

    if (hasKeys) {
      this.keyManager = new KeyManager({
        keys,
        headerName: process.env.COINMARKETCAP_KEY_HEADER || 'X-CMC_PRO_API_KEY',
        rateLimitPerKey: parseInt(process.env.COINMARKETCAP_RATE_LIMIT_PER_KEY, 10) || 30,
        rateLimitWindowMs: 60_000,
      });
    }
  }

  async getTicker(symbol) {
    const coinId = this.coinMap[symbol];
    if (!coinId) throw new Error(`CoinMarketCap: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/v2/cryptocurrency/quotes/latest`, {
      query: { id: coinId, convert: 'USD' },
    });
    const coin = data?.data?.[coinId];
    if (!coin) throw new Error(`CoinMarketCap: no data for id ${coinId}`);
    const q = coin.quote?.USD;
    return {
      symbol,
      price: q.price,
      bid: null,
      ask: null,
      high24h: null, // not in this endpoint
      low24h: null,
      volume24h: q.volume_24h,
      change24hPct: q.percent_change_24h,
      timestamp: q.last_updated ? new Date(q.last_updated).getTime() : Date.now(),
      source: 'coinmarketcap',
      marketCap: q.market_cap,
      dominance: q.market_cap_dominance,
    };
  }

  async getOHLCV(symbol) {
    // CoinMarketCap historical OHLCV requires a Pro+ plan.
    // For Basic/Pro plans, the v1/cryptocurrency/ohlcv/latest endpoint
    // provides the latest candle only.  We raise a clear error.
    throw new Error(
      'CoinMarketCap: full OHLCV history requires Pro+ plan. ' +
      'Use /v1/cryptocurrency/ohlcv/latest for the latest candle only.'
    );
  }
}

module.exports = CoinMarketCapProvider;
