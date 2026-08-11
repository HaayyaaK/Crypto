/**
 * CoinAPI Provider Adapter
 *
 * Docs:     https://docs.coinapi.io/
 * Auth:     REQUIRED — API key passed via X-CoinAPI-Key header.
 * Rate:     Free: 100 calls/day.  Starter ($49/mo): 500/day.  etc.
 *          Key rotation distributes load across multiple keys.
 * Symbols:  BTC/USD = BINANCE_SPOT_BTC_USDT or KRAKEN_SPOT_BTC_USD
 *           ETH/USD = BINANCE_SPOT_ETH_USDT or KRAKEN_SPOT_ETH_USD
 *          We use BINANCE_SPOT_* as the primary symbol identifier.
 */

'use strict';
const BaseProvider = require('./_base');
const KeyManager = require('../keyManager');

class CoinAPIProvider extends BaseProvider {
  constructor() {
    const keysRaw = process.env.COINAPI_API_KEYS || '';
    const keys = keysRaw.split(',').map(k => k.trim()).filter(Boolean);
    const hasKeys = keys.length > 0;

    super('coinapi', 'CoinAPI', 'reference', {
      baseUrl: process.env.COINAPI_BASE_URL || 'https://rest.coinapi.io/v1',
      timeoutMs: parseInt(process.env.COINAPI_TIMEOUT_MS, 10) || 10_000,
      requiresAuth: true,
      enabled: process.env.COINAPI_ENABLED === 'true' && hasKeys,
    });

    this.symbolMap = {
      'BTC/USD': 'BINANCE_SPOT_BTC_USDT',
      'ETH/USD': 'BINANCE_SPOT_ETH_USDT',
    };
    // CoinAPI period_id format: e.g. 1MIN, 5MIN, 15MIN, 1HRS, 4HRS, 1DAY
    this.tfToPeriod = {
      '1m': '1MIN', '5m': '5MIN', '15m': '15MIN', '30m': '30MIN',
      '1h': '1HRS', '4h': '4HRS', '1d': '1DAY',
    };

    if (hasKeys) {
      this.keyManager = new KeyManager({
        keys,
        headerName: process.env.COINAPI_KEY_HEADER || 'X-CoinAPI-Key',
        rateLimitPerKey: parseInt(process.env.COINAPI_RATE_LIMIT_PER_KEY, 10) || 10,
        rateLimitWindowMs: parseInt(process.env.COINAPI_RATE_LIMIT_WINDOW_MS, 10) || 60_000,
      });
    }
  }

  async getOHLCV(symbol, tf, limit = 300) {
    const symId = this.symbolMap[symbol];
    if (!symId) throw new Error(`CoinAPI: unsupported symbol ${symbol}`);
    const periodId = this.tfToPeriod[tf];
    if (!periodId) throw new Error(`CoinAPI: unsupported timeframe ${tf}`);
    const now = new Date();
    const start = new Date(now.getTime() - limit * this._periodMs(tf));
    const { data } = await this._upstreamFetch(`/ohlcv/${symId}/latest`, {
      query: {
        period_id: periodId,
        limit: String(limit),
      },
    });
    if (!Array.isArray(data)) throw new Error('CoinAPI: invalid OHLCV response');
    return data.map(c => ({
      timestamp: new Date(c.time_period_start).getTime(),
      open: c.price_open,
      high: c.price_high,
      low: c.price_low,
      close: c.price_close,
      volume: c.volume_traded,
    }));
  }

  async getTicker(symbol) {
    const symId = this.symbolMap[symbol];
    if (!symId) throw new Error(`CoinAPI: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/assets/${symId}/metrics`);
    return {
      symbol,
      price: data.price,
      bid: null,
      ask: null,
      high24h: data.high,
      low24h: data.low,
      volume24h: data.volume_1day_usd || null,
      change24hPct: data.changes?.['1d'] || null,
      timestamp: Date.now(),
      source: 'coinapi',
    };
  }

  _periodMs(tf) {
    const map = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
    return map[tf] || 60_000;
  }
}

module.exports = CoinAPIProvider;
