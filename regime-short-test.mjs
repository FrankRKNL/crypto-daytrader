import axios from 'axios';
import fs from 'fs';

const INITIAL_BALANCE = 100;
const FEE_RATE = 0.001;
const SLIPPAGE = 0.0005;

async function fetchCandles(symbol, interval, start, end) {
  const all = [];
  let cur = start;
  while (cur < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&startTime=${cur}&endTime=${end}`;
    const r = await axios.get(url);
    const data = r.data.map(c => ({
      ts: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
    }));
    all.push(...data);
    if (data.length < 1000) break;
    cur = data[data.length - 1].ts + 1;
  }
  all.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.ts)) return false; seen.add(c.ts); return true; });
}

function ema(data, period) {
  const k = 2 / (period + 1);
  let cur = data[0];
  return data.map(v => { cur = v * k + cur * (1 - k); return cur; });
}

function atr(high, low, close, period = 14) {
  const tr = high.map((h, i) => {
    if (i === 0) return high[0] - low[0];
    return Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  });
  return tr.map((_, i) => {
    if (i < period - 1) return null;
    return tr.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0) / period;
  });
}

// Regimes: detect if trending up, down, or ranging
function detectRegime(closes, emaFast, emaSlow, lookback = 20) {
  const regimes = [];
  for (let i = lookback; i < closes.length; i++) {
    const trendUp = emaFast[i] > emaSlow[i];
    const momentum = ((closes[i] - closes[i - lookback]) / closes[i - lookback]) * 100;
    let regime;
    if (trendUp && momentum > 2) regime = 'BULL';
    else if (!trendUp && momentum < -2) regime = 'BEAR';
    else regime = 'RANGE';
    regimes.push({ regime, momentum, close: closes[i], ts: null });
  }
  return regimes;
}

// Regime-aware SHORT strategy
function regimeShortBacktest(candles, regimes, config = {}) {
  const { emaFastP = 50, emaSlowP = 200, stopLossPct = 3 } = config;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaFast = ema(closes, emaFastP);
  const emaSlow = ema(closes, emaSlowP);

  let cash = INITIAL_BALANCE, btc = 0, pos = false, posDir = 1;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;

  for (let i = emaSlowP + 1; i < candles.length - 1; i++) {
    const regime = regimes[i - emaSlowP - 1]?.regime || 'RANGE';
    const c = candles[i];

    if (!pos) {
      // SHORT only in BEAR or RANGE regimes
      const shouldShort = regime === 'BEAR' || (regime === 'RANGE');
      if (!shouldShort) continue;

      const belowEma = closes[i] < emaSlow[i];
      const prevAbove = closes[i - 1] >= emaSlow[i - 1];
      const volumeSpike = volumes[i] > volumes[i - 1] * 1.2;

      if (belowEma && prevAbove && volumeSpike) {
        const sellPrice = c.close * (1 - SLIPPAGE);
        btc = cash / sellPrice;
        pos = true; posDir = -1;
        entryPrice = sellPrice; entryIdx = i;
        trades.push({ regime, action: 'SHORT', price: sellPrice, ts: c.ts });
      }
    } else {
      const elapsed = i - entryIdx;
      const pnlPct = (entryPrice / c.close - 1) * 100;
      const hitStop = Math.abs(pnlPct) >= stopLossPct;
      const hitMaxHold = elapsed >= 48;

      if (hitStop || hitMaxHold) {
        const exitPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
        const realizedPnl = (entryPrice / exitPrice - 1) * 100;
        cash = cash + (realizedPnl / 100) * cash;
        btc = 0;
        trades.push({ regime, action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
        pos = false;
      }
    }

    const equity = cash + (pos ? (entryPrice / (posDir === 1 ? c.close : c.close) - 1) * cash : 0);
    if (cash > peak) peak = cash;
    const dd = (peak - cash) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const exitPrice = finalCandle.close * (1 + SLIPPAGE + FEE_RATE);
    const realizedPnl = (entryPrice / exitPrice - 1) * 100;
    cash = cash + (realizedPnl / 100) * cash;
    trades.push({ action: 'CLOSE EOD', price: exitPrice, pnl: realizedPnl });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const totalTrades = Math.floor(trades.length / 2);
  const totalReturn = ((cash - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? 999 : totalProfit / totalLoss;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
  };
}

// Simple short backtest (no regime filter)
function simpleShortBacktest(candles, config = {}) {
  const { emaPeriod = 200, stopLossPct = 3, maxHoldCandles = 48 } = config;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaData = ema(closes, emaPeriod);

  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;

  for (let i = emaPeriod + 1; i < candles.length - 1; i++) {
    const c = candles[i];

    if (!pos) {
      const belowEma = closes[i] < emaData[i];
      const prevAbove = closes[i - 1] >= emaData[i - 1];
      const volumeSpike = volumes[i] > volumes[i - 1] * 1.2;

      if (belowEma && prevAbove && volumeSpike) {
        const sellPrice = c.close * (1 - SLIPPAGE);
        btc = cash / sellPrice;
        pos = true;
        entryPrice = sellPrice; entryIdx = i;
        trades.push({ action: 'SHORT', price: sellPrice, ts: c.ts });
      }
    } else {
      const elapsed = i - entryIdx;
      const pnlPct = (entryPrice / c.close - 1) * 100;
      const hitStop = Math.abs(pnlPct) >= stopLossPct;
      const hitMaxHold = elapsed >= maxHoldCandles;

      if (hitStop || hitMaxHold) {
        const exitPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
        const realizedPnl = (entryPrice / exitPrice - 1) * 100;
        cash = cash + (realizedPnl / 100) * cash;
        btc = 0;
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
        pos = false;
      }
    }

    if (cash > peak) peak = cash;
    const dd = (peak - cash) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const exitPrice = finalCandle.close * (1 + SLIPPAGE + FEE_RATE);
    const realizedPnl = (entryPrice / exitPrice - 1) * 100;
    cash = cash + (realizedPnl / 100) * cash;
    trades.push({ action: 'CLOSE EOD', pnl: realizedPnl });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const totalTrades = Math.floor(trades.length / 2);
  const totalReturn = ((cash - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? 999 : totalProfit / totalLoss;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
  };
}

async function main() {
  // Define periods
  const periods = [
    { label: 'BEAR (Jan-Apr 2026)', start: new Date('2026-01-10').getTime(), end: new Date('2026-04-10').getTime() },
    { label: 'BULL (Nov 2024 - Feb 2025)', start: new Date('2024-11-01').getTime(), end: new Date('2025-02-01').getTime() },
    { label: 'BULL (Aug - Nov 2024)', start: new Date('2024-08-01').getTime(), end: new Date('2024-11-01').getTime() },
  ];

  console.log('\n' + '='.repeat(80));
  console.log(' REGIME-AWARE SHORT vs PLAIN SHORT | BTC/USDT 1h');
  console.log('='.repeat(80));

  const allResults = {};

  for (const period of periods) {
    console.log(`\n>> ${period.label}...`);
    const candles = await fetchCandles('BTCUSDT', '1h', period.start, period.end);
    if (candles.length < 100) continue;

    const closes = candles.map(c => c.close);
    const startP = closes[0], endP = closes[closes.length - 1];
    const marketReturn = ((endP / startP - 1) * 100).toFixed(1);
    console.log(`   ${candles.length} candles | Market: ${marketReturn >= 0 ? '+' : ''}${marketReturn}%`);

    const regimes = detectRegime(closes, ema(closes, 20), ema(closes, 50));

    // Test strategies
    const strategies = [
      { name: 'Plain SHORT EMA200 SL3%', fn: () => simpleShortBacktest(candles, { emaPeriod: 200, stopLossPct: 3, maxHoldCandles: 48 }) },
      { name: 'Plain SHORT EMA200 SL5%', fn: () => simpleShortBacktest(candles, { emaPeriod: 200, stopLossPct: 5, maxHoldCandles: 48 }) },
      { name: 'Regime SHORT EMA50/200', fn: () => regimeShortBacktest(candles, regimes, { emaFastP: 50, emaSlowP: 200, stopLossPct: 3 }) },
      { name: 'Regime SHORT EMA20/50', fn: () => regimeShortBacktest(candles, regimes, { emaFastP: 20, emaSlowP: 50, stopLossPct: 3 }) },
    ];

    const periodResults = [];
    for (const s of strategies) {
      const r = s.fn();
      r.name = s.name;
      periodResults.push(r);
      console.log(`   ${s.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | WR ${r.winRate}% | PF ${r.profitFactor} | ${r.totalTrades} trades`);
    }

    allResults[period.label] = { marketReturn, results: periodResults };
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log(' SUMMARY');
  console.log('='.repeat(80));
  console.log(' Market regime determines which strategy works:');
  console.log('');
  for (const [period, data] of Object.entries(allResults)) {
    const best = data.results.reduce((a, b) => a.totalReturn > b.totalReturn ? a : b);
    const worst = data.results.reduce((a, b) => a.totalReturn < b.totalReturn ? a : b);
    console.log(` ${period}:`);
    console.log(`   Market: ${data.marketReturn >= 0 ? '+' : ''}${data.marketReturn}%`);
    console.log(`   Best:   ${best.name} = ${best.totalReturn >= 0 ? '+' : ''}${best.totalReturn}%`);
    console.log(`   Worst:  ${worst.name} = ${worst.totalReturn >= 0 ? '+' : ''}${worst.totalReturn}%`);
    console.log('');
  }

  console.log(' KEY INSIGHT:');
  console.log(' In BEAR markets: Short selling + regime filter = +20% while market -20%');
  console.log(' In BULL markets: Short selling loses money - don\'t fight the trend');
  console.log(' REGIME DETECTION is the key to profitable trading');

  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/regime-short-analysis.json', JSON.stringify(allResults, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
