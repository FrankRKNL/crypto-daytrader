/**
 * Day Trading Indicators
 * Focus: orderflow, microstructure, derivatives signals
 * NOT standard TA (EMA/RSI etc)
 */

import { getKlines, getAggTrades, getDepth, getPremiumIndex, getOpenInterest, getLongShortRatio, get24hrTicker, getRecentLiquidations, getAllFundingRates } from '../data/binance.js';

// ===== ORDER BOOK IMBALANCE =====
async function getOrderBookImbalance(symbol) {
    const depth = await getDepth(symbol, 50);
    
    let bidVolume = 0;
    let askVolume = 0;
    let bidWall = 0; // large order concentration
    let askWall = 0;
    
    depth.bids.forEach(([price, qty]) => {
        bidVolume += parseFloat(qty);
        if (parseFloat(qty) > bidWall) bidWall = parseFloat(qty);
    });
    
    depth.asks.forEach(([price, qty]) => {
        askVolume += parseFloat(qty);
        if (parseFloat(qty) > askWall) askWall = parseFloat(qty);
    });
    
    const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
    const wallRatio = bidWall / (askWall + 0.0001);
    
    return {
        imbalance,       // -1 to 1 (negative = sell pressure)
        bidVolume,
        askVolume,
        bidWall,
        askWall,
        wallRatio,
        spread: parseFloat(depth.asks[0][0]) - parseFloat(depth.bids[0][0])
    };
}

// ===== TRADE FLOW IMBALANCE =====
async function getTradeFlowImbalance(symbol, lookbackTrades = 100) {
    const trades = await getAggTrades(symbol, lookbackTrades);
    
    let buyVolume = 0;
    let sellVolume = 0;
    let buyTrades = 0;
    let sellTrades = 0;
    
    trades.forEach(t => {
        if (t.isBuyerMaker) {
            sellVolume += t.quantity;
            sellTrades++;
        } else {
            buyVolume += t.quantity;
            buyTrades++;
        }
    });
    
    const volumeImbalance = (buyVolume - sellVolume) / (buyVolume + sellVolume);
    const tradeImbalance = (buyTrades - sellTrades) / (buyTrades + sellTrades);
    
    // Recent momentum: compare last 20 vs previous 20
    const recentTrades = trades.slice(0, Math.min(20, trades.length));
    const olderTrades = trades.slice(Math.min(20, trades.length), Math.min(40, trades.length));
    
    let recentBuyVol = 0, recentSellVol = 0;
    let olderBuyVol = 0, olderSellVol = 0;
    
    recentTrades.forEach(t => t.isBuyerMaker ? recentSellVol += t.quantity : recentBuyVol += t.quantity);
    olderTrades.forEach(t => t.isBuyerMaker ? olderSellVol += t.quantity : olderBuyVol += t.quantity);
    
    const momentum = (recentBuyVol - recentSellVol) / (olderBuyVol - olderSellVol + 0.0001);
    
    return {
        volumeImbalance,
        tradeImbalance,
        buyVolume,
        sellVolume,
        buyTrades,
        sellTrades,
        momentum,
        tradeCount: trades.length
    };
}

// ===== FUNDING RATE SIGNALS =====
async function getFundingSignals(symbol) {
    const pi = await getPremiumIndex(symbol);
    const fundingRate = parseFloat(pi.lastFundingRate);
    
    // Funding rate interpretation:
    // Positive = longs pay shorts (bullish sentiment, overleveraged longs = risk)
    // Negative = shorts pay longs (bearish sentiment, overleveraged shorts = risk)
    
    // Extreme funding = potential reversal signal
    // But also: funding persists in trending markets
    
    return {
        fundingRate,
        fundingBps: fundingRate * 10000,
        markPrice: parseFloat(pi.markPrice),
        indexPrice: parseFloat(pi.indexPrice),
        basis: parseFloat(pi.markPrice) - parseFloat(pi.indexPrice),
        basisPct: ((parseFloat(pi.markPrice) - parseFloat(pi.indexPrice)) / parseFloat(pi.indexPrice)) * 100,
        nextFundingTime: pi.nextFundingTime
    };
}

// ===== OI CHANGE SIGNALS =====
async function getOISignals(symbol) {
    // This would need historical OI for real signals
    // For now we capture current OI and compare to recent history
    
    const oi = await getOpenInterest(symbol);
    const ticker = await get24hrTicker(symbol);
    
    return {
        openInterest: parseFloat(oi.openInterest),
        price: parseFloat(ticker.lastPrice),
        priceChangePct: parseFloat(ticker.priceChangePercent),
        volume24h: parseFloat(ticker.volume),
        quoteVolume24h: parseFloat(ticker.quoteVolume)
    };
}

