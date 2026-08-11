/**
 * Binance Provider Adapter
 *
 * Docs:     https://binance-docs.github.io/apidocs/spot/en/
 * Auth:     None for public market-data (public endpoints).
 * Rate:     1200 req/min (weight-based).  1 kline = 2 weight.
 * Pairs:    BTCUSDT, ETHUSDT (USDT as USD-equivalent; documented in frontend)
 * Note:     Binance.com may be geo-restricted (US).  Set BINANCE_USE_US=true for binance.us.
 */

'use strict';
const BaseProvider = require('./_base');

class BinanceProvider extends BaseProvider {
  constructor() {
    const useUs = process.env.BINANCE_USE_US === 'true';
    const baseUrl = useUs
      ? (process.env.BINANCE_US_BASE_URL || 'https://api.binance.us/api/v3')
      : (process.env.BINANCE_BASE_URL || 'https://api.binance.com/api/v3');
    super('binance', 'Binance', 'fallback', {
      baseUrl,
      timeoutMs: parseInt(process.env.BINANCE_TIMEOUT_MS, 10) || 8_000,
      requiresAuth: false,
      enabled: process.env.BINANCE_ENABLED !== 'false',
    });
    this.pairMap = {
      'BTC/USD': process.env.BINANCE_PAIR_BTC_USD || 'BTCUSDT',
      'ETH/USD': process.env.BINANCE_PAIR_ETH_USD || 'ETHUSDT',
    };
    // Binance interval strings are the same as our tf codes
  }

  async getOHLCV(symbol, tf, limit = 300) {
    const pair = this.pairMap[symbol];
    if (!pair) throw new Error(`Binance: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/klines`, {
      query: { symbol: pair, interval: tf, limit },
    });
    if (!Array.isArray(data)) throw new Error('Binance: invalid kline response');
    return data.map(c => ({
      timestamp: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  async getTicker(symbol) {
    const pair = this.pairMap[symbol];
    if (!pair) throw new Error(`Binance: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/ticker/24hr`, { query: { symbol: pair } });
    return {
      symbol,
      price: parseFloat(data.lastPrice),
      bid: null,
      ask: null,
      high24h: parseFloat(data.highPrice),
      low24h: parseFloat(data.lowPrice),
      volume24h: parseFloat(data.volume),
      change24hPct: parseFloat(data.priceChangePercent),
      timestamp: Date.now(),
      source: 'binance',
      note: 'USDT treated as USD-equivalent (stablecoin peg)',
    };
  }
}

module.exports = BinanceProvider;
