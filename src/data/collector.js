/**
 * Historical Data Collector
 * Pulls and stores historical data for backtesting
 */

import { getKlines, getHistoricalKlines, getAllFundingRates, getPremiumIndex } from '../data/binance.js';
import fs from 'fs';
import path from 'path';

const DATA_DIR = './data';
const CACHE_DIR = `${DATA_DIR}/cache`;

// Ensure directories exist
[dataDir, cacheDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

async function saveKlines(symbol, interval, startDate, endDate) {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    
    console.log(`Collecting ${symbol} ${interval} klines from ${startDate} to ${endDate}...`);
    
    const klines = await getHistoricalKlines(symbol, interval, start, end);
    
    const fileName = `${DATA_DIR}/${symbol}_${interval}.json`;
    fs.writeFileSync(fileName, JSON.stringify(klines, null, 2));
    console.log(`Saved ${klines.length} klines to ${fileName}`);
    
    return klines;
}

async function collectFundingHistory() {
    // Funding rates only available in real-time + recent history
    // We can collect snapshots over time
    
    console.log('\n=== FUNDING RATE SNAPSHOT ===');
    const allFR = await getAllFundingRates();
    
    const snapshot = {
        timestamp: Date.now(),
        rates: allFR.map(f => ({
            symbol: f.symbol,
            fundingRate: parseFloat(f.lastFundingRate),
            markPrice: parseFloat(f.markPrice),
            indexPrice: parseFloat(f.indexPrice)
        }))
    };
    
    const historyFile = `${DATA_DIR}/funding_history.json`;
    let history = [];
    if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }
    
    history.push(snapshot);
    
    // Keep last 1000 snapshots (8h intervals = 3 per day = ~1 year)
    if (history.length > 1000) history = history.slice(-1000);
    
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    console.log(`Saved funding snapshot ${history.length} total`);
    
    return snapshot;
}

async function collectFundingHistoryDaily(symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT']) {
    // For each symbol, collect current funding + OI state
    const daily = {
        timestamp: Date.now(),
        symbols: {}
    };
    
    for (const symbol of symbols) {
        try {
            const pi = await getPremiumIndex(symbol);
            daily.symbols[symbol] = {
                fundingRate: parseFloat(pi.lastFundingRate),
                fundingBps: parseFloat(pi.lastFundingRate) * 10000,
                markPrice: parseFloat(pi.markPrice),
                indexPrice: parseFloat(pi.indexPrice),
                basis: parseFloat(pi.markPrice) - parseFloat(pi.indexPrice),
                basisPct: ((parseFloat(pi.markPrice) - parseFloat(pi.indexPrice)) / parseFloat(pi.indexPrice)) * 100
            };
            console.log(`${symbol}: ${daily.symbols[symbol].fundingBps.toFixed(2)} bps`);
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.error(`Failed ${symbol}: ${e.message}`);
        }
    }
    
    const historyFile = `${DATA_DIR}/daily_funding.json`;
    let history = [];
    if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }
    history.push(daily);
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    
    return daily;
}

// Run as script
if (process.argv[1]?.includes('collector')) {
    const mode = process.argv[2] || 'all';
    
    (async () => {
        if (mode === 'klines' || mode === 'all') {
            const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
            const now = Date.now();
            const threeYearsAgo = now - (3 * 365 * 24 * 60 * 60 * 1000);
            
            for (const symbol of symbols) {
                try {
                    await saveKlines(symbol, '1m', new Date(threeYearsAgo).toISOString().split('T')[0], new Date().toISOString().split('T')[0]);
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {
                    console.error(`${symbol} failed: ${e.message}`);
                }
            }
        }
        
        if (mode === 'funding' || mode === 'all') {
            await collectFundingHistoryDaily();
        }
        
        console.log('\nCollection complete!');
    })();
}

export {
    saveKlines,
    collectFundingHistory,
    collectFundingHistoryDaily
};