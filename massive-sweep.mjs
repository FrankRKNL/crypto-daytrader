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

// FULL PARAMETER SWEEP
function shortStrategy(candles, config = {}) {
  const { emaPeriod = 200, stopLossPct = 5, maxHoldCandles = 48, volMultiplier = 1.2, regime = 'ANY' } = config;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaData = ema(closes, emaPeriod);
  
  // Regime detection
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const regimes = [];
  for (let i = 50; i < closes.length; i++) {
    const trendUp = ema20[i] > ema50[i];
    const momentum = ((closes[i] - closes[i - 20]) / closes[i - 20]) * 100;
    let r;
    if (trendUp && momentum > 2) r = 'BULL';
    else if (!trendUp && momentum < -2) r = 'BEAR';
    else r = 'RANGE';
    regimes.push(r);
  }

  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;

  for (let i = emaPeriod + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const regimeIdx = i - emaPeriod - 1;
    const currentRegime = regimes[regimeIdx] || 'RANGE';
    
    // Regime filter
    if (regime !== 'ANY' && regime !== currentRegime) {
      if (pos) {
        // Close position if regime changes
        const exitPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
        const realizedPnl = (entryPrice / exitPrice - 1) * 100;
        cash = cash + (realizedPnl / 100) * cash;
        btc = 0; pos = false;
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
      }
      continue;
    }

    if (!pos) {
      const belowEma = closes[i] < emaData[i];
      const prevAbove = closes[i - 1] >= emaData[i - 1];
      const volumeSpike = volumes[i] > volumes[i - 1] * volMultiplier;

      if (belowEma && prevAbove && volumeSpike) {
        const sellPrice = c.close * (1 - SLIPPAGE);
        btc = cash / sellPrice;
        pos = true;
        entryPrice = sellPrice; entryIdx = i;
        trades.push({ action: 'SHORT', price: sellPrice, ts: c.ts, regime: currentRegime });
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
        btc = 0; pos = false;
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts, reason: hitStop ? 'SL' : 'MAX', regime: currentRegime });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
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
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const totalTrades = Math.floor(trades.length / 2);
  const totalReturn = ((cash - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
  };
}

async function testAll(symbol, periodLabel, start, end) {
  const candles = await fetchCandles(symbol, '1h', start, end);
  if (candles.length < 500) return null;

  const closes = candles.map(c => c.close);
  const startP = closes[0], endP = closes[closes.length - 1];
  const marketReturn = ((endP / startP - 1) * 100);

  // Generate all parameter combinations
  const emaPeriods = [20, 50, 100, 150, 200];
  const stopLosses = [2, 3, 5, 7, 10];
  const maxHolds = [6, 12, 24, 48, 72];
  const volMults = [1.1, 1.2, 1.5, 2.0];
  const regimes = ['ANY', 'BEAR', 'RANGE'];

  const results = [];
  
  for (const emaP of emaPeriods) {
    for (const sl of stopLosses) {
      for (const mh of maxHolds) {
        for (const vm of volMults) {
          for (const reg of regimes) {
            if (reg !== 'ANY' && reg !== 'BEAR' && reg !== 'RANGE') continue;
            // Skip impossible combos
            if (emaP <= 50 && reg !== 'ANY') continue; // Need enough data for regime detection
            
            const r = shortStrategy(candles, {
              emaPeriod: emaP,
              stopLossPct: sl,
              maxHoldCandles: mh,
              volMultiplier: vm,
              regime: reg
            });
            
            r.config = { emaPeriod: emaP, stopLossPct: sl, maxHoldCandles: mh, volMultiplier: vm, regime: reg };
            r.marketReturn = parseFloat(marketReturn.toFixed(2));
            r.vsMarket = parseFloat((r.totalReturn - marketReturn).toFixed(2));
            results.push(r);
          }
        }
      }
    }
  }

  return { symbol, periodLabel, marketReturn: parseFloat(marketReturn.toFixed(2)), candles: candles.length, results };
}

async function main() {
  console.log('\n' + '='.repeat(85));
  console.log(' MASSIVE PARAMETER SWEEP - 1000+ BACKTESTS');
  console.log (' Short Strategy: All parameter combinations across multiple assets/periods');
  console.log('='.repeat(85));

  // Define periods and assets
  const testCases = [
    { symbol: 'BTCUSDT', label: 'BTC 2026 BEAR', start: new Date('2026-01-10').getTime(), end: new Date('2026-04-10').getTime() },
    { symbol: 'BTCUSDT', label: 'BTC 2024-25 BULL', start: new Date('2024-11-01').getTime(), end: new Date('2025-02-01').getTime() },
    { symbol: 'BTCUSDT', label: 'BTC 2022 BEAR', start: new Date('2022-05-01').getTime(), end: new Date('2022-09-01').getTime() },
    { symbol: 'ETHUSDT', label: 'ETH 2026 BEAR', start: new Date('2026-01-10').getTime(), end: new Date('2026-04-10').getTime() },
    { symbol: 'ETHUSDT', label: 'ETH 2022 BEAR', start: new Date('2022-05-01').getTime(), end: new Date('2022-09-01').getTime() },
    { symbol: 'BNBUSDT', label: 'BNB 2026 BEAR', start: new Date('2026-01-10').getTime(), end: new Date('2026-04-10').getTime() },
    { symbol: 'BTCUSDT', label: 'BTC 2020 COVID', start: new Date('2020-02-15').getTime(), end: new Date('2020-05-15').getTime() },
  ];

  const allResults = [];
  let totalTests = 0;

  for (const tc of testCases) {
    console.log(`\n>> ${tc.label}...`);
    const result = await testAll(tc.symbol, tc.label, tc.start, tc.end);
    if (result) {
      totalTests += result.results.length;
      console.log(`   ${result.results.length} tests | Market: ${result.marketReturn}%`);
      allResults.push(result);
      
      // Find best config for this test case
      const sorted = [...result.results].sort((a, b) => b.totalReturn - a.totalReturn);
      const best = sorted[0];
      console.log(`   BEST: EMA${best.config.emaPeriod} SL${best.config.stopLossPct}% MH${best.config.maxHoldCandles} VM${best.config.volMultiplier} Reg${best.config.regime} = ${best.totalReturn}% (vs M: ${best.vsMarket >= 0 ? '+' : ''}${best.vsMarket}%)`);
    }
  }

  // Aggregate analysis
  console.log('\n' + '='.repeat(85));
  console.log(` AGGREGATE RESULTS (${totalTests} TOTAL TESTS)`);
  console.log('='.repeat(85));

  // Combine all results
  const combined = allResults.flatMap(r => r.results);
  
  // Filter: must have at least 3 trades
  const validResults = combined.filter(r => r.totalTrades >= 3);
  console.log(`\nValid tests (3+ trades): ${validResults.length}`);
  
  // Sort by vsMarket (outperformance)
  validResults.sort((a, b) => b.vsMarket - a.vsMarket);
  
  // Top 10 overall
  console.log('\n TOP 10 PARAMETER COMBINATIONS (by outperformance):');
  console.log(` ${'EMA'.padEnd(5)} ${'SL%'.padEnd(6)} ${'MH'.padEnd(5)} ${'VM'.padEnd(5)} ${'Reg'.padEnd(7)} ${'Return'.padEnd(8)} ${'vs M'.padEnd(8)} ${'WR%'.padEnd(6)} ${'Trades'}`);
  console.log('-'.repeat(70));
  validResults.slice(0, 10).forEach(r => {
    const c = r.config;
    console.log(` ${String(c.emaPeriod).padEnd(5)} ${String(c.stopLossPct).padEnd(6)} ${String(c.maxHoldCandles).padEnd(5)} ${String(c.volMultiplier).padEnd(5)} ${String(c.regime).padEnd(7)} ${(r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1).padEnd(7)} ${(r.vsMarket >= 0 ? '+' : '') + r.vsMarket.toFixed(1).padEnd(7)} ${r.winRate.toFixed(0).padEnd(5)}% ${r.totalTrades}`);
  });

  // Bottom 10
  console.log('\n BOTTOM 10 (worst parameter combinations):');
  console.log('-'.repeat(70));
  validResults.slice(-10).forEach(r => {
    const c = r.config;
    console.log(` ${String(c.emaPeriod).padEnd(5)} ${String(c.stopLossPct).padEnd(6)} ${String(c.maxHoldCandles).padEnd(5)} ${String(c.volMultiplier).padEnd(5)} ${String(c.regime).padEnd(7)} ${(r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1).padEnd(7)} ${(r.vsMarket >= 0 ? '+' : '') + r.vsMarket.toFixed(1).padEnd(7)} ${r.winRate.toFixed(0).padEnd(5)}% ${r.totalTrades}`);
  });

  // Analyze which parameters matter most
  console.log('\n' + '='.repeat(85));
  console.log(' PARAMETER IMPORTANCE ANALYSIS');
  console.log('='.repeat(85));

  const paramAnalysis = {};
  
  // EMA Period analysis
  paramAnalysis.ema = {};
  [20, 50, 100, 150, 200].forEach(emaP => {
    const subset = validResults.filter(r => r.config.emaPeriod === emaP);
    if (subset.length > 0) {
      const avgReturn = subset.reduce((a, r) => a + r.totalReturn, 0) / subset.length;
      const avgVsMarket = subset.reduce((a, r) => a + r.vsMarket, 0) / subset.length;
      paramAnalysis.ema[emaP] = { avgReturn, avgVsMarket, count: subset.length };
    }
  });
  
  // Stop-loss analysis
  paramAnalysis.sl = {};
  [2, 3, 5, 7, 10].forEach(sl => {
    const subset = validResults.filter(r => r.config.stopLossPct === sl);
    if (subset.length > 0) {
      const avgReturn = subset.reduce((a, r) => a + r.totalReturn, 0) / subset.length;
      const avgVsMarket = subset.reduce((a, r) => a + r.vsMarket, 0) / subset.length;
      paramAnalysis.sl[sl] = { avgReturn, avgVsMarket, count: subset.length };
    }
  });
  
  // Regime filter analysis
  paramAnalysis.regime = {};
  ['ANY', 'BEAR', 'RANGE'].forEach(reg => {
    const subset = validResults.filter(r => r.config.regime === reg);
    if (subset.length > 0) {
      const avgReturn = subset.reduce((a, r) => a + r.totalReturn, 0) / subset.length;
      const avgVsMarket = subset.reduce((a, r) => a + r.vsMarket, 0) / subset.length;
      paramAnalysis.regime[reg] = { avgReturn, avgVsMarket, count: subset.length };
    }
  });

  console.log('\n EMA PERIOD EFFECT:');
  console.log(` ${'EMA'.padEnd(6)} ${'Avg Return'.padEnd(12)} ${'Avg vs M'.padEnd(12)} ${'Count'}`);
  console.log('-'.repeat(45));
  Object.entries(paramAnalysis.ema).sort((a, b) => b[1].avgVsMarket - a[1].avgVsMarket).forEach(([k, v]) => {
    console.log(` ${k.padEnd(6)} ${(v.avgReturn >= 0 ? '+' : '') + v.avgReturn.toFixed(1).padEnd(11)} ${(v.avgVsMarket >= 0 ? '+' : '') + v.avgVsMarket.toFixed(1).padEnd(11)} ${v.count}`);
  });

  console.log('\n STOP-LOSS EFFECT:');
  console.log(` ${'SL%'.padEnd(6)} ${'Avg Return'.padEnd(12)} ${'Avg vs M'.padEnd(12)} ${'Count'}`);
  console.log('-'.repeat(45));
  Object.entries(paramAnalysis.sl).sort((a, b) => b[1].avgVsMarket - a[1].avgVsMarket).forEach(([k, v]) => {
    console.log(` ${k.padEnd(6)} ${(v.avgReturn >= 0 ? '+' : '') + v.avgReturn.toFixed(1).padEnd(11)} ${(v.avgVsMarket >= 0 ? '+' : '') + v.avgVsMarket.toFixed(1).padEnd(11)} ${v.count}`);
  });

  console.log('\n REGIME FILTER EFFECT:');
  console.log(` ${'Regime'.padEnd(8)} ${'Avg Return'.padEnd(12)} ${'Avg vs M'.padEnd(12)} ${'Count'}`);
  console.log('-'.repeat(45));
  Object.entries(paramAnalysis.regime).sort((a, b) => b[1].avgVsMarket - a[1].avgVsMarket).forEach(([k, v]) => {
    console.log(` ${k.padEnd(8)} ${(v.avgReturn >= 0 ? '+' : '') + v.avgReturn.toFixed(1).padEnd(11)} ${(v.avgVsMarket >= 0 ? '+' : '') + v.avgVsMarket.toFixed(1).padEnd(11)} ${v.count}`);
  });

  // Find optimal config
  const optimal = validResults.sort((a, b) => b.vsMarket - a.vsMarket)[0];
  console.log('\n' + '='.repeat(85));
  console.log(' OPTIMAL CONFIGURATION');
  console.log('='.repeat(85));
  console.log(` EMA Period:    ${optimal.config.emaPeriod}`);
  console.log(` Stop Loss:     ${optimal.config.stopLossPct}%`);
  console.log(` Max Hold:      ${optimal.config.maxHoldCandles} hours`);
  console.log(` Vol Mult:      ${optimal.config.volMultiplier}x`);
  console.log(` Regime Filter: ${optimal.config.regime}`);
  console.log(` Return:        ${optimal.totalReturn >= 0 ? '+' : ''}${optimal.totalReturn}%`);
  console.log(` vs Market:     ${optimal.vsMarket >= 0 ? '+' : ''}${optimal.vsMarket}%`);
  console.log(` Win Rate:      ${optimal.winRate}%`);
  console.log(` Trades:        ${optimal.totalTrades}`);
  console.log(` Profit Factor: ${optimal.profitFactor}`);

  // Count how many tests beat the market
  const beatMarket = validResults.filter(r => r.vsMarket > 0).length;
  const pctBeat = ((beatMarket / validResults.length) * 100).toFixed(1);
  console.log(`\n Tests that beat market: ${beatMarket}/${validResults.length} (${pctBeat}%)`);

  // Save
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/massive-sweep.json', JSON.stringify(allResults, null, 2));
  fs.writeFileSync('./results/param-analysis.json', JSON.stringify(paramAnalysis, null, 2));
  console.log(`\nSaved to ./results/massive-sweep.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
