/**
 * Provider Registry
 * Centralises all provider instances.  server.js imports this single module.
 */

'use strict';

const KrakenProvider       = require('./kraken');
const CoinbaseProvider     = require('./coinbase');
const BinanceProvider      = require('./binance');
const CoinGeckoProvider    = require('./coingecko');
const CoinPaprikaProvider  = require('./coinpaprika');
const DexScreenerProvider  = require('./dexscreener');
const CoinMarketCapProvider = require('./coinmarketcap');
const CoinAPIProvider      = require('./coinapi');

// Instantiate all providers
const providers = [
  new KrakenProvider(),
  new CoinbaseProvider(),
  new BinanceProvider(),
  new CoinGeckoProvider(),
  new CoinPaprikaProvider(),
  new DexScreenerProvider(),
  new CoinMarketCapProvider(),
  new CoinAPIProvider(),
];

// Index by id for O(1) lookup
const byId = {};
for (const p of providers) {
  byId[p.id] = p;
}

module.exports = { providers, byId };
