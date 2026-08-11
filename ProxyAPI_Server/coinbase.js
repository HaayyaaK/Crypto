/**
 * Coinbase Exchange Provider Adapter
 *
 * Docs:     https://docs.cloud.coinbase.com/exchange/reference/
 * Auth:     None for public market-data.
 * Rate:     ~10 req/s public.
 * Pairs:    BTC-USD, ETH-USD (note the dash separator)
 */

'use strict';
const BaseProvider = require('./_base');

class CoinbaseProvider extends BaseProvider {
  constructor() {
    super('coinbase', 'Coinbase', 'canonical', {
      baseUrl: process.env.COINBASE_BASE_URL || 'https://api.exchange.coinbase.com',
      timeoutMs: parseInt(process.env.COINBASE_TIMEOUT_MS, 10) || 8_000,
      requiresAuth: false,
      enabled: process.env.COINBASE_ENABLED !== 'false',
    });
    this.pairMap = {
      'BTC/USD': 'BTC-USD',
      'ETH/USD': 'ETH-USD',
    };
    this.tfSeconds = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  }

  async getOHLCV(symbol, tf, limit = 300) {
    const pair = this.pairMap[symbol];
    if (!pair) throw new Error(`Coinbase: unsupported symbol ${symbol}`);
    const granularity = this.tfSeconds[tf];
    if (!granularity) throw new Error(`Coinbase: unsupported timeframe ${tf}`);
    // Coinbase candles endpoint: ascending order, max 300 per request
    const { data } = await this._upstreamFetch(`/products/${pair}/candles`, {
      query: { granularity },
    });
    if (!Array.isArray(data)) throw new Error('Coinbase: invalid OHLC response');
    // Coinbase returns newest first; reverse to ascending then limit
    return data.slice(0, limit).reverse().map(c => ({
      timestamp: c[0] * 1000,
      open: parseFloat(c[3]),
      high: parseFloat(c[2]),
      low: parseFloat(c[1]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  async getTicker(symbol) {
    const pair = this.pairMap[symbol];
    if (!pair) throw new Error(`Coinbase: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/products/${pair}/ticker`);
    return {
      symbol,
      price: parseFloat(data.price),
      bid: parseFloat(data.bid),
      ask: parseFloat(data.ask),
      high24h: parseFloat(data.high_24h),
      low24h: parseFloat(data.low_24h),
      volume24h: parseFloat(data.volume_24h),
      change24hPct: null, // Coinbase ticker doesn't include change %
      timestamp: Date.now(),
      source: 'coinbase',
    };
  }
}

module.exports = CoinbaseProvider;
