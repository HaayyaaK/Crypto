/**
 * Kraken Provider Adapter
 *
 * Docs:     https://docs.kraken.com/rest/
 * Auth:     None for public market-data endpoints.
 * Rate:     ~1 req/s unauthenticated; 20 req/s with API key (private).
 * Pairs:    XBTUSD (BTC/USD), ETHUSD (ETH/USD)
 * OHLC int: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600 (minutes)
 */

'use strict';
const BaseProvider = require('./_base');

class KrakenProvider extends BaseProvider {
  constructor() {
    const baseUrl = process.env.KRAKEN_BASE_URL || 'https://api.kraken.com/0/public';
    super('kraken', 'Kraken', 'canonical', {
      baseUrl,
      timeoutMs: parseInt(process.env.KRAKEN_TIMEOUT_MS, 10) || 8_000,
      requiresAuth: false,
      enabled: process.env.KRAKEN_ENABLED !== 'false',
    });
    this.pairMap = {
      'BTC/USD': process.env.KRAKEN_PAIR_BTC_USD || 'XBTUSD',
      'ETH/USD': process.env.KRAKEN_PAIR_ETH_USD || 'ETHUSD',
    };
    this.tfMinutes = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
  }

  async getOHLCV(symbol, tf, limit = 300) {
    const pair = this.pairMap[symbol];
    if (!pair) throw new Error(`Kraken: unsupported symbol ${symbol}`);
    const interval = this.tfMinutes[tf];
    if (!interval) throw new Error(`Kraken: unsupported timeframe ${tf}`);
    const { data } = await this._upstreamFetch(`/OHLC`, { query: { pair, interval } });
    const resultKey = Object.keys(data.result).find(k => k !== 'last');
    if (!resultKey) throw new Error('Kraken: invalid OHLC response');
    return data.result[resultKey].slice(-limit).map(c => ({
      timestamp: c[0] * 1000,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6]),
    }));
  }

  async getTicker(symbol) {
    const pair = this.pairMap[symbol];
    if (!pair) throw new Error(`Kraken: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/Ticker`, { query: { pair } });
    const t = data.result[Object.keys(data.result)[0]];
    return {
      symbol,
      price: parseFloat(t.c[0]),
      bid: parseFloat(t.b[0]),
      ask: parseFloat(t.a[0]),
      high24h: parseFloat(t.h[1]),
      low24h: parseFloat(t.l[1]),
      volume24h: parseFloat(t.v[1]),
      change24hPct: parseFloat(t.p[1]),
      timestamp: Date.now(),
      source: 'kraken',
    };
  }
}

module.exports = KrakenProvider;
