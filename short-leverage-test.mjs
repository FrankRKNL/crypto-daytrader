import axios from 'axios';
import fs from 'fs';

const INITIAL_BALANCE = 100;
const FEE_RATE = 0.001;
const SLIPPAGE = 0.0005;

async function fetchBinanceCandles(symbol = 'BTCUSDT', interval = '1h', days = 90) {
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

function vwap(highs, lows, closes, volumes) {
  let cumVP = 0, cumV = 0;
  return closes.map((c, i) => {
    const typical = (highs[i] + lows[i] + c) / 3;
    cumVP += typical * volumes[i]; cumV += volumes[i];
    return cumV === 0 ? c : cumVP / cumV;
  });
}

// ============================================================
// SHORT SELLING + LEVERAGE BACKTEST
// ============================================================
// config: { direction: 'long'|'short'|'both', leverage: 1-10, useStopLoss: bool }
function leverageBacktest(candles, config = {}) {
  const {
    direction = 'long',
    leverage = 1,
    useStopLoss = true,
    stopLossPct = 2,
    takeProfitPct = 0,
    emaPeriod = 50,
    atrMultiplier = 2,
    minHoldCandles = 1,
    maxHoldCandles = 24,
  } = config;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaData = ema(closes, emaPeriod);
  const atrData = atr(highs, lows, closes, 14);

  let cash = INITIAL_BALANCE, btc = 0, pos = false, posDir = 1; // posDir: 1=long, -1=short
  const trades = [];
  let peak = cash * leverage, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;

  for (let i = emaPeriod + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const atrVal = atrData[i];

    if (!pos) {
      const aboveEma = closes[i] > emaData[i];
      const prevBelow = closes[i-1] <= emaData[i-1];
      const volumeSpike = volumes[i] > volumes[i-1] * 1.3;

      // Determine direction
      let shouldLong = direction === 'long' || direction === 'both';
      let shouldShort = direction === 'short' || direction === 'both';

      // Entry signals
      const longSignal = shouldLong && aboveEma && prevBelow && volumeSpike;
      const shortSignal = shouldShort && !aboveEma && prevBelow && !volumeSpike;

      if (longSignal) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = (cash * leverage) / buyPrice;
        cash = cash - (cash * leverage - cash) / leverage; // Keep 1x equity
        pos = true; posDir = 1;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, lev: leverage, ts: c.ts });
      } else if (shortSignal) {
        const sellPrice = c.close * (1 - SLIPPAGE);
        btc = (cash * leverage) / sellPrice;
        pos = true; posDir = -1;
        entryPrice = sellPrice; entryIdx = i;
        trades.push({ action: 'SHORT', price: sellPrice, lev: leverage, ts: c.ts });
      }
    } else {
      const elapsed = i - entryIdx;
      if (elapsed < minHoldCandles) continue;

      const pnlPct = posDir === 1
        ? (c.close / entryPrice - 1) * 100 * leverage
        : (entryPrice / c.close - 1) * 100 * leverage;

      // Stop loss
      const hitStop = useStopLoss && Math.abs(pnlPct) >= stopLossPct * leverage;
      // Take profit
      const hitTP = takeProfitPct > 0 && Math.abs(pnlPct) >= takeProfitPct * leverage;
      // Max hold
      const hitMaxHold = elapsed >= maxHoldCandles;

      if (hitStop || hitTP || hitMaxHold) {
        const exitPrice = posDir === 1
          ? c.close * (1 - SLIPPAGE - FEE_RATE)
          : c.close * (1 + SLIPPAGE + FEE_RATE);
        const realizedPnl = posDir === 1
          ? (exitPrice / entryPrice - 1) * 100 * leverage
          : (entryPrice / exitPrice - 1) * 100 * leverage;

        // Calculate actual cash change
        const pnlCash = (realizedPnl / 100) * cash;
        cash += pnlCash;
        btc = 0;
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts, reason: hitStop ? 'SL' : hitTP ? 'TP' : 'MAX' });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
        pos = false;
      }
    }

    const value = cash + btc * c.close - (pos ? (btc * leverage - btc) * c.close : 0);
    const equity = cash + (pos ? btc * (posDir === 1 ? c.close : entryPrice) : 0);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const exitPrice = posDir === 1
      ? finalCandle.close * (1 - SLIPPAGE - FEE_RATE)
      : finalCandle.close * (1 + SLIPPAGE + FEE_RATE);
    const realizedPnl = posDir === 1
      ? (exitPrice / entryPrice - 1) * 100 * leverage
      : (entryPrice / exitPrice - 1) * 100 * leverage;
    const pnlCash = (realizedPnl / 100) * cash;
    cash += pnlCash;
    trades.push({ action: 'CLOSE EOD', price: exitPrice, pnl: realizedPnl, ts: finalCandle.ts });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const totalTrades = Math.floor(trades.length / 2);
  const finalReturn = ((cash - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;

  return {
    name: `${direction.toUpperCase()} ${leverage}x EMA${emaPeriod} SL${stopLossPct}%`,
    totalReturn: parseFloat(finalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(2)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(2)) : 0,
  };
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log(' SHORT SELLING + LEVERAGE BACKTEST | BTC/USDT 1h | Jan-Apr 2026');
  console.log (' Bear market: BTC dropped from ~73K to ~61K (-16%)');
  console.log('='.repeat(80));

  // Bear market period
  const candles = await fetchBinanceCandles('BTCUSDT', '1h', 90);
  console.log(`\nLoaded ${candles.length} candles`);
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const marketReturn = ((endPrice / startPrice - 1) * 100).toFixed(1);
  console.log(`Market return: ${marketReturn}% (start: $${startPrice.toFixed(0)}, end: $${endPrice.toFixed(0)})`);

  const results = [];

  // 1. SHORT STRATEGIES (no leverage)
  console.log('\n--- SHORT STRATEGIES (1x leverage) ---');
  const shorts = [
    { direction: 'short', leverage: 1, emaPeriod: 50, stopLossPct: 2, maxHoldCandles: 24 },
    { direction: 'short', leverage: 1, emaPeriod: 20, stopLossPct: 3, maxHoldCandles: 12 },
    { direction: 'short', leverage: 1, emaPeriod: 50, stopLossPct: 5, maxHoldCandles: 48 },
    { direction: 'short', leverage: 1, emaPeriod: 20, stopLossPct: 2, maxHoldCandles: 6 },
  ];
  for (const cfg of shorts) {
    const r = leverageBacktest(candles, cfg);
    console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | WR ${r.winRate}% | PF ${r.profitFactor} | ${r.totalTrades} trades`);
    results.push(r);
  }

  // 2. SHORT + LEVERAGE
  console.log('\n--- SHORT + LEVERAGE (best short config) ---');
  const leveraged = [
    { direction: 'short', leverage: 2, emaPeriod: 50, stopLossPct: 2, maxHoldCandles: 24 },
    { direction: 'short', leverage: 3, emaPeriod: 50, stopLossPct: 2, maxHoldCandles: 24 },
    { direction: 'short', leverage: 5, emaPeriod: 50, stopLossPct: 1, maxHoldCandles: 24 },
    { direction: 'short', leverage: 10, emaPeriod: 50, stopLossPct: 0.5, maxHoldCandles: 24 },
  ];
  for (const cfg of leveraged) {
    const r = leverageBacktest(candles, cfg);
    console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | WR ${r.winRate}% | PF ${r.profitFactor} | ${r.totalTrades} trades | DD ${r.maxDrawdown}%`);
    results.push(r);
  }

  // 3. BOTH LONG + SHORT with leverage
  console.log('\n--- BOTH LONG + SHORT with leverage ---');
  const both = [
    { direction: 'both', leverage: 1, emaPeriod: 50, stopLossPct: 2, maxHoldCandles: 24 },
    { direction: 'both', leverage: 2, emaPeriod: 50, stopLossPct: 2, maxHoldCandles: 24 },
    { direction: 'both', leverage: 3, emaPeriod: 50, stopLossPct: 3, maxHoldCandles: 24 },
  ];
  for (const cfg of both) {
    const r = leverageBacktest(candles, cfg);
    console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | WR ${r.winRate}% | PF ${r.profitFactor} | ${r.totalTrades} trades`);
    results.push(r);
  }

  // 4. VWAP DEVIATION + SHORT
  console.log('\n--- VWAP SHORT (no EMA filter) ---');
  const vwapShorts = [
    { direction: 'short', leverage: 1, emaPeriod: 200, stopLossPct: 3, maxHoldCandles: 48 },
    { direction: 'short', leverage: 2, emaPeriod: 200, stopLossPct: 2, maxHoldCandles: 48 },
  ];
  for (const cfg of vwapShorts) {
    const r = leverageBacktest(candles, cfg);
    console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | WR ${r.winRate}% | PF ${r.profitFactor} | ${r.totalTrades} trades`);
    results.push(r);
  }

  // Sort results
  console.log('\n' + '='.repeat(80));
  console.log(' ALL RESULTS RANKED');
  console.log('='.repeat(80));
  results.sort((a, b) => b.totalReturn - a.totalReturn);
  console.log(` ${'Strategy'.padEnd(45)} ${'Return'.padEnd(10)} ${'Win%'.padEnd(7)} ${'PF'.padEnd(7)} ${'Trades'}`);
  console.log('-'.repeat(75));
  results.forEach((r, i) => {
    const s = r.totalReturn >= 0 ? '+' : '';
    const marker = i === 0 ? '>>> ' : '    ';
    console.log(`${marker}${r.name.padEnd(41)} ${s}${r.totalReturn.toFixed(1).padEnd(9)} ${r.winRate.toFixed(0).padEnd(6)}% ${r.profitFactor.toFixed(2).padEnd(7)} ${r.totalTrades}`);
  });

  console.log(`\nMarket return: ${marketReturn}%`);
  
  // Find profitable strategies
  const profitable = results.filter(r => r.totalReturn > 0);
  if (profitable.length > 0) {
    console.log(`\n${profitable.length} STRATEGIES BEAT THE MARKET!`);
    console.log('Best:', profitable[0].name, 'with', profitable[0].totalReturn + '%');
  } else {
    console.log('\nNO strategy beat the market in this bear period.');
  }

  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/short-leverage-results.json', JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
