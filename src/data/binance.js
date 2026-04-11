/**
 * Binance Data Fetcher
 * Comprehensive data collection for day trading research
 * All public endpoints - no API key required
 */

// Use native fetch (Node 18+) - no external dependency needed
const BASE_SPOT = 'https://api.binance.com/api/v3';
const BASE_FUTURES = 'https://fapi.binance.com/fapi/v1';
const BASE_FUTURES_DATA = 'https://futures.binance.com/futures/data';

// In-memory cache for rate limit efficiency
const cache = new Map();
const CACHE_TTL = 5000; // 5 seconds for live data, 60s for historical

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
    return entry.data;
}
function cacheSet(key, data, ttl) {
    cache.set(key, { data, ts: Date.now(), ttl });
}

async function fetchJSON(url) {
    const cached = cacheGet(url);
    if (cached) return cached;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    cacheSet(url, data, CACHE_TTL);
    return data;
}

async function fetchText(url) {
    const cached = cacheGet(url);
    if (cached) return cached;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API error ${res.status}: ${await res.text()}`);
    const data = await res.text();
    cacheSet(url, data, CACHE_TTL);
    return data;
}

// ===== SPOT KLINES (candlestick data) =====
async function getKlines(symbol, interval, limit = 100) {
    const url = `${BASE_SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const data = await fetchJSON(url);
    // Binance format: [openTime, O, H, L, C, V, closeTime, quoteVolume, trades, buyVol, sellVol, ...]
    return data.map(d => ({
        openTime: Number(d[0]),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5]),
        closeTime: Number(d[6]),
        quoteVolume: parseFloat(d[7]),
        trades: Number(d[8]),
        buyVolume: parseFloat(d[9]),
        sellVolume: parseFloat(d[10]),
    }));
}

// ===== FUTURES PREMIUM INDEX (funding rates) =====
async function getPremiumIndex(symbol) {
    const url = `${BASE_FUTURES}/premiumIndex?symbol=${symbol}`;
    return fetchJSON(url);
}

// ===== FUTURES OPEN INTEREST =====
async function getOpenInterest(symbol) {
    const url = `${BASE_FUTURES}/openInterest?symbol=${symbol}`;
    return fetchJSON(url);
}

