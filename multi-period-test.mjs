import axios from 'axios';
import fs from 'fs';

const INITIAL_BALANCE = 100;
const FEE_RATE = 0.001;
const SLIPPAGE = 0.0005;

async function fetchBinanceCandles(symbol = 'BTCUSDT', interval = '15m', days = 30) {
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const allCandles = [];
  let currentStart = startTime;
  while (currentStart < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&startTime=${currentStart}`;
    const res = await axios.get(url);
    const candles = res.data.map(c => ({
      ts: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
    }));
    allCandles.push(...candles);
    if (candles.length < 1000) break;
    currentStart = candles[candles.length - 1].ts + 1;
  }
  allCandles.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return allCandles.filter(c => { if (seen.has(c.ts)) return false; seen.add(c.ts); return true; });
}

// VWAP
function vwap(high, low, close, volume) {
  let cumVP = 0, cumV = 0;
  return close.map((c, i) => {
    const typical = (high[i] + low[i] + c) / 3;
    cumVP += typical * volume[i]; cumV += volume[i];
    return cumV === 0 ? c : cumVP / cumV;
  });
}

// EMA
function ema(prices, period) {
  const k = 2 / (period + 1);
  let cur = prices[0];
  return prices.map(v => { cur = v * k + cur * (1 - k); return cur; });
}

// RSI
function rsi(prices, period = 14) {
  let gains = 0, losses = 0;
  const result = [];
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) { result.push(null); continue; }
    const ch = prices[i] - prices[i - 1];
    gains += ch > 0 ? ch : 0;
    losses += ch < 0 ? Math.abs(ch) : 0;
    if (i >= period) {
      if (i > period) { gains = gains * (period - 1) / period; losses = losses * (period - 1) / period; }
      const ag = gains / period, al = losses / period;
      result.push(ag + al === 0 ? 50 : 100 - 100 / (1 + ag / al));
      gains = ag; losses = al;
    } else result.push(null);
  }
  return result;
}

// ATR
function atr(high, low, close, period = 14) {
  const tr = high.map((h, i) => {
    if (i === 0) return high[0] - low[0];
    return Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  });
  const result = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    result.push(tr.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0) / period);
  }
  return result;
}

// Simple VWAP deviation backtest with trailing stop
function backtest(candles, config) {
  const {
    name,
    devThreshold = 0.01,
    trailingStopPct = 0.01,
    emaFilter = 0,
    rsiFilterThreshold = 0,
    maxHoldMinutes = 480, // 5 days max
    exitAtEod = false,
  } = config;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const vwapData = vwap(highs, lows, closes, volumes);
  const emaData = emaFilter > 0 ? ema(closes, emaFilter) : null;
  const rsiData = rsiFilterThreshold > 0 ? rsi(closes, 14) : null;
  const atrData = atr(highs, lows, closes, 14);

  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  let highestSinceEntry = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const ctx = { i, candles, cash, btc, pos };

    if (!pos) {
      const meetsEma = !emaData || closes[i] > emaData[i];
      const meetsRsi = !rsiData || (rsiData[i] !== null && rsiData[i] < rsiFilterThreshold);
      const entryDev = (vwapData[i] - closes[i]) / vwapData[i];
      
      if (entryDev >= devThreshold && meetsEma && meetsRsi) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        entryPrice = buyPrice;
        entryIdx = i;
        highestSinceEntry = buyPrice;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, date: new Date(c.ts).toISOString().slice(0,16), dev: (entryDev*100).toFixed(2) });
      }
    } else {
      // Update trailing stop
      if (c.close > highestSinceEntry) highestSinceEntry = c.close;
      const trailingStop = highestSinceEntry * (1 - trailingStopPct);
      const holdMinutes = (c.ts - candles[entryIdx].ts) / 60000;
      const hitStop = trailingStopPct > 0 && c.close <= trailingStop;
      const timedOut = maxHoldMinutes > 0 && holdMinutes >= maxHoldMinutes;

      if (hitStop || timedOut) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0; pos = false;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, date: new Date(c.ts).toISOString().slice(0,16), reason: hitStop ? 'trail-stop' : 'timeout', holdMin: Math.round(holdMinutes) });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
      }
    }

    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalPrice = candles[candles.length - 1].close;
  const finalValue = cash + btc * finalPrice;
  if (pos) {
    const sellPrice = finalPrice * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
    trades.push({ action: 'CLOSE (EOD)', price: sellPrice, pnl, ts: candles[candles.length-1].ts, reason: 'end-of-data' });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }

  const totalReturn = (finalValue / INITIAL_BALANCE - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;

  return {
    name,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

async function main() {
  // Fetch multiple periods
  const periods = [
    { days: 30, label: 'Last 30 days (Mar-Apr 2026)' },
    { days: 60, label: 'Last 60 days (Feb-Apr 2026)' },
    { days: 90, label: 'Last 90 days (Jan-Apr 2026)' },
    { days: 180, label: 'Last 180 days (Oct 2025-Apr 2026)' },
  ];

  // Define strategy configs
  const strategies = [
    // VWAP with trailing stop variations
    { name: 'VWAP 1% dev + 1% trailing stop', devThreshold: 0.01, trailingStopPct: 0.01, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    { name: 'VWAP 1% dev + 0.5% trailing stop', devThreshold: 0.01, trailingStopPct: 0.005, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    { name: 'VWAP 1.5% dev + 1% trailing stop', devThreshold: 0.015, trailingStopPct: 0.01, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    { name: 'VWAP 2% dev + 1.5% trailing stop', devThreshold: 0.02, trailingStopPct: 0.015, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    { name: 'VWAP 1% dev + EMA50 filter', devThreshold: 0.01, trailingStopPct: 0.01, emaFilter: 50, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    { name: 'VWAP 1% dev + RSI40 filter', devThreshold: 0.01, trailingStopPct: 0.01, emaFilter: 0, rsiFilterThreshold: 40, maxHoldMinutes: 0 },
    { name: 'VWAP 1% dev + both filters', devThreshold: 0.01, trailingStopPct: 0.01, emaFilter: 50, rsiFilterThreshold: 40, maxHoldMinutes: 0 },
    { name: 'VWAP 1% dev + 0.5% TS + max 4h', devThreshold: 0.01, trailingStopPct: 0.005, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 240 },
    { name: 'VWAP 1% dev + max 24h hold', devThreshold: 0.01, trailingStopPct: 0.01, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 1440 },
    // More aggressive
    { name: 'VWAP 0.5% dev + 0.5% TS', devThreshold: 0.005, trailingStopPct: 0.005, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    { name: 'VWAP 0.8% dev + 0.3% TS', devThreshold: 0.008, trailingStopPct: 0.003, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    // Without trailing stop (original approach)
    { name: 'VWAP 1% dev + exit at VWAP', devThreshold: 0.01, trailingStopPct: 0, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
    { name: 'VWAP 2% dev + exit at VWAP', devThreshold: 0.02, trailingStopPct: 0, emaFilter: 0, rsiFilterThreshold: 0, maxHoldMinutes: 0 },
  ];

  console.log('\n' + '='.repeat(90));
  console.log(' MULTI-PERIOD VWAP TRAILING STOP BACKTEST | BTC/USDT 15m');
  console.log('='.repeat(90));

  const allResults = {};

  for (const period of periods) {
    console.log(`\n>> Loading ${period.label}...`);
    const candles = await fetchBinanceCandles('BTCUSDT', '15m', period.days);
    console.log(`   ${candles.length} candles | ${new Date(candles[0].ts).toISOString().slice(0,10)} → ${new Date(candles[candles.length-1].ts).toISOString().slice(0,10)}`);
    
    const startPrice = candles[0].close;
    const endPrice = candles[candles.length - 1].close;
    const marketReturn = ((endPrice / startPrice - 1) * 100).toFixed(1);
    console.log(`   Market return: ${marketReturn >= 0 ? '+' : ''}${marketReturn}%`);
    
    const periodResults = [];
    for (const strat of strategies) {
      const r = backtest(candles, strat);
      periodResults.push(r);
    }
    periodResults.sort((a, b) => b.totalReturn - a.totalReturn);
    allResults[period.label] = { candles: candles.length, marketReturn, results: periodResults };

    console.log(`\n ${period.label}`);
    console.log(' ' + '-'.repeat(75));
    console.log(` ${'Strategy'.padEnd(45)} ${'Return'.padEnd(8)} ${'Win%'.padEnd(6)} ${'PF'.padEnd(5)} ${'Trades'}`);
    console.log(' ' + '-'.repeat(75));
    periodResults.forEach(r => {
      const sign = r.totalReturn >= 0 ? '+' : '';
      const vs = (r.totalReturn - parseFloat(marketReturn)).toFixed(1);
      const vsSign = vs >= 0 ? '+' : '';
      console.log(` ${r.name.padEnd(45)} ${sign}${r.totalReturn.toFixed(1).padEnd(7)} ${r.winRate.toFixed(0).padEnd(5)}% ${r.profitFactor.toFixed(2).padEnd(5)} ${String(r.totalTrades).padEnd(6)} (vs market: ${vsSign}${vs}%)`);
    });
  }

  // Summary: which strategy was best across MOST periods?
  console.log('\n' + '='.repeat(90));
  console.log(' CROSS-PERIOD SUMMARY');
  console.log('='.repeat(90));
  
  // Count how many times each strategy was top-3
  const stratWins = {};
  for (const [periodLabel, data] of Object.entries(allResults)) {
    data.results.slice(0, 3).forEach((r, i) => {
      if (!stratWins[r.name]) stratWins[r.name] = { top3: 0, totalReturn: 0, periods: 0, best: false };
      stratWins[r.name].top3++;
      stratWins[r.name].totalReturn += r.totalReturn;
      stratWins[r.name].periods++;
      if (i === 0) stratWins[r.name].best = true;
    });
  }

  const ranked = Object.entries(stratWins)
    .map(([name, stats]) => ({ name, ...stats, avgReturn: stats.totalReturn / stats.periods }))
    .sort((a, b) => b.top3 - a.top3 || b.avgReturn - a.avgReturn);

  console.log(`\n ${'Strategy'.padEnd(45)} ${'Top 3'.padEnd(6)} ${'Avg Return'.padEnd(12)} ${'Best Overall'}`);
  console.log(' ' + '-'.repeat(75));
  ranked.slice(0, 10).forEach(s => {
    console.log(` ${s.name.padEnd(45)} ${String(s.top3).padEnd(6)}/${Object.keys(allResults).length} ${(s.avgReturn >= 0 ? '+' : '')+s.avgReturn.toFixed(1)+'%'.padEnd(11)} ${s.best ? 'YES' : ''}`);
  });

  // Save
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/multi-period-vwap.json', JSON.stringify(allResults, null, 2));
  console.log(`\nSaved to ./results/multi-period-vwap.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
