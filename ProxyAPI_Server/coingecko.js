/**
 * CoinGecko Provider Adapter
 *
 * Docs:     https://docs.coingecko.com/reference/introduction
 * Auth:     Free tier: no key.  Demo key: ~500 req/min.  Pro: higher limits.
 * Rate:     Free: 10-30 req/min (no key).  Demo: ~500/min.
 *          Key is passed via ?x_cg_demo_api_key= query param.
 * Coins:    bitcoin, ethereum
 */

'use strict';
const BaseProvider = require('./_base');
const KeyManager = require('../keyManager');

class CoinGeckoProvider extends BaseProvider {
  constructor() {
    super('coingecko', 'CoinGecko', 'validation', {
      baseUrl: process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3',
      timeoutMs: parseInt(process.env.COINGECKO_TIMEOUT_MS, 10) || 10_000,
      requiresAuth: false,
      enabled: process.env.COINGECKO_ENABLED !== 'false',
    });
    this.coinMap = { 'BTC/USD': 'bitcoin', 'ETH/USD': 'ethereum' };
    // CoinGecko OHLC only accepts specific `days` values
    this.tfToDays = { '1m': 1, '5m': 1, '15m': 1, '30m': 1, '1h': 1, '4h': 7, '1d': 30 };

    // Optional key rotation
    const keysRaw = process.env.COINGECKO_API_KEYS || '';
    if (keysRaw.trim()) {
      const keys = keysRaw.split(',').map(k => k.trim()).filter(Boolean);
      if (keys.length > 0) {
        this.keyManager = new KeyManager({
          keys,
          queryParam: 'x_cg_demo_api_key',
          rateLimitPerKey: parseInt(process.env.COINGECKO_RATE_LIMIT_PER_KEY, 10) || 25,
          rateLimitWindowMs: 60_000,
        });
      }
    }
  }

  async getTicker(symbol) {
    const coinId = this.coinMap[symbol];
    if (!coinId) throw new Error(`CoinGecko: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/simple/price`, {
      query: {
        ids: coinId,
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_24hr_vol: 'true',
        include_last_updated_at: 'true',
      },
    });
    const d = data[coinId];
    if (!d) throw new Error(`CoinGecko: no data for ${coinId}`);
    return {
      symbol,
      price: d.usd,
      bid: null,
      ask: null,
      high24h: null,
      low24h: null,
      volume24h: d.usd_24h_vol || null,
      change24hPct: d.usd_24h_change || null,
      timestamp: (d.last_updated_at || Math.floor(Date.now() / 1000)) * 1000,
      source: 'coingecko',
    };
  }

  async getOHLCV(symbol, tf) {
    const coinId = this.coinMap[symbol];
    if (!coinId) throw new Error(`CoinGecko: unsupported symbol ${symbol}`);
    const days = this.tfToDays[tf] || 1;
    const { data } = await this._upstreamFetch(`/coins/${coinId}/ohlc`, {
      query: { vs_currency: 'usd', days: String(days) },
    });
    if (!Array.isArray(data)) throw new Error('CoinGecko: invalid OHLC response');
    return data.map(c => ({
      timestamp: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: 0, // CoinGecko OHLC doesn't include volume
    }));
  }
}

module.exports = CoinGeckoProvider;