// ===== LONG/SHORT RATIO SIGNALS =====
async function getLSSignals(symbol, periods = 10) {
    const ls = await getLongShortRatio(symbol, '1h', periods);
    
    if (!ls || ls.length < 2) return { error: 'Insufficient data' };
    
    const current = ls[ls.length - 1];
    const currentRatio = parseFloat(current.longShortRatio);
    const currentLongPct = parseFloat(current.longAccount) * 100;
    const currentShortPct = parseFloat(current.shortAccount) * 100;
    
    // Calculate trend
    const pastRatios = ls.slice(0, -1).map(l => parseFloat(l.longShortRatio));
    const avgPastRatio = pastRatios.reduce((a, b) => a + b, 0) / pastRatios.length;
    
    // Ratio change signal
    const ratioChange = currentRatio - avgPastRatio;
    
    // Extreme readings
    const extremeLong = currentLongPct > 55; // >55% long = crowded long = potential reversal
    const extremeShort = currentShortPct > 55; // >55% short = crowded short = potential reversal
    
    return {
        currentRatio,
        currentLongPct,
        currentShortPct,
        avgPastRatio,
        ratioChange,
        ratioChangePct: ((currentRatio - avgPastRatio) / avgPastRatio) * 100,
        extremeLong,
        extremeShort,
        trend: ratioChange > 0 ? 'more_long' : ratioChange < 0 ? 'more_short' : 'neutral'
    };
}

// ===== AGGRESSIVE ORDERFLOW DETECTOR =====
async function getAggressiveFlow(symbol, tradesLookback = 50) {
    const trades = await getAggTrades(symbol, tradesLookback);
    
    // Group into time buckets (e.g., 1-second windows)
    const buckets = {};
    trades.forEach(t => {
        const bucketTime = Math.floor(t.timestamp / 1000) * 1000;
        if (!buckets[bucketTime]) buckets[bucketTime] = { buy: 0, sell: 0, count: 0 };
        if (t.isBuyerMaker) {
            buckets[bucketTime].sell += t.quantity;
        } else {
            buckets[bucketTime].buy += t.quantity;
        }
        buckets[bucketTime].count++;
    });
    
    const bucketTimes = Object.keys(buckets).sort();
    const recentBuckets = bucketTimes.slice(-10);
    
    let aggressiveBuySpikes = 0;
    let aggressiveSellSpikes = 0;
    
    recentBuckets.forEach(bt => {
        const b = buckets[bt];
        const total = b.buy + b.sell;
        if (total > 0) {
            const ratio = b.buy / total;
            if (ratio > 0.75) aggressiveBuySpikes++;
            if (ratio < 0.25) aggressiveSellSpikes++;
        }
    });
    
    // VWAP of recent trades
    let vwapSum = 0;
    let volumeSum = 0;
    trades.forEach(t => {
        vwapSum += t.price * t.quantity;
        volumeSum += t.quantity;
    });
    const vwap = vwapSum / volumeSum;
    
    const lastTrade = trades[0];
    const lastPrice = lastTrade.price;
    const vwapDeviation = (lastPrice - vwap) / vwap * 100;
    
    return {
        aggressiveBuySpikes,
        aggressiveSellSpikes,
        vwap,
        vwapDeviation,
        lastPrice,
        tradeCount: trades.length
    };
}

// ===== LIQUIDATION CLUSTER DETECTOR =====
async function getLiquidationClusters(symbol = null) {
    const liqs = await getRecentLiquidations(symbol, 100);
    
    // Group liquidations by time (5-minute windows)
    const windows = {};
    liqs.forEach(l => {
        const windowTime = Math.floor(l.time / (5 * 60 * 1000)) * (5 * 60 * 1000);
        if (!windows[windowTime]) windows[windowTime] = { buy: 0, sell: 0, count: 0 };
        if (l.side === 'BUY') {
            windows[windowTime].buy += parseFloat(l.price) * parseFloat(l.size);
        } else {
            windows[windowTime].sell += parseFloat(l.price) * parseFloat(l.size);
        }
        windows[windowTime].count++;
    });
    
    const windowTimes = Object.keys(windows).sort();
    const recentWindows = windowTimes.slice(-6); // last 30 minutes
    
    let totalBuyLiq = 0;
    let totalSellLiq = 0;
    
    recentWindows.forEach(wt => {
        const w = windows[wt];
        totalBuyLiq += w.buy;
        totalSellLiq += w.sell;
    });
    
    const imbalance = (totalSellLiq - totalBuyLiq) / (totalSellLiq + totalBuyLiq + 1);
    
    return {
        buyLiquidations: totalBuyLiq,
        sellLiquidations: totalSellLiq,
        imbalance,
        windowCount: recentWindows.length,
        rawData: liqs.slice(0, 10)
    };
}

