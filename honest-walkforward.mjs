import axios from 'axios';
import fs from 'fs';

const INITIAL_BALANCE = 100;
const FEE_RATE = 0.001;

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
    if (data.length === 0) break;
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

// Detect market regime
function detectRegime(closes, emaFast, emaSlow, lookback = 20) {
  const regimes = [];
  for (let i = lookback; i < closes.length; i++) {
    const trendUp = emaFast[i] > emaSlow[i];
    const momentum = ((closes[i] - closes[i - lookback]) / closes[i - lookback]) * 100;
    let regime;
    if (trendUp && momentum > 3) regime = 'BULL';
    else if (!trendUp && momentum < -3) regime = 'BEAR';
    else regime = 'RANGE';
    regimes.push({ regime, momentum, close: closes[i], idx: i });
  }
  return regimes;
}

// STRATEGY A: Regime-Based (switch long/short based on regime)
function regimeBasedStrategy(candles, regimeData, config = {}) {
  const {
    emaPeriod = 100,
    stopLossPct = 5,
    maxHoldCandles = 48,
    riskReward = 2, // TP = stopLoss * riskReward
    slippage = 0.0005,
  } = config;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaData = ema(closes, emaPeriod);
  const atrData = atr(highs, lows, closes, 14);

  let cash = INITIAL_BALANCE, pos = 0, posDir = 0; // pos: 0=flat, 1=long, -1=short
  let btc = 0;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;

  for (let i = emaPeriod + 1; i < candles.length - 1; i++) {
    const regime = regimeData[i - emaPeriod - 1]?.regime || 'RANGE';
    const c = candles[i];
    const atrVal = atrData[i];

    if (pos === 0) {
      // Entry logic based on regime
      const belowEma = closes[i] < emaData[i];
      const prevAbove = closes[i - 1] >= emaData[i - 1];
      const volumeSpike = volumes[i] > volumes[i - 1] * 1.2;

      if (regime === 'BEAR' || regime === 'RANGE') {
        // SHORT when price crosses below EMA in bear/range
        if (belowEma && prevAbove && volumeSpike) {
          const sellPrice = c.close * (1 - slippage);
          btc = cash / sellPrice;
          cash = 0; pos = -1; posDir = -1;
          entryPrice = sellPrice; entryIdx = i;
          trades.push({ action: 'SHORT', price: sellPrice, ts: c.ts, regime });
        }
      }
      
      if (regime === 'BULL') {
        // LONG when price crosses above EMA in bull
        if (!belowEma && prevAbove && volumeSpike) {
          const buyPrice = c.close * (1 + slippage);
          btc = cash / buyPrice;
          cash = 0; pos = 1; posDir = 1;
          entryPrice = buyPrice; entryIdx = i;
          trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, regime });
        }
      }
    } else {
      // Exit logic
      const elapsed = i - entryIdx;
      const pnlPct = posDir === 1
        ? (c.close / entryPrice - 1) * 100
        : (entryPrice / c.close - 1) * 100;

      const hitStop = Math.abs(pnlPct) >= stopLossPct;
      const hitTP = pnlPct >= stopLossPct * riskReward;
      const hitMaxHold = elapsed >= maxHoldCandles;

      if (hitStop || hitTP || hitMaxHold) {
        const exitPrice = posDir === 1
          ? c.close * (1 - slippage - FEE_RATE)
          : c.close * (1 + slippage + FEE_RATE);
        const realizedPnl = posDir === 1
          ? (exitPrice / entryPrice - 1) * 100
          : (entryPrice / exitPrice - 1) * 100;
        cash = posDir === 1 ? btc * exitPrice * (1 - FEE_RATE) : btc * exitPrice * (1 - FEE_RATE);
        btc = 0; pos = 0;
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts, regime, reason: hitTP ? 'TP' : hitStop ? 'SL' : 'MAX' });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
      }
    }

    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Close open position
  const finalCandle = candles[candles.length - 1];
  if (pos !== 0) {
    const exitPrice = posDir === 1
      ? finalCandle.close * (1 - slippage - FEE_RATE)
      : finalCandle.close * (1 + slippage + FEE_RATE);
    const realizedPnl = posDir === 1
      ? (exitPrice / entryPrice - 1) * 100
      : (entryPrice / exitPrice - 1) * 100;
    cash = posDir === 1 ? btc * exitPrice * (1 - FEE_RATE) : btc * exitPrice * (1 - FEE_RATE);
    btc = 0;
    trades.push({ action: 'CLOSE EOD', price: exitPrice, pnl: realizedPnl });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const finalEquity = cash + btc * finalCandle.close;
  const totalReturn = ((finalEquity / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? 999 : totalProfit / totalLoss;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(2)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(2)) : 0,
    trades,
  };
}

