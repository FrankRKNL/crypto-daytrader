/**
 * PORTFOLIO ALLOCATION RESEARCH
 * Continuous backtest with compounding (2020-2026)
 * Focus: Long-term growth with risk control
 */

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
      ts: c[0],
      close: parseFloat(c[4]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      volume: parseFloat(c[5]),
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

// Simulate equity curve with compounding
function simulateEquity(candles, initialBalance, onTrade) {
  let balance = initialBalance;
  const equityCurve = [{ ts: candles[0].ts, equity: balance }];
  
  for (let i = 0; i < candles.length - 1; i++) {
    const c = candles[i];
    const nextClose = candles[i + 1].close;
    
    // Calculate daily return
    const dailyReturn = (nextClose / c.close - 1);
    balance = balance * (1 + dailyReturn);
    
    if (onTrade) onTrade(i, balance, c.ts);
    
    equityCurve.push({ ts: c.ts, equity: balance });
  }
  
  return equityCurve;
}

// Strategy 1: Buy & Hold BTC
function btcBuyHold(candles) {
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  
  let equity = INITIAL_BALANCE;
  const curve = [{ ts: candles[0].ts, equity: INITIAL_BALANCE }];
  
  for (let i = 0; i < candles.length - 1; i++) {
    equity = equity * (candles[i + 1].close / candles[i].close);
    curve.push({ ts: candles[i].ts, equity });
  }
  
  const peak = curve.reduce((p, c) => Math.max(p, c.equity), 0);
  const maxDD = curve.reduce((m, c) => Math.max(m, (peak - c.equity) / peak * 100), 0);
  
  return {
    name: 'BTC B&H',
    finalEquity: equity,
    totalReturn: ((equity / INITIAL_BALANCE - 1) * 100),
    maxDrawdown: maxDD,
    curve,
  };
}

// Strategy 2: Equal Weight Portfolio (all 5 assets)
function equalWeightPortfolio(allCandles) {
  const assets = Object.keys(allCandles);
  const weight = 1 / assets.length;
  
  let equity = INITIAL_BALANCE;
  const curve = [{ ts: allCandles.BTCUSDT[0].ts, equity: INITIAL_BALANCE }];
  
  // Find common timeframe
  const startTs = Math.max(...assets.map(a => allCandles[a][0].ts));
  const endTs = Math.min(...assets.map(a => allCandles[a][allCandles[a].length - 1].ts));
  
  for (const asset of assets) {
    allCandles[asset] = allCandles[asset].filter(c => c.ts >= startTs && c.ts <= endTs);
  }
  
  const len = Math.min(...assets.map(a => allCandles[a].length));
  
  for (let i = 0; i < len - 1; i++) {
    let dailyReturn = 0;
    for (const asset of assets) {
      const ret = (allCandles[asset][i + 1].close / allCandles[asset][i].close - 1);
      dailyReturn += weight * ret;
    }
    equity = equity * (1 + dailyReturn);
    curve.push({ ts: allCandles.BTCUSDT[i].ts, equity });
  }
  
  const peak = curve.reduce((p, c) => Math.max(p, c.equity), 0);
  const maxDD = curve.reduce((m, c) => Math.max(m, (peak - c.equity) / peak * 100), 0);
  
  return {
    name: 'Equal Weight 5',
    finalEquity: equity,
    totalReturn: ((equity / INITIAL_BALANCE - 1) * 100),
    maxDrawdown: maxDD,
    curve,
  };
}

// Strategy 3: Momentum Rotation (top performer gets 100%)
function momentumRotation(allCandles, lookback = 30) {
  const assets = Object.keys(allCandles);
  
  // Find common timeframe
  const startTs = Math.max(...assets.map(a => allCandles[a][0].ts));
  const endTs = Math.min(...assets.map(a => allCandles[a][allCandles[a].length - 1].ts));
  
  const filtered = {};
  for (const asset of assets) {
    filtered[asset] = allCandles[asset].filter(c => c.ts >= startTs && c.ts <= endTs);
  }
  const len = Math.min(...assets.map(a => filtered[a].length));
  
  let equity = INITIAL_BALANCE;
  const curve = [{ ts: filtered.BTCUSDT[0].ts, equity: INITIAL_BALANCE }];
  let currentBest = 'BTCUSDT';
  let daysSinceSwitch = 0;
  
  for (let i = lookback; i < len - 1; i++) {
    // Calculate momentum for each asset
    const momentums = {};
    for (const asset of assets) {
      if (filtered[asset][i] && filtered[asset][i - lookback]) {
        momentums[asset] = filtered[asset][i].close / filtered[asset][i - lookback].close - 1;
      }
    }
    
    // Switch if new best
    const best = Object.entries(momentums).sort((a, b) => b[1] - a[1])[0];
    if (best && best[0] !== currentBest) {
      currentBest = best[0];
      daysSinceSwitch = 0;
    }
    daysSinceSwitch++;
    
    // Apply return of current best asset
    if (filtered[currentBest][i + 1]) {
      const ret = (filtered[currentBest][i + 1].close / filtered[currentBest][i].close - 1);
      equity = equity * (1 + ret);
    }
    
    curve.push({ ts: filtered.BTCUSDT[i].ts, equity });
  }
  
  const peak = curve.reduce((p, c) => Math.max(p, c.equity), 0);
  const maxDD = curve.reduce((m, c) => Math.max(m, (peak - c.equity) / peak * 100), 0);
  
  return {
    name: `Momentum Top1 L${lookback}`,
    finalEquity: equity,
    totalReturn: ((equity / INITIAL_BALANCE - 1) * 100),
    maxDrawdown: maxDD,
    curve,
  };
}

// Strategy 4: Momentum with Cash (top 1, or cash if negative)
function momentumWithCash(allCandles, lookback = 30) {
  const assets = Object.keys(allCandles);
  
  const startTs = Math.max(...assets.map(a => allCandles[a][0].ts));
  const endTs = Math.min(...assets.map(a => allCandles[a][allCandles[a].length - 1].ts));
  
  const filtered = {};
  for (const asset of assets) {
    filtered[asset] = allCandles[asset].filter(c => c.ts >= startTs && c.ts <= endTs);
  }
  const len = Math.min(...assets.map(a => filtered[a].length));
  
  let equity = INITIAL_BALANCE;
  const curve = [{ ts: filtered.BTCUSDT[0].ts, equity: INITIAL_BALANCE }];
  let inCash = true;
  let currentBest = 'BTCUSDT';
  
  for (let i = lookback; i < len - 1; i++) {
    const momentums = {};
    for (const asset of assets) {
      if (filtered[asset][i] && filtered[asset][i - lookback]) {
        momentums[asset] = filtered[asset][i].close / filtered[asset][i - lookback].close - 1;
      }
    }
    
    const best = Object.entries(momentums).sort((a, b) => b[1] - a[1])[0];
    
    if (best && best[1] > 0) {
      currentBest = best[0];
      inCash = false;
    } else {
      inCash = true;
    }
    
    if (!inCash && filtered[currentBest][i + 1]) {
      const ret = (filtered[currentBest][i + 1].close / filtered[currentBest][i].close - 1);
      equity = equity * (1 + ret);
    }
    // In cash: equity stays same
    
    curve.push({ ts: filtered.BTCUSDT[i].ts, equity });
  }
  
  const peak = curve.reduce((p, c) => Math.max(p, c.equity), 0);
  const maxDD = curve.reduce((m, c) => Math.max(m, (peak - c.equity) / peak * 100), 0);
  
  return {
    name: `Momentum+Cash L${lookback}`,
    finalEquity: equity,
    totalReturn: ((equity / INITIAL_BALANCE - 1) * 100),
    maxDrawdown: maxDD,
    curve,
  };
}

// Strategy 5: Volatility Targetting (reduce exposure when vol is high)
function volatilityTargeting(candles, targetVol = 0.02, lookback = 20) {
  const returns = [];
  
  let equity = INITIAL_BALANCE;
  const curve = [{ ts: candles[0].ts, equity: INITIAL_BALANCE }];
  
  for (let i = 1; i < candles.length - 1; i++) {
    returns.push(Math.log(candles[i].close / candles[i - 1].close));
    
    if (returns.length >= lookback) {
      const recentReturns = returns.slice(-lookback);
      const mean = recentReturns.reduce((a, r) => a + r, 0) / lookback;
      const variance = recentReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / lookback;
      const vol = Math.sqrt(variance);
      
      // Scale exposure based on volatility
      const scale = targetVol / vol;
      const cappedScale = Math.min(2, Math.max(0.25, scale)); // 25% to 200%
      
      const ret = Math.log(candles[i + 1].close / candles[i].close);
      equity = equity * (1 + cappedScale * ret);
    }
    
    curve.push({ ts: candles[i].ts, equity });
  }
  
  const peak = curve.reduce((p, c) => Math.max(p, c.equity), 0);
  const maxDD = curve.reduce((m, c) => Math.max(m, (peak - c.equity) / peak * 100), 0);
  
  return {
    name: `Vol Target ${targetVol}`,
    finalEquity: equity,
    totalReturn: ((equity / INITIAL_BALANCE - 1) * 100),
    maxDrawdown: maxDD,
    curve,
  };
}

// Strategy 6: Trailing Stop B&H
function trailingStopBH(candles, trailPct = 0.1) {
  let equity = INITIAL_BALANCE;
  let peak = INITIAL_BALANCE;
  let pos = true;
  const curve = [{ ts: candles[0].ts, equity: INITIAL_BALANCE }];
  
  for (let i = 0; i < candles.length - 1; i++) {
    const ret = candles[i + 1].close / candles[i].close - 1;
    equity = equity * (1 + ret);
    
    if (equity > peak) peak = equity;
    
    // Trail stop
    if (pos && equity < peak * (1 - trailPct)) {
      pos = false;
      equity = peak * (1 - trailPct); // Exit at stop
    }
    
    curve.push({ ts: candles[i].ts, equity });
  }
  
  const peak2 = curve.reduce((p, c) => Math.max(p, c.equity), 0);
  const maxDD = curve.reduce((m, c) => Math.max(m, (peak2 - c.equity) / peak2 * 100), 0);
  
  return {
    name: `Trail Stop ${(trailPct * 100).toFixed(0)}%`,
    finalEquity: equity,
    totalReturn: ((equity / INITIAL_BALANCE - 1) * 100),
    maxDrawdown: maxDD,
    curve,
  };
}

// Strategy 7: DCA (Dollar Cost Averaging)
function dca(candles, amount = 10, frequency = 'weekly') {
  let equity = INITIAL_BALANCE;
  let btc = 0;
  let lastBuy = -1;
  const interval = frequency === 'weekly' ? 7 * 24 : 30 * 24; // hours
  
  const curve = [{ ts: candles[0].ts, equity: INITIAL_BALANCE }];
  
  for (let i = 0; i < candles.length - 1; i++) {
    const hoursSinceStart = (candles[i].ts - candles[0].ts) / (1000 * 60 * 60);
    
    // DCA buy
    if (hoursSinceStart - lastBuy >= interval) {
      btc += amount / candles[i].close;
      lastBuy = hoursSinceStart;
    }
    
    equity = btc * candles[i + 1].close;
    curve.push({ ts: candles[i].ts, equity });
  }
  
  const peak = curve.reduce((p, c) => Math.max(p, c.equity), 0);
  const maxDD = curve.reduce((m, c) => Math.max(m, (peak - c.equity) / peak * 100), 0);
  
  return {
    name: `DCA ${frequency}`,
    finalEquity: equity,
    totalReturn: ((equity / INITIAL_BALANCE - 1) * 100),
    maxDrawdown: maxDD,
    curve,
  };
}

// Calculate metrics
function calcMetrics(result) {
  const returns = [];
  for (let i = 1; i < result.curve.length; i++) {
    returns.push(result.curve[i].equity / result.curve[i - 1].equity - 1);
  }
  
  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance * 365); // Annualized
  
  const years = (result.curve[result.curve.length - 1].ts - result.curve[0].ts) / (1000 * 60 * 60 * 24 * 365);
  const cagr = (Math.pow(result.finalEquity / INITIAL_BALANCE, 1 / years) - 1) * 100;
  
  const sharpe = vol > 0 ? (mean / variance * 365 - 0) / vol : 0;
  
  // Ulcer index (drawdown from peak)
  let peak = result.curve[0].equity;
  let ulcerSum = 0;
  for (const c of result.curve) {
    if (c.equity > peak) peak = c.equity;
    const dd = (peak - c.equity) / peak;
    ulcerSum += dd * dd;
  }
  const ulcer = Math.sqrt(ulcerSum / result.curve.length) * 100;
  
  return {
    cagr: parseFloat(cagr.toFixed(2)),
    sharpe: parseFloat(sharpe.toFixed(2)),
    volatility: parseFloat((vol * 100).toFixed(2)),
    ulcer: parseFloat(ulcer.toFixed(2)),
  };
}

