/**
 * CoinPaprika Provider Adapter
 *
 * Docs:     https://api.coinpaprika.com/docs/
 * Auth:     Free, no API key.
 * Rate:     25,000 calls/month on the free tier — use sparingly.
 * Coins:    btc-bitcoin, eth-ethereum
 */

'use strict';
const BaseProvider = require('./_base');

class CoinPaprikaProvider extends BaseProvider {
  constructor() {
    super('coinpaprika', 'CoinPaprika', 'validation', {
      baseUrl: process.env.COINPAPRIKA_BASE_URL || 'https://api.coinpaprika.com/v1',
      timeoutMs: parseInt(process.env.COINPAPRIKA_TIMEOUT_MS, 10) || 10_000,
      requiresAuth: false,
      enabled: process.env.COINPAPRIKA_ENABLED !== 'false',
    });
    this.coinMap = { 'BTC/USD': 'btc-bitcoin', 'ETH/USD': 'eth-ethereum' };
  }

  async getTicker(symbol) {
    const coinId = this.coinMap[symbol];
    if (!coinId) throw new Error(`CoinPaprika: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/tickers/${coinId}`, {
      query: { quotes: 'USD' },
    });
    const q = data.quotes?.USD;
    if (!q) throw new Error(`CoinPaprika: no USD quote for ${coinId}`);
    return {
      symbol,
      price: q.price,
      bid: null,
      ask: null,
      high24h: null, // not provided
      low24h: null,
      volume24h: q.volume_24h || null,
      change24hPct: q.percent_change_24h || null,
      timestamp: data.last_updated ? new Date(data.last_updated).getTime() : Date.now(),
      source: 'coinpaprika',
    };
  }

  // CoinPaprika doesn't have a convenient OHLCV endpoint, skip
  async getOHLCV() {
    throw new Error('CoinPaprika: OHLCV not available via this provider');
  }
}

module.exports = CoinPaprikaProvider;
