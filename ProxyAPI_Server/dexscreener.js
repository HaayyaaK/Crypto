/**
 * DexScreener Provider Adapter
 *
 * Docs:     https://docs.dexscreener.com/api/
 * Auth:     Free, no API key.
 * Rate:     ~300 req/min.
 * Note:     DEX on-chain data; useful as cross-validation for DEX pricing.
 *           Token addresses are hardcoded for BTC (WETH wrapper) and ETH.
 */

'use strict';
const BaseProvider = require('./_base');

// On-chain token addresses (Ethereum mainnet)
const TOKEN_ADDRESSES = {
  'BTC/USD': '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
  'ETH/USD': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
};

class DexScreenerProvider extends BaseProvider {
  constructor() {
    super('dexscreener', 'DexScreener', 'context', {
      baseUrl: process.env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com/latest',
      timeoutMs: parseInt(process.env.DEXSCREENER_TIMEOUT_MS, 10) || 10_000,
      requiresAuth: false,
      enabled: process.env.DEXSCREENER_ENABLED !== 'false',
    });
  }

  async getTicker(symbol) {
    const addr = TOKEN_ADDRESSES[symbol];
    if (!addr) throw new Error(`DexScreener: unsupported symbol ${symbol}`);
    const { data } = await this._upstreamFetch(`/dex/tokens/${addr}`);
    // DexScreener returns { pairs: [...] } — pick the highest-liquidity pair
    const pairs = data?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error('DexScreener: no pairs returned');
    }
    // Sort by liquidity USD descending
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const top = pairs[0];
    return {
      symbol,
      price: parseFloat(top.priceUsd),
      bid: null,
      ask: null,
      high24h: null,
      low24h: null,
      volume24h: top.volume?.h24 || null,
      change24hPct: top.priceChange?.h24 || null,
      timestamp: Date.now(),
      source: 'dexscreener',
      dex: top.dexId,
      pair: top.pairAddress,
    };
  }

  async getOHLCV() {
    throw new Error('DexScreener: OHLCV not available via this provider');
  }
}

module.exports = DexScreenerProvider;