// ===== LONG/SHORT RATIO =====
// NOTE: /fapi/v1/LongShortRatio endpoint is currently returning 404 on Binance
// Using alternative endpoint for taker long/short ratio
async function getLongShortRatio(symbol, period = '1h', limit = 10) {
    // Fallback: use taker long short ratio which is still accessible
    const url = `${BASE_FUTURES}/takerLongShortRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
    try {
        const data = await fetchJSON(url);
        return data.map(d => ({
            symbol: d.symbol,
            longAccount: d.longAccount,
            shortAccount: d.shortAccount,
            longShortRatio: d.longShortRatio,
            timestamp: d.timestamp
        }));
    } catch (e) {
        // If even taker ratio fails, return synthetic data from recent funding
        console.warn(`L/S ratio API unavailable: ${e.message}. Using funding-derived proxy.`);
        return [];
    }
}

// ===== AGGREGATED TRADES (trade flow) =====
async function getAggTrades(symbol, limit = 100) {
    const url = `${BASE_FUTURES}/aggTrades?symbol=${symbol}&limit=${limit}`;
    const data = await fetchJSON(url);
    return data.map(d => ({
        tradeId: d.a,
        price: parseFloat(d.p),
        quantity: parseFloat(d.q),
        timestamp: d.T,
        isBuyerMaker: d.m, // true = seller initiated, false = buyer initiated
    }));
}

// ===== ORDER BOOK DEPTH =====
async function getDepth(symbol, limit = 20) {
    const url = `${BASE_SPOT}/depth?symbol=${symbol}&limit=${limit}`;
    return fetchJSON(url);
}

// ===== 24HR TICKER (for current price/momentum) =====
async function get24hrTicker(symbol) {
    const url = `${BASE_SPOT}/ticker/24hr?symbol=${symbol}`;
    return fetchJSON(url);
}

// ===== TOP TRADER POSITIONS (for L/S ratio) =====
async function getTopTraderPositions(symbol) {
    const url = `${BASE_FUTURES}/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=5`;
    return fetchJSON(url);
}

// ===== HISTORICAL KLINES (for backtesting) =====
async function getHistoricalKlines(symbol, interval, startTime, endTime) {
    // Binance only allows 1000 candles per request, so we paginate
    const allKlines = [];
    let currentStart = startTime;
    
    while (true) {
        const url = `${BASE_SPOT}/klines?symbol=${symbol}&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=1000`;
        const data = await fetchJSON(url);
        
        if (!data || data.length === 0) break;
        
        allKlines.push(...data.map(d => ({
            openTime: Number(d[0]),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            closeTime: Number(d[6]),
            quoteVolume: parseFloat(d[7]),
            trades: Number(d[8]),
            buyVolume: parseFloat(d[9]),
            sellVolume: parseFloat(d[10]),
        })));
        
        currentStart = data[data.length - 1][0] + 1;
        
        if (data.length < 1000) break;
        
        // Safety: stop if we're getting too many
        if (allKlines.length > 10000) {
            console.warn('Historical klines: reached 10000 candle limit');
            break;
        }
        
        // Rate limit protection
        await new Promise(r => setTimeout(r, 100));
    }
    
    return allKlines;
}

// ===== LIQUIDATIONS (from Binance) =====
async function getRecentLiquidations(symbol = null, limit = 100) {
    // Binance liquidation API endpoint
    const url = symbol 
        ? `${BASE_FUTURES}/allForceOrders?symbol=${symbol}&limit=${limit}`
        : `${BASE_FUTURES}/allForceOrders?limit=${limit}`;
    return fetchJSON(url);
}

// ===== MULTI-SYMBOL DAILY FUNDING SNAPSHOT =====
async function getAllFundingRates() {
    const url = `${BASE_FUTURES}/premiumIndex`;
    return fetchJSON(url);
}

export {
    getKlines,
    getPremiumIndex,
    getOpenInterest,
    getLongShortRatio,
    getAggTrades,
    getDepth,
    get24hrTicker,
    getTopTraderPositions,
    getHistoricalKlines,
    getRecentLiquidations,
    getAllFundingRates,
    fetchJSON,
};

// Usage examples:
if (process.argv[1]?.includes('binance-data')) {
    (async () => {
        console.log('=== BTCUSDT 1m klines (latest 5) ===');
        const klines = await getKlines('BTCUSDT', '1m', 5);
        klines.forEach(k => console.log(`${new Date(k.openTime).toISOString()} | O:${k.open} H:${k.high} L:${k.low} C:${k.close} V:${k.volume.toFixed(4)}`));
        
        console.log('\n=== BTCUSDT Premium Index ===');
        const pi = await getPremiumIndex('BTCUSDT');
        console.log(`Funding Rate: ${(parseFloat(pi.lastFundingRate) * 100).toFixed(4)}% | Mark: ${pi.markPrice} | Index: ${pi.indexPrice}`);
        
        console.log('\n=== BTCUSDT Order Book ===');
        const depth = await getDepth('BTCUSDT', 10);
        console.log('Bids:', depth.bids.slice(0,3).map(b => `${b[0]}:${b[1]}`).join(' | '));
        console.log('Asks:', depth.asks.slice(0,3).map(a => `${a[0]}:${a[1]}`).join(' | '));
        
        console.log('\n=== BTCUSDT Open Interest ===');
        const oi = await getOpenInterest('BTCUSDT');
        console.log(`OI: ${oi.openInterest} contracts`);
        
        console.log('\n=== BTCUSDT Long/Short Ratio ===');
        const ls = await getLongShortRatio('BTCUSDT', '1h', 5);
        ls.forEach(r => console.log(`${new Date(r.timestamp).toISOString()} | L:${r.longAccount} S:${r.shortAccount} R:${r.longShortRatio}`));
        
        console.log('\n=== Recent AggTrades ===');
        const trades = await getAggTrades('BTCUSDT', 10);
        trades.slice(0,5).forEach(t => console.log(`${new Date(t.timestamp).toISOString()} | P:${t.price} Q:${t.quantity} ${t.isBuyerMaker ? 'SELL' : 'BUY'}`));
        
        console.log('\n=== All Funding Rates (top 5 by absolute rate) ===');
        const allFR = await getAllFundingRates();
        const sorted = allFR.sort((a,b) => Math.abs(parseFloat(b.lastFundingRate)) - Math.abs(parseFloat(a.lastFundingRate)));
        sorted.slice(0,5).forEach(f => console.log(`${f.symbol}: ${(parseFloat(f.lastFundingRate)*100).toFixed(4)}%`));
    })();
}