// STRATEGY B: Long/Short Symmetric (same logic both directions)
function symmetricStrategy(candles, config = {}) {
  const {
    emaPeriod = 100,
    stopLossPct = 5,
    maxHoldCandles = 48,
    riskReward = 2,
    slippage = 0.0005,
  } = config;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaData = ema(closes, emaPeriod);

  let cash = INITIAL_BALANCE, btc = 0, pos = 0, posDir = 0;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;

  for (let i = emaPeriod + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const emaVal = emaData[i];

    if (pos === 0) {
      const crossUp = closes[i] > emaVal && closes[i - 1] <= emaData[i - 1];
      const crossDown = closes[i] < emaVal && closes[i - 1] >= emaData[i - 1];
      const volumeSpike = volumes[i] > volumes[i - 1] * 1.2;

      if (crossUp && volumeSpike) {
        const buyPrice = c.close * (1 + slippage);
        btc = cash / buyPrice;
        cash = 0; pos = 1; posDir = 1;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts });
      } else if (crossDown && volumeSpike) {
        const sellPrice = c.close * (1 - slippage);
        btc = cash / sellPrice;
        cash = 0; pos = -1; posDir = -1;
        entryPrice = sellPrice; entryIdx = i;
        trades.push({ action: 'SHORT', price: sellPrice, ts: c.ts });
      }
    } else {
      const elapsed = i - entryIdx;
      const pnlPct = posDir === 1
        ? (c.close / entryPrice - 1) * 100
        : (entryPrice / c.close - 1) * 100;

      const hitStop = Math.abs(pnlPct) >= stopLossPct;
      const hitTP = pnlPct >= stopLossPct * riskReward;
      const hitMaxHold = elapsed >= maxHoldCandles;

      if (hitStop || hitTP || hitMaxHold) {
        const exitPrice = posDir === 1
          ? c.close * (1 - slippage - FEE_RATE)
          : c.close * (1 + slippage + FEE_RATE);
        const realizedPnl = posDir === 1
          ? (exitPrice / entryPrice - 1) * 100
          : (entryPrice / exitPrice - 1) * 100;
        cash = btc * exitPrice * (1 - FEE_RATE);
        btc = 0; pos = 0;
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts, reason: hitTP ? 'TP' : hitStop ? 'SL' : 'MAX' });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
      }
    }

    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalCandle = candles[candles.length - 1];
  if (pos !== 0) {
    const exitPrice = posDir === 1
      ? finalCandle.close * (1 - slippage - FEE_RATE)
      : finalCandle.close * (1 + slippage + FEE_RATE);
    const realizedPnl = posDir === 1
      ? (exitPrice / entryPrice - 1) * 100
      : (entryPrice / exitPrice - 1) * 100;
    cash = btc * exitPrice * (1 - FEE_RATE);
    trades.push({ action: 'CLOSE EOD', price: exitPrice, pnl: realizedPnl });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const finalEquity = cash + btc * finalCandle.close;
  const totalReturn = ((finalEquity / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? 999 : totalProfit / totalLoss;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(2)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(2)) : 0,
  };
}