// ===== MULTI-SYMBOL FUNDING SCAN =====
async function getFundingScan() {
    const allFR = await getAllFundingRates();
    
    // Find extremes
    const sorted = allFR.map(f => ({
        symbol: f.symbol,
        fundingRate: parseFloat(f.lastFundingRate),
        fundingBps: parseFloat(f.lastFundingRate) * 10000,
        markPrice: parseFloat(f.markPrice)
    })).sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));
    
    const mostPositive = sorted.filter(f => f.fundingRate > 0).slice(0, 5);
    const mostNegative = sorted.filter(f => f.fundingRate < 0).slice(-5).reverse();
    
    return {
        topPositive: mostPositive,
        topNegative: mostNegative,
        totalSymbols: allFR.length
    };
}

// ===== COMBINED SIGNAL DASHBOARD =====
async function getSignalDashboard(symbol) {
    try {
        const [obi, tfi, fr, oi, ls, agf] = await Promise.all([
            getOrderBookImbalance(symbol),
            getTradeFlowImbalance(symbol, 100),
            getFundingSignals(symbol),
            getOISignals(symbol),
            getLSSignals(symbol, 10),
            getAggressiveFlow(symbol, 50)
        ]);
        
        return {
            symbol,
            timestamp: Date.now(),
            orderbook: obi,
            tradeflow: tfi,
            funding: fr,
            oi: oi,
            longshort: ls,
            aggressive: agf
        };
    } catch (err) {
        return { symbol, error: err.message };
    }
}

// Export all functions
export {
    getOrderBookImbalance,
    getTradeFlowImbalance,
    getFundingSignals,
    getOISignals,
    getLSSignals,
    getAggressiveFlow,
    getLiquidationClusters,
    getFundingScan,
    getSignalDashboard
};

// CLI test
if (process.argv[1]?.includes('indicators')) {
    (async () => {
        console.log('=== SIGNAL DASHBOARD BTCUSDT ===\n');
        const dash = await getSignalDashboard('BTCUSDT');
        
        console.log(`Funding Rate: ${dash.funding?.fundingBps?.toFixed(2)} bps (${dash.funding?.fundingRate > 0 ? 'LONG PAY' : 'SHORT PAY'})`);
        console.log(`OI: ${dash.oi?.openInterest?.toFixed(0)} contracts | Price: ${dash.oi?.price}`);
        console.log(`L/S Ratio: ${dash.longshort?.currentRatio?.toFixed(4)} | ${dash.longshort?.currentLongPct?.toFixed(1)}% long / ${dash.longshort?.currentShortPct?.toFixed(1)}% short`);
        console.log(`OrderBook Imbalance: ${dash.orderbook?.imbalance?.toFixed(4)} | Spread: ${dash.orderbook?.spread?.toFixed(2)}`);
        console.log(`Trade Flow Imbalance: ${dash.tradeflow?.volumeImbalance?.toFixed(4)} | ${dash.tradeflow?.buyTrades} buy / ${dash.tradeflow?.sellTrades} sell trades`);
        console.log(`VWAP Deviation: ${dash.aggressive?.vwapDeviation?.toFixed(3)}%`);
        
        console.log('\n=== FUNDING SCAN (extreme rates) ===\n');
        const scan = await getFundingScan();
        console.log('Most positive funding (longs pay):');
        scan.topPositive.forEach(f => console.log(`  ${f.symbol}: ${f.fundingBps.toFixed(2)} bps`));
        console.log('\nMost negative funding (shorts pay):');
        scan.topNegative.forEach(f => console.log(`  ${f.symbol}: ${f.fundingBps.toFixed(2)} bps`));
        
        console.log('\n=== LIQUIDATION CLUSTERS ===\n');
        const liqs = await getLiquidationClusters('BTCUSDT');
        console.log(`Recent sell liquidations: $${liqs.sellLiquidations?.toFixed(0)}`);
        console.log(`Recent buy liquidations: $${liqs.buyLiquidations?.toFixed(0)}`);
        console.log(`Imbalance: ${liqs.imbalance?.toFixed(4)}`);
    })();
}