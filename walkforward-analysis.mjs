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

// Full strategy backtest with equity curve
function backtest(candles, config = {}) {
  const {
    emaPeriod = 100,
    stopLossPct = 10,
    maxHoldCandles = 72,
    volMultiplier = 1.1,
    trendFilter = true, // EMA50 < EMA200确认 downtrend
    trailingStop = true,
    trailingAtrMultiplier = 2,
  } = config;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaData = ema(closes, emaPeriod);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const atrData = atr(highs, lows, closes, 14);

  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  let highestSinceEntry = 0;
  
  // Equity curve for Sharpe/Sortino
  const equityCurve = [INITIAL_BALANCE];

  for (let i = Math.max(emaPeriod + 1, 201); i < candles.length - 1; i++) {
    const c = candles[i];
    const atrVal = atrData[i];
    
    // Update equity
    const currentEquity = cash + (pos ? btc * c.close : 0);
    equityCurve.push(currentEquity);
    
    // Update peak and drawdown
    if (currentEquity > peak) peak = currentEquity;
    const dd = (peak - currentEquity) / peak;
    if (dd > maxDD) maxDD = dd;

    if (!pos) {
      // Trend filter: want EMA50 < EMA200 for downtrend
      const downtrend = !trendFilter || (ema50[i] < ema200[i]);
      
      const belowEma = closes[i] < emaData[i];
      const prevAbove = closes[i - 1] >= emaData[i - 1];
      const volumeSpike = volumes[i] > volumes[i - 1] * volMultiplier;

      if (belowEma && prevAbove && volumeSpike && downtrend) {
        const sellPrice = c.close * (1 - SLIPPAGE);
        btc = cash / sellPrice;
        cash = 0; pos = true;
        entryPrice = sellPrice; entryIdx = i;
        highestSinceEntry = sellPrice;
        trades.push({ action: 'SHORT', price: sellPrice, ts: c.ts, regime: 'DOWN' });
      }
    } else {
      // Update trailing stop
      if (trailingStop && atrVal) {
        highestSinceEntry = Math.max(highestSinceEntry, c.close);
        const trailStop = highestSinceEntry * (1 - trailingAtrMultiplier * atrVal / highestSinceEntry);
        if (c.close >= trailStop && c.close > entryPrice) {
          highestSinceEntry = c.close;
        }
      }
      
      const elapsed = i - entryIdx;
      const pnlPct = (entryPrice / c.close - 1) * 100;
      
      // Stop loss OR trailing stop OR max hold
      const hitStop = Math.abs(pnlPct) >= stopLossPct;
      const hitTrail = trailingStop && atrVal && c.close <= (highestSinceEntry * (1 - trailingAtrMultiplier * atrVal / highestSinceEntry)) && c.close < entryPrice;
      const hitMaxHold = elapsed >= maxHoldCandles;

      if (hitStop || hitTrail || hitMaxHold) {
        const exitPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
        const realizedPnl = (entryPrice / exitPrice - 1) * 100;
        cash = cash + (realizedPnl / 100) * cash;
        btc = 0; pos = false;
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts, reason: hitStop ? 'SL' : hitTrail ? 'TRAIL' : 'MAX' });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
      }
    }
  }

  // Close open position
  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const exitPrice = finalCandle.close * (1 + SLIPPAGE + FEE_RATE);
    const realizedPnl = (entryPrice / exitPrice - 1) * 100;
    cash = cash + (realizedPnl / 100) * cash;
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }
  
  // Final equity
  const finalEquity = cash;
  equityCurve.push(finalEquity);

  // Calculate metrics
  const totalReturn = ((finalEquity - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  const avgWin = wins > 0 ? totalProfit / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;

  // Calculate Sharpe, Sortino, max drawdown properly
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const ret = (equityCurve[i] - equityCurve[i-1]) / equityCurve[i-1];
    returns.push(ret);
  }
  
  // Daily returns (assuming 1h candles, 24 per day)
  const dailyReturns = [];
  for (let i = 24; i < returns.length; i += 24) {
    const dayRet = returns.slice(i - 24, i).reduce((a, b) => a + b, 0);
    dailyReturns.push(dayRet);
  }
  
  // Annualize (assuming 365 days)
  const avgDailyReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdDailyReturn = Math.sqrt(dailyReturns.reduce((a, b) => a + (b - avgDailyReturn) ** 2, 0) / dailyReturns.length);
  const sharpe = stdDailyReturn > 0 ? (avgDailyReturn / stdDailyReturn) * Math.sqrt(365) : 0;
  
  // Sortino (downside deviation)
  const negativeReturns = dailyReturns.filter(r => r < 0);
  const downsideDev = Math.sqrt(negativeReturns.reduce((a, b) => a + b ** 2, 0) / negativeReturns.length);
  const sortino = downsideDev > 0 ? (avgDailyReturn / downsideDev) * Math.sqrt(365) : 0;

  // Max consecutive losses
  let maxConsecLoss = 0, currentConsecLoss = 0;
  trades.forEach(t => {
    if (t.action === 'CLOSE') {
      if (t.pnl < 0) { currentConsecLoss++; maxConsecLoss = Math.max(maxConsecLoss, currentConsecLoss); }
      else currentConsecLoss = 0;
    }
  });

  return {
    config,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    sharpe: parseFloat(sharpe.toFixed(2)),
    sortino: parseFloat(sortino.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    wins, losses,
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    maxConsecLoss,
    equityCurve: equityCurve.slice(-100), // Last 100 for viz
  };
}

// Walk-forward analysis
async function walkForwardTest(symbol) {
  console.log(`\n=== WALK-FORWARD ANALYSIS: ${symbol} ===`);
  
  // Define periods
  const trainStart = new Date('2020-01-01').getTime();
  const trainEnd = new Date('2022-12-31').getTime();
  const test1Start = new Date('2023-01-01').getTime();
  const test1End = new Date('2023-12-31').getTime();
  const test2Start = new Date('2024-01-01').getTime();
  const test2End = new Date('2025-06-30').getTime();
  const test3Start = new Date('2025-07-01').getTime();
  const test3End = new Date('2026-04-10').getTime();

  // Fetch all data
  console.log('Loading data...');
  const allCandles = await fetchCandles(symbol, '1h', trainStart, test3End);
  console.log(`Total candles: ${allCandles.length}`);

  // Split into periods
  const split = (start, end) => allCandles.filter(c => c.ts >= start && c.ts <= end);
  const trainCandles = split(trainStart, trainEnd);
  const test1Candles = split(test1Start, test1End);
  const test2Candles = split(test2Start, test2End);
  const test3Candles = split(test3Start, test3End);

  // Parameter grid (reduced for speed)
  const emaPeriods = [50, 100, 150, 200];
  const stopLosses = [5, 10, 15];
  const maxHolds = [24, 48, 72];
  const trailingStops = [false, true];
  const trendFilters = [false, true];

  console.log('\n--- TRAINING (2020-2022) ---');
  console.log(`Training on ${trainCandles.length} candles`);

  // Train: find best params
  const trainResults = [];
  for (const emaP of emaPeriods) {
    for (const sl of stopLosses) {
      for (const mh of maxHolds) {
        for (const ts of trailingStops) {
          for (const tf of trendFilters) {
            const r = backtest(trainCandles, {
              emaPeriod: emaP,
              stopLossPct: sl,
              maxHoldCandles: mh,
              trailingStop: ts,
              trendFilter: tf,
            });
            if (r.totalTrades >= 5) {
              trainResults.push({ ...r.config, ...r });
            }
          }
        }
      }
    }
  }

  // Best params by Sharpe
  trainResults.sort((a, b) => b.sharpe - a.sharpe);
  const bestParams = {
    emaPeriod: trainResults[0].emaPeriod,
    stopLossPct: trainResults[0].stopLossPct,
    maxHoldCandles: trainResults[0].maxHoldCandles,
    trailingStop: trainResults[0].trailingStop,
    trendFilter: trainResults[0].trendFilter,
  };

  console.log(`\nBest params (by Sharpe on train):`);
  console.log(`  EMA: ${bestParams.emaPeriod}, SL: ${bestParams.stopLossPct}%, MH: ${bestParams.maxHoldCandles}h, TS: ${bestParams.trailingStop}, TF: ${bestParams.trendFilter}`);
  console.log(`  Train Sharpe: ${trainResults[0].sharpe}, Sortino: ${trainResults[0].sortino}, Return: ${trainResults[0].totalReturn}%, WinRate: ${trainResults[0].winRate}%`);
  console.log(`  Train Trades: ${trainResults[0].totalTrades}, MaxDD: ${trainResults[0].maxDrawdown}%`);

  // Test on unseen periods
  console.log('\n--- OUT-OF-SAMPLE TESTS ---');
  
  const testPeriods = [
    { name: 'TEST 2023', candles: test1Candles },
    { name: 'TEST 2024-Jan to Jun 2025', candles: test2Candles },
    { name: 'TEST Jul 2025 to Apr 2026', candles: test3Candles },
  ];

  const allTestResults = [];
  
  for (const tp of testPeriods) {
    if (tp.candles.length < 500) { console.log(`${tp.name}: Too few candles, skipping`); continue; }
    
    console.log(`\n${tp.name} (${tp.candles.length} candles):`);
    
    // Calculate market return
    const marketRet = ((tp.candles[tp.candles.length-1].close - tp.candles[0].close) / tp.candles[0].close * 100).toFixed(1);
    console.log(`  Market return: ${marketRet >= 0 ? '+' : ''}${marketRet}%`);
    
    // Test best params from training
    const r = backtest(tp.candles, bestParams);
    console.log(`  Strategy: Return ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}%, Sharpe ${r.sharpe}, Sortino ${r.sortino}`);
    console.log(`  WinRate: ${r.winRate}%, PF: ${r.profitFactor}, Trades: ${r.totalTrades}, MaxDD: ${r.maxDrawdown}%`);
    console.log(`  vs Market: ${(r.totalReturn - parseFloat(marketRet)) >= 0 ? '+' : ''}${(r.totalReturn - parseFloat(marketRet)).toFixed(1)}%`);
    
    allTestResults.push({ period: tp.name, ...r, marketReturn: parseFloat(marketRet) });
    
    // Also test worst params (for comparison)
    const worstParams = {
      emaPeriod: trainResults[trainResults.length - 1].emaPeriod,
      stopLossPct: trainResults[trainResults.length - 1].stopLossPct,
      maxHoldCandles: trainResults[trainResults.length - 1].maxHoldCandles,
      trailingStop: trainResults[trainResults.length - 1].trailingStop,
      trendFilter: trainResults[trainResults.length - 1].trendFilter,
    };
    const rWorst = backtest(tp.candles, worstParams);
    console.log(`  Worst params: Return ${rWorst.totalReturn >= 0 ? '+' : ''}${rWorst.totalReturn}%, Trades: ${rWorst.totalTrades}`);
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log(' WALK-FORWARD SUMMARY');
  console.log('='.repeat(70));
  console.log(` Trained on: 2020-2022`);
  console.log(` Tested on: 2023, 2024-Jan to Jun 2025, Jul 2025 to Apr 2026`);
  console.log(`\n Best params found:`);
  console.log(`   EMA Period: ${bestParams.emaPeriod}`);
  console.log(`   Stop Loss: ${bestParams.stopLossPct}%`);
  console.log(`   Max Hold: ${bestParams.maxHoldCandles}h`);
  console.log(`   Trailing Stop: ${bestParams.trailingStop}`);
  console.log(`   Trend Filter: ${bestParams.trendFilter}`);

  // Aggregate out-of-sample performance
  const avgReturn = allTestResults.reduce((a, r) => a + r.totalReturn, 0) / allTestResults.length;
  const avgVsMarket = allTestResults.reduce((a, r) => a + (r.totalReturn - r.marketReturn), 0) / allTestResults.length;
  const avgSharpe = allTestResults.reduce((a, r) => a + r.sharpe, 0) / allTestResults.length;
  const avgSortino = allTestResults.reduce((a, r) => a + r.sortino, 0) / allTestResults.length;
  const avgMaxDD = allTestResults.reduce((a, r) => a + r.maxDrawdown, 0) / allTestResults.length;
  const avgWinRate = allTestResults.reduce((a, r) => a + r.winRate, 0) / allTestResults.length;

  console.log(`\n Out-of-sample average (${allTestResults.length} tests):`);
  console.log(`   Avg Return: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(1)}%`);
  console.log(`   Avg vs Market: ${avgVsMarket >= 0 ? '+' : ''}${avgVsMarket.toFixed(1)}%`);
  console.log(`   Avg Sharpe: ${avgSharpe.toFixed(2)}`);
  console.log(`   Avg Sortino: ${avgSortino.toFixed(2)}`);
  console.log(`   Avg MaxDD: ${avgMaxDD.toFixed(1)}%`);
  console.log(`   Avg WinRate: ${avgWinRate.toFixed(0)}%`);

  // How many beat the market?
  const beatMarket = allTestResults.filter(r => r.totalReturn > r.marketReturn).length;
  console.log(`\n Beat market: ${beatMarket}/${allTestResults.length} (${((beatMarket/allTestResults.length)*100).toFixed(0)}%)`);

  return {
    symbol,
    bestParams,
    trainResult: trainResults[0],
    testResults: allTestResults,
    summary: { avgReturn, avgVsMarket, avgSharpe, avgSortino, avgMaxDD, avgWinRate, beatMarket },
  };
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log(' WALK-FORWARD ANALYSIS WITH PROPER RISK METRICS');
  console.log(' Train: 2020-2022 | Test: 2023, 2024-2025, 2025-2026');
  console.log(' Metrics: Sharpe, Sortino, MaxDD, WinRate, Equity Curve');
  console.log('='.repeat(70));

  const results = [];

  // Test BTC
  const btcResult = await walkForwardTest('BTCUSDT');
  results.push(btcResult);

  // Test ETH
  const ethResult = await walkForwardTest('ETHUSDT');
  results.push(ethResult);

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log(' FINAL WALK-FORWARD VERDICT');
  console.log('='.repeat(70));
  
  const combined = results.flatMap(r => r.testResults);
  const avgReturn = combined.reduce((a, r) => a + r.totalReturn, 0) / combined.length;
  const avgVsM = combined.reduce((a, r) => a + (r.totalReturn - r.marketReturn), 0) / combined.length;
  const avgSharpe = combined.reduce((a, r) => a + r.sharpe, 0) / combined.length;
  const avgSortino = combined.reduce((a, r) => a + r.sortino, 0) / combined.length;
  const beatM = combined.filter(r => r.totalReturn > r.marketReturn).length;

  console.log(`\n OVERALL (BTC + ETH, ${combined.length} out-of-sample tests):`);
  console.log(`   Avg Return: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(1)}%`);
  console.log(`   Avg vs Market: ${avgVsM >= 0 ? '+' : ''}${avgVsM.toFixed(1)}%`);
  console.log(`   Avg Sharpe: ${avgSharpe.toFixed(2)}`);
  console.log(`   Avg Sortino: ${avgSortino.toFixed(2)}`);
  console.log(`   Beat Market: ${beatM}/${combined.length} (${((beatM/combined.length)*100).toFixed(0)}%)`);

  if (avgVsM > 0) {
    console.log('\n >>> STRATEGY IS ROBUST: Works on UNSEEN data <<<');
  } else {
    console.log('\n >>> STRATEGY FAILS OUT-OF-SAMPLE: Overfitted <<<');
  }

  // Save
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/walkforward-analysis.json', JSON.stringify(results, null, 2));
  console.log(`\nSaved to ./results/walkforward-analysis.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