// STRATEGY C: Long Only Benchmark (price > EMA200)
function longOnlyBenchmark(candles, config = {}) {
  const {
    emaPeriod = 200,
    stopLossPct = 10,
    maxHoldCandles = 168, // 1 week
    slippage = 0.0005,
  } = config;

  const closes = candles.map(c => c.close);
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
      const aboveEma = closes[i] > emaData[i];
      const prevBelow = closes[i - 1] <= emaData[i - 1];
      const volumeSpike = volumes[i] > volumes[i - 1] * 1.1;

      if (aboveEma && prevBelow && volumeSpike) {
        const buyPrice = c.close * (1 + slippage);
        btc = cash / buyPrice;
        cash = 0; pos = true;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts });
      }
    } else {
      const elapsed = i - entryIdx;
      const pnlPct = (c.close / entryPrice - 1) * 100;
      const hitStop = pnlPct <= -stopLossPct;
      const hitMaxHold = elapsed >= maxHoldCandles;

      if (hitStop || hitMaxHold) {
        const sellPrice = c.close * (1 - slippage - FEE_RATE);
        const realizedPnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE);
        btc = 0; pos = false;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl: realizedPnl, ts: c.ts, reason: hitStop ? 'SL' : 'MAX' });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
      }
    }

    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const sellPrice = finalCandle.close * (1 - slippage - FEE_RATE);
    const realizedPnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE);
    trades.push({ action: 'CLOSE EOD', price: sellPrice, pnl: realizedPnl });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const finalEquity = cash + btc * finalCandle.close;
  const totalReturn = ((finalEquity / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? 999 : totalProfit / totalLoss;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(2)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(2)) : 0,
  };
}