async function main() {
  console.log('\n' + '='.repeat(85));
  console.log(' PORTFOLIO ALLOCATION RESEARCH');
  console.log(' Continuous Backtest 2020-2026 | Compounding | €100 Start');
  console.log('='.repeat(85));
  
  const assets = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
  const allCandles = {};
  
  // Fetch all data
  console.log('\nFetching data for all assets...');
  const start = new Date('2020-01-01').getTime();
  const end = new Date('2026-04-10').getTime();
  
  for (const symbol of assets) {
    console.log(`  ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, '1d', start, end);
    console.log(`    ${allCandles[symbol].length} candles`);
  }
  
  console.log('\n' + '='.repeat(85));
  console.log(' RESULTS: €100 Initial → 2026 (Continuous Compounding)');
  console.log('='.repeat(85));
  
  const strategies = [
    // B&H variants
    () => btcBuyHold(allCandles.BTCUSDT),
    
    // Equal weight
    () => equalWeightPortfolio(allCandles),
    
    // Momentum rotation (various lookbacks)
    () => momentumRotation(allCandles, 7),
    () => momentumRotation(allCandles, 14),
    () => momentumRotation(allCandles, 30),
    () => momentumRotation(allCandles, 60),
    
    // Momentum with cash
    () => momentumWithCash(allCandles, 7),
    () => momentumWithCash(allCandles, 14),
    () => momentumWithCash(allCandles, 30),
    () => momentumWithCash(allCandles, 60),
    
    // Volatility targeting
    () => volatilityTargeting(allCandles.BTCUSDT, 0.01),
    () => volatilityTargeting(allCandles.BTCUSDT, 0.02),
    () => volatilityTargeting(allCandles.BTCUSDT, 0.03),
    
    // Trailing stop
    () => trailingStopBH(allCandles.BTCUSDT, 0.05),
    () => trailingStopBH(allCandles.BTCUSDT, 0.10),
    () => trailingStopBH(allCandles.BTCUSDT, 0.20),
    
    // DCA
    () => dca(allCandles.BTCUSDT, 10, 'weekly'),
    () => dca(allCandles.BTCUSDT, 10, 'monthly'),
  ];
  
  const results = [];
  
  for (const strat of strategies) {
    const r = strat();
    const metrics = calcMetrics(r);
    results.push({
      name: r.name,
      finalEquity: r.finalEquity,
      totalReturn: r.totalReturn,
      maxDrawdown: r.maxDrawdown,
      ...metrics,
      curve: r.curve,
    });
  }
  
  // Sort by total return
  results.sort((a, b) => b.totalReturn - a.totalReturn);
  
  console.log('\n ' + 'Strategy'.padEnd(22) + 'Final €'.padEnd(12) + 'Return%'.padEnd(10) + 'CAGR%'.padEnd(10) + 'MaxDD%'.padEnd(10) + 'Sharpe'.padEnd(8) + 'Vol%'.padEnd(8) + 'Ulcer');
  console.log(' ' + '-'.repeat(90));
  
  for (const r of results) {
    console.log(' ' + r.name.padEnd(22) + r.finalEquity.toFixed(2).padEnd(12) + (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1).padEnd(9) + (r.cagr >= 0 ? '+' : '') + r.cagr.toFixed(1).padEnd(9) + r.maxDrawdown.toFixed(1).padEnd(9) + r.sharpe.toFixed(2).padEnd(8) + r.volatility.toFixed(1).padEnd(8) + r.ulcer.toFixed(2));
  }
  
  // Equity curves output
  console.log('\n' + '='.repeat(85));
  console.log(' EQUITY CURVES (€100 start)');
  console.log('='.repeat(85));
  
  // Simple ASCII chart
  const chartHeight = 20;
  const chartWidth = 60;
  
  for (const r of results.slice(0, 8)) { // Top 8
    const minE = Math.min(...r.curve.map(c => c.equity));
    const maxE = Math.max(...r.curve.map(c => c.equity));
    const range = maxE - minE || 1;
    
    // Sample points for chart
    const step = Math.floor(r.curve.length / chartWidth);
    const chars = [];
    
    for (let i = 0; i < chartWidth; i++) {
      const idx = Math.min(i * step, r.curve.length - 1);
      const e = r.curve[idx].equity;
      const height = Math.floor(((e - minE) / range) * (chartHeight - 1));
      chars.push(String.fromCharCode(65 + height)); // A = bottom, T = top
    }
    
    console.log('\n ' + r.name);
    console.log(' ' + String.fromCharCode(84).repeat(chartWidth)); // Top
    for (let h = chartHeight - 2; h >= 0; h--) {
      let line = ' ';
      for (let i = 0; i < chartWidth; i++) {
        const idx = Math.min(i * step, r.curve.length - 1);
        const e = r.curve[idx].equity;
        const height = Math.floor(((e - minE) / range) * (chartHeight - 1));
        line += height >= h ? String.fromCharCode(65 + height) : ' ';
      }
      console.log(line);
    }
    console.log(' ' + String.fromCharCode(65).repeat(chartWidth)); // Bottom
    
    const finalE = r.curve[r.curve.length - 1].equity;
    const startE = r.curve[0].equity;
    console.log(`  ${startE.toFixed(0)} → ${finalE.toFixed(0)} (${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(0)}%)`);
  }
  
  // Key insights
  console.log('\n' + '='.repeat(85));
  console.log(' KEY INSIGHTS');
  console.log('='.repeat(85));
  
  const btc = results.find(r => r.name === 'BTC B&H');
  const best = results[0];
  const safest = results.reduce((a, b) => a.maxDrawdown < b.maxDrawdown ? a : b);
  const bestSharpe = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
  
  console.log(`\n BTC Buy & Hold: €${btc.finalEquity.toFixed(2)} | ${btc.totalReturn >= 0 ? '+' : ''}${btc.totalReturn.toFixed(0)}% | MaxDD ${btc.maxDrawdown.toFixed(0)}% | Sharpe ${btc.sharpe}`);
  console.log(`\n Best Return: ${best.name}`);
  console.log(`   €${best.finalEquity.toFixed(2)} | ${best.totalReturn >= 0 ? '+' : ''}${best.totalReturn.toFixed(0)}% | MaxDD ${best.maxDrawdown.toFixed(0)}%`);
  console.log(`\n Lowest Drawdown: ${safest.name}`);
  console.log(`   MaxDD ${safest.maxDrawdown.toFixed(0)}% | Return ${safest.totalReturn >= 0 ? '+' : ''}${safest.totalReturn.toFixed(0)}%`);
  console.log(`\n Best Risk-Adjusted (Sharpe): ${bestSharpe.name}`);
  console.log(`   Sharpe ${bestSharpe.sharpe} | Return ${bestSharpe.totalReturn >= 0 ? '+' : ''}${bestSharpe.totalReturn.toFixed(0)}%`);
  
  // Monte Carlo: What if we started at different dates?
  console.log('\n' + '='.repeat(85));
  console.log(' MONTE CARLO: Random Start Date Analysis');
  console.log('='.repeat(85));
  
  const btcCandles = allCandles.BTCUSDT;
  const years = 2; // Min period length
  const minIdx = Math.floor(years * 365);
  const maxIdx = btcCandles.length - minIdx;
  
  const trials = 50;
  const btcReturns = [];
  const momReturns = [];
  const momCashReturns = [];
  
  for (let t = 0; t < trials; t++) {
    const startIdx = Math.floor(Math.random() * (maxIdx - minIdx)) + minIdx;
    const endIdx = Math.min(startIdx + minIdx, btcCandles.length - 1);
    
    if (endIdx - startIdx < minIdx) continue;
    
    // BTC B&H
    const btcStart = btcCandles[startIdx].close;
    const btcEnd = btcCandles[endIdx].close;
    btcReturns.push((btcEnd / btcStart - 1) * 100);
    
    // Momentum 30
    const mom = momentumRotation(allCandles, 30);
    const momStartVal = mom.curve.find(c => c.ts >= btcCandles[startIdx].ts);
    const momEndVal = mom.curve.find(c => c.ts >= btcCandles[endIdx].ts);
    if (momStartVal && momEndVal) {
      momReturns.push((momEndVal.equity / momStartVal.equity - 1) * 100);
    }
    
    // Momentum + Cash 30
    const momCash = momentumWithCash(allCandles, 30);
    const mcStartVal = momCash.curve.find(c => c.ts >= btcCandles[startIdx].ts);
    const mcEndVal = momCash.curve.find(c => c.ts >= btcCandles[endIdx].ts);
    if (mcStartVal && mcEndVal) {
      momCashReturns.push((mcEndVal.equity / mcStartVal.equity - 1) * 100);
    }
  }
  
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const pct = (arr, p) => { const s = arr.sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
  
  console.log(`\n ${'Strategy'.padEnd(20)} ${'Avg'.padEnd(10)} ${'5th%'.padEnd(10)} ${'50th%'.padEnd(10)} ${'95th%'.padEnd(10)}`);
  console.log(' ' + '-'.repeat(60));
  console.log(' ' + 'BTC B&H'.padEnd(20) + avg(btcReturns).toFixed(1).padEnd(10) + pct(btcReturns, 0.05).toFixed(1).padEnd(10) + pct(btcReturns, 0.5).toFixed(1).padEnd(10) + pct(btcReturns, 0.95).toFixed(1));
  console.log(' ' + 'Momentum Top1'.padEnd(20) + avg(momReturns).toFixed(1).padEnd(10) + pct(momReturns, 0.05).toFixed(1).padEnd(10) + pct(momReturns, 0.5).toFixed(1).padEnd(10) + pct(momReturns, 0.95).toFixed(1));
  console.log(' ' + 'Momentum+Cash'.padEnd(20) + avg(momCashReturns).toFixed(1).padEnd(10) + pct(momCashReturns, 0.05).toFixed(1).padEnd(10) + pct(momCashReturns, 0.5).toFixed(1).padEnd(10) + pct(momCashReturns, 0.95).toFixed(1));
  
  // Save results
  fs.mkdirSync('./results', { recursive: true });
  
  // Save summary (without curves for JSON size)
  const summary = results.map(r => {
    const { curve, ...rest } = r;
    return rest;
  });
  fs.writeFileSync('./results/portfolio-research.json', JSON.stringify(summary, null, 2));
  
  // Save equity curves separately
  const curvesData = results.map(r => ({
    name: r.name,
    curve: r.curve.map(c => ({ ts: c.ts, equity: parseFloat(c.equity.toFixed(4)) })),
  }));
  fs.writeFileSync('./results/portfolio-equity-curves.json', JSON.stringify(curvesData, null, 2));
  
  console.log('\n' + '='.repeat(85));
  console.log(' VERDICT');
  console.log('='.repeat(85));
  
  const beatBtc = results.filter(r => r.totalReturn > btc.totalReturn);
  const lowerDD = results.filter(r => r.maxDrawdown < btc.maxDrawdown);
  const betterSharpe = results.filter(r => r.sharpe > btc.sharpe);
  
  console.log(`\n BTC B&H: €${btc.finalEquity.toFixed(2)} | ${btc.totalReturn >= 0 ? '+' : ''}${btc.totalReturn.toFixed(0)}% | Sharpe ${btc.sharpe}`);
  console.log(`\n Strategies that BEAT BTC return: ${beatBtc.length}/${results.length}`);
  beatBtc.forEach(r => console.log(`   ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(0)}%`));
  console.log(`\n Strategies with LOWER drawdown than BTC: ${lowerDD.length}/${results.length}`);
  lowerDD.forEach(r => console.log(`   ${r.name}: ${r.maxDrawdown.toFixed(0)}% DD`));
  console.log(`\n Strategies with BETTER Sharpe than BTC: ${betterSharpe.length}/${results.length}`);
  betterSharpe.forEach(r => console.log(`   ${r.name}: Sharpe ${r.sharpe}`));
  
  console.log('\n Saved to ./results/portfolio-research.json and ./results/portfolio-equity-curves.json');
}

main().catch(e => { console.error(e.message); process.exit(1); });
