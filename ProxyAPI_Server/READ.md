Let me verify the full project structure first, then I'll give you complete deploy instructions.
Here's the full directory structure and deployment instructions:

---

## Directory Structure

```
crypto-proxy/
├── .env.example                  # Config template — copy to .env and fill in keys
├── .env                          # (you create)  — actual secrets, NEVER commit to git
├── .gitignore                    # (you create)  — exclude node_modules, .env
├── package.json                  # 3 runtime deps + start/dev scripts
├── server.js                     # Express app — routes, caching, rate limiting, health
├── keyManager.js                 # API key rotation engine (round-robin + cooldown)
└── providers/
    ├── index.js                  # Provider registry — instantiates & exports all 8
    ├── _base.js                  # Base class — circuit breaker, timeout, auth injection
    ├── kraken.js                 # Public REST, no key
    ├── coinbase.js               # Public REST, no key
    ├── binance.js                # Public REST, no key (.us geo-fallback option)
    ├── coingecko.js              # Optional demo key rotation via query param
    ├── coinpaprika.js            # Public REST, no key
    ├── dexscreener.js            # Public REST, no key (DEX on-chain)
    ├── coinmarketcap.js          # REQUIRED key rotation (X-CMC_PRO_API_KEY header)
    └── coinapi.js                # REQUIRED key rotation (X-CoinAPI-Key header)
```

**Total: 14 files, ~1,333 lines of JS**, zero build step required.

---

## Deployment Instructions

### 1. Prerequisites

| Requirement | Minimum Version                                           |
| ----------- | --------------------------------------------------------- |
| Node.js     | **18.0+** (uses native `fetch`)                           |
| npm         | 9+ (ships with Node 18)                                   |
| OS          | Linux / macOS / Windows (WSL2 for production recommended) |

Verify:

```bash
node -v    # v18.x or higher
npm -v
```

---

### 2. Install & Configure (Local)

```bash
# 1. Copy the project folder to your workspace
cp -r crypto-proxy/ ~/projects/crypto-proxy
cd ~/projects/crypto-proxy

# 2. Install dependencies (3 packages, ~2 seconds)
npm install

# 3. Create your .env from the template
cp .env.example .env

# 4. Edit .env — fill in AT MINIMUM the key-protected providers:
#    - COINMARKETCAP_API_KEYS=your-cmc-key-1,your-cmc-key-2
#    - COINAPI_API_KEYS=your-coinapi-key-1
#    All other providers (Kraken, Coinbase, Binance, CoinGecko,
#    CoinPaprika, DexScreener) work with zero keys out of the box.
nano .env   # or: code .env  /  vim .env
```

**Which providers need keys vs. don't:**

| Provider          | Keys Needed?        | Where to Get                                             |
| ----------------- | ------------------- | -------------------------------------------------------- |
| Kraken            | No (public)         | —                                                        |
| Coinbase          | No (public)         | —                                                        |
| Binance           | No (public)         | —                                                        |
| CoinGecko         | Optional (demo key) | [coingecko.com/en/api](https://www.coingecko.com/en/api) |
| CoinPaprika       | No (public)         | —                                                        |
| DexScreener       | No (public)         | —                                                        |
| **CoinMarketCap** | **Yes (required)**  | [coinmarketcap.com/api](https://coinmarketcap.com/api/)  |
| **CoinAPI**       | **Yes (required)**  | [docs.coinapi.io](https://docs.coinapi.io/)              |

---

### 3. Run Locally

```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start
```

Server starts on **`http://localhost:3210`**. Test immediately:

```bash
# Public provider (no key needed)
curl -s http://localhost:3210/api/v1/kraken/ticker?symbol=BTC/USD | jq .

# Key-protected provider (key auto-injected by proxy)
curl -s http://localhost:3210/api/v1/coinmarketcap/ticker?symbol=BTC/USD | jq .

# All providers at once (parallel consensus)
curl -s http://localhost:3210/api/v1/aggregated/ticker?symbol=ETH/USD | jq .

# Live health dashboard
curl -s http://localhost:3210/health | jq .
curl -s http://localhost:3210/health/keys | jq .
curl -s http://localhost:3210/health/providers | jq .
```

---

### 4. Deploy to Production (3 Options)

#### Option A — Bare Metal / VPS (easiest)

```bash
# On your server (Ubuntu/Debian):
sudo apt update && sudo apt install -y nodejs npm

# Transfer files (from your local machine):
scp -r crypto-proxy/ user@your-server:/opt/crypto-proxy

# SSH in and start:
ssh user@your-server
cd /opt/crypto-proxy
npm install --production
cp .env.example .env && nano .env   # fill keys

# Run with PM2 (process manager — auto-restart on crash):
sudo npm install -g pm2
pm2 start server.js --name crypto-proxy
pm2 save
pm2 startup    # generates systemd service for auto-start on boot
```

#### Option B — Docker

Create a `Dockerfile` in the project root (one file, ~15 lines):

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm ci --production
COPY . .
EXPOSE 3210
CMD ["node", "server.js"]
```

```bash
# Build & run
docker build -t crypto-proxy .
docker run -d \
  --name crypto-proxy \
  --env-file .env \
  -p 3210:3210 \
  --restart unless-stopped \
  crypto-proxy
```

#### Option C — Docker Compose (proxy + frontend)

Create `docker-compose.yml` alongside the `Dockerfile`:

```yaml
services:
  proxy:
    build: .
    ports:
      - "3210:3210"
    env_file: .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3210/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

```bash
docker compose up -d
docker compose logs -f proxy
```

---

### 5. Reverse Proxy (Nginx — recommended for production)

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then add HTTPS with Let's Encrypt:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

### 6. Frontend Integration (update your HTML)

In your `BTC_ETH_Trading_Insights_Signals_Generator.html`, the key change is pointing the provider base URLs to your proxy instead of hitting external APIs directly:

```js
// BEFORE (in the HTML — direct to exchange, CORS issues, no key security):
// this.baseUrl = 'https://api.kraken.com/0/public';
// this.baseUrl = 'https://pro-api.coinmarketcap.com';

// AFTER (route everything through your proxy):
const PROXY_BASE = "https://api.yourdomain.com"; // or http://localhost:3210

// In each provider class, change the fetch URL pattern:
// From:  const res = await fetch(this.baseUrl + '/OHLC?pair=...');
// To:    const res = await fetch(`${PROXY_BASE}/api/v1/kraken/ohlcv?symbol=${symbol}&timeframe=${tf}`);
```

This single change eliminates all CORS issues, hides every API key behind the proxy, and adds caching + circuit-breaker resilience automatically.

---

### 7. Key `.env` Variables to Lock Down Before Deploying

| Variable                 | Why It Matters                                      |
| ------------------------ | --------------------------------------------------- |
| `CORS_ORIGIN`            | Set to your exact frontend domain, **not** `*`      |
| `PORT`                   | Default 3210 — change only if conflicting           |
| `COINMARKETCAP_API_KEYS` | Comma-separate multiple keys for rotation           |
| `COINAPI_API_KEYS`       | Comma-separate multiple keys for rotation           |
| `COINGECKO_API_KEYS`     | Optional but raises free tier from ~10 to ~500 RPM  |
| `LOG_LEVEL`              | Use `warn` or `error` in production to reduce noise |
| `BINANCE_USE_US`         | Set `true` if deploying from a US IP                |

Create a `.gitignore` in the project root:

```
node_modules/
.env
*.log
```