// Buy & Hold benchmark
function buyHold(candles) {
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const ret = ((endPrice / startPrice - 1) * 100);
  return { totalReturn: parseFloat(ret.toFixed(2)), totalTrades: 1 };
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log(' HONEST QUANT RESEARCH - WALK-FORWARD VALIDATION');
  console.log(' Testing 3 strategy classes across strict train/test splits');
  console.log('='.repeat(80));

  // Define strict walk-forward periods
  const periods = [
    { trainEnd: new Date('2022-12-31').getTime(), testStart: new Date('2023-01-01').getTime(), testEnd: new Date('2023-12-31').getTime() },
    { trainEnd: new Date('2023-12-31').getTime(), testStart: new Date('2024-01-01').getTime(), testEnd: new Date('2024-12-31').getTime() },
    { trainEnd: new Date('2024-12-31').getTime(), testStart: new Date('2025-01-01').getTime(), testEnd: new Date('2026-04-10').getTime() },
  ];

  const allResults = [];

  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    console.log(`\n\n=== ${symbol} ===`);

    // Fetch full dataset
    const allStart = new Date('2020-01-01').getTime();
    const allEnd = new Date('2026-04-10').getTime();
    console.log('Loading data...');
    const allCandles = await fetchCandles(symbol, '1h', allStart, allEnd);
    console.log(`Total: ${allCandles.length} candles`);

    for (const period of periods) {
      // Split data
      const trainCandles = allCandles.filter(c => c.ts <= period.trainEnd);
      const testCandles = allCandles.filter(c => c.ts >= period.testStart && c.ts <= period.testEnd);

      if (trainCandles.length < 1000 || testCandles.length < 500) continue;

      const trainStartPrice = trainCandles[0].close;
      const trainEndPrice = trainCandles[trainCandles.length - 1].close;
      const testStartPrice = testCandles[0].close;
      const testEndPrice = testCandles[testCandles.length - 1].close;

      const trainMarket = ((trainEndPrice / trainStartPrice - 1) * 100).toFixed(1);
      const testMarket = ((testEndPrice / testStartPrice - 1) * 100).toFixed(1);

      const periodName = `${new Date(period.testStart).getFullYear()}`;
      console.log(`\n--- ${periodName} | Train: ${trainCandles.length} | Test: ${testCandles.length} ---`);
      console.log(`Train market: ${trainMarket >= 0 ? '+' : ''}${trainMarket}% | Test market: ${testMarket >= 0 ? '+' : ''}${testMarket}%`);

      // Get regimes for test period
      const testCloses = testCandles.map(c => c.close);
      const testEma50 = ema(testCloses, 50);
      const testEma200 = ema(testCloses, 200);
      const testRegimes = detectRegime(testCloses, testEma50, testEma200);

      // Test Strategy A: Regime-Based
      const stratA = regimeBasedStrategy(testCandles, testRegimes, {
        emaPeriod: 100, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, slippage: 0.0005
      });
      const vsMarketA = (stratA.totalReturn - parseFloat(testMarket)).toFixed(1);
      console.log(`\nA. Regime-Based:    ${stratA.totalReturn >= 0 ? '+' : ''}${stratA.totalReturn}% | vs M: ${vsMarketA >= 0 ? '+' : ''}${vsMarketA}% | WR: ${stratA.winRate}% | PF: ${stratA.profitFactor} | Trades: ${stratA.totalTrades} | MaxDD: ${stratA.maxDrawdown}%`);

      // Test Strategy B: Symmetric Long/Short
      const stratB = symmetricStrategy(testCandles, {
        emaPeriod: 100, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, slippage: 0.0005
      });
      const vsMarketB = (stratB.totalReturn - parseFloat(testMarket)).toFixed(1);
      console.log(`B. Symmetric L/S:  ${stratB.totalReturn >= 0 ? '+' : ''}${stratB.totalReturn}% | vs M: ${vsMarketB >= 0 ? '+' : ''}${vsMarketB}% | WR: ${stratB.winRate}% | PF: ${stratB.profitFactor} | Trades: ${stratB.totalTrades} | MaxDD: ${stratB.maxDrawdown}%`);

      // Test Strategy C: Long Only Benchmark
      const stratC = longOnlyBenchmark(testCandles, {
        emaPeriod: 200, stopLossPct: 10, maxHoldCandles: 168, slippage: 0.0005
      });
      const vsMarketC = (stratC.totalReturn - parseFloat(testMarket)).toFixed(1);
      console.log(`C. Long Only:      ${stratC.totalReturn >= 0 ? '+' : ''}${stratC.totalReturn}% | vs M: ${vsMarketC >= 0 ? '+' : ''}${vsMarketC}% | WR: ${stratC.winRate}% | PF: ${stratC.profitFactor} | Trades: ${stratC.totalTrades} | MaxDD: ${stratC.maxDrawdown}%`);

      // Buy & Hold
      const bnh = buyHold(testCandles);
      console.log(`D. Buy & Hold:     ${bnh.totalReturn >= 0 ? '+' : ''}${bnh.totalReturn}%`);

      allResults.push({
        symbol, period: periodName,
        market: testMarket,
        regimeA: { ...stratA, vsMarket: parseFloat(vsMarketA) },
        regimeB: { ...stratB, vsMarket: parseFloat(vsMarketB) },
        regimeC: { ...stratC, vsMarket: parseFloat(vsMarketC) },
        bnh: bnh.totalReturn,
      });
    }
  }

  // Summary
  console.log('\n\n' + '='.repeat(80));
  console.log(' HONEST SUMMARY - OUT-OF-SAMPLE RESULTS');
  console.log('='.repeat(80));

  // Per strategy
  const stratNames = ['regimeA', 'regimeB', 'regimeC'];
  const stratLabels = ['A. Regime-Based', 'B. Symmetric L/S', 'C. Long Only'];

  for (let s = 0; s < 3; s++) {
    const name = stratNames[s];
    const label = stratLabels[s];
    const results = allResults.map(r => r[name]);
    
    const avgReturn = results.reduce((a, r) => a + r.totalReturn, 0) / results.length;
    const avgVsM = results.reduce((a, r) => a + r.vsMarket, 0) / results.length;
    const avgMaxDD = results.reduce((a, r) => a + r.maxDrawdown, 0) / results.length;
    const avgWinRate = results.reduce((a, r) => a + r.winRate, 0) / results.length;
    const avgPF = results.reduce((a, r) => a + r.profitFactor, 0) / results.length;
    const beatMarket = results.filter(r => r.vsMarket > 0).length;
    const totalTrades = results.reduce((a, r) => a + r.totalTrades, 0);

    console.log(`\n${label}:`);
    console.log(`  Avg Return:   ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(1)}%`);
    console.log(`  Avg vs M:     ${avgVsM >= 0 ? '+' : ''}${avgVsM.toFixed(1)}%`);
    console.log(`  Avg MaxDD:    ${avgMaxDD.toFixed(1)}%`);
    console.log(`  Avg WinRate:  ${avgWinRate.toFixed(0)}%`);
    console.log(`  Avg PF:       ${avgPF.toFixed(2)}`);
    console.log(`  Beat Market:  ${beatMarket}/${results.length} (${((beatMarket/results.length)*100).toFixed(0)}%)`);
    console.log(`  Total Trades: ${totalTrades}`);
  }

  // Per period
  console.log('\n--- Per Period ---');
  allResults.forEach(r => {
    console.log(`\n${r.symbol} ${r.period} (market: ${r.market >= 0 ? '+' : ''}${r.market}%):`);
    console.log(`  A: ${r.regimeA.totalReturn >= 0 ? '+' : ''}${r.regimeA.totalReturn}% (vs M: ${r.regimeA.vsMarket >= 0 ? '+' : ''}${r.regimeA.vsMarket}%) | Trades: ${r.regimeA.totalTrades}`);
    console.log(`  B: ${r.regimeB.totalReturn >= 0 ? '+' : ''}${r.regimeB.totalReturn}% (vs M: ${r.regimeB.vsMarket >= 0 ? '+' : ''}${r.regimeB.vsMarket}%) | Trades: ${r.regimeB.totalTrades}`);
    console.log(`  C: ${r.regimeC.totalReturn >= 0 ? '+' : ''}${r.regimeC.totalReturn}% (vs M: ${r.regimeC.vsMarket >= 0 ? '+' : ''}${r.regimeC.vsMarket}%) | Trades: ${r.regimeC.totalTrades}`);
  });

  // Final verdict
  console.log('\n' + '='.repeat(80));
  console.log(' VERDICT');
  console.log('='.repeat(80));

  const bestStrategy = stratNames.map((name, i) => ({
    name: stratLabels[i],
    avgVsM: allResults.reduce((a, r) => a + r[name].vsMarket, 0) / allResults.length
  })).sort((a, b) => b.avgVsM - a.avgVsM)[0];

  console.log(`\nBest strategy: ${bestStrategy.name} (avg vs market: ${bestStrategy.avgVsM >= 0 ? '+' : ''}${bestStrategy.avgVsM.toFixed(1)}%)`);

  if (bestStrategy.avgVsM > 0) {
    console.log('\n>>> SOMETHING WORKS <<<');
  } else {
    console.log('\n>>> NOTHING WORKS - all strategies fail to beat buy & hold out-of-sample <<<');
    console.log('\nKey insight: Crypto markets are extremely efficient.');
    console.log('Any simple EMA-based strategy is likely to be arbitraged away.');
    console.log('Real edge would require: microstructure analysis, fund flow data, or novel signals.');
  }

  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/honest-walkforward.json', JSON.stringify(allResults, null, 2));
  console.log(`\nSaved to ./results/honest-walkforward.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
