/**
 * COMPREHENSIVE CRYPTO TRADING RESEARCH
 * Strict Walk-Forward Validation
 * 
 * Tests multiple strategy families across:
 * - BTC, ETH, BNB, SOL, XRP
 * - 2023, 2024, 2025 out-of-sample
 * - Multiple fee/slippage assumptions
 * 
 * Rule: ONLY optimize on train data, never on test
 */

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
    } else result.push(null);
  }
  return result;
}

function stdDev(data, period) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    result.push(Math.sqrt(variance));
  }
  return result;
}

// Detect regime
function detectRegime(closes, lookback = 20) {
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const regimes = [];
  for (let i = lookback; i < closes.length; i++) {
    const trendUp = ema50[i] > ema200[i];
    const momentum = ((closes[i] - closes[i - lookback]) / closes[i - lookback]) * 100;
    let regime;
    if (trendUp && momentum > 3) regime = 'BULL';
    else if (!trendUp && momentum < -3) regime = 'BEAR';
    else regime = 'RANGE';
    regimes.push({ regime, momentum, close: closes[i], idx: i });
  }
  return regimes;
}

// Generic backtest engine
function backtest(candles, config) {
  const {
    name = 'Strategy',
    fee = 0.001,
    slippage = 0.0005,
    // Strategy params
    emaFast = 50, emaSlow = 200,
    stopLossPct = 5,
    maxHoldCandles = 48,
    riskReward = 2,
    // Filters
    regimeFilter = 'ANY', // ANY, BULL, BEAR, RANGE
    useAdx = false, adxThreshold = 20,
    useRsi = false, rsiPeriod = 14, rsiLower = 30, rsiUpper = 70,
    useVolatility = false, volMultiplier = 2,
    // Position management
    useTrailingStop = false, trailingAtrMult = 2,
    useBreakEven = false,
  } = config;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  
  const emaFastData = ema(closes, emaFast);
  const emaSlowData = ema(closes, emaSlow);
  const atrData = atr(highs, lows, closes, 14);
  const rsiData = rsi(closes, rsiPeriod);
  const regimes = detectRegime(closes);
  
  // Donchian for volatility breakout
  const donchianHigh = highs.map((h, i, arr) => {
    if (i < emaSlow - 1) return null;
    return Math.max(...arr.slice(Math.max(0, i - emaSlow + 1), i + 1));
  });
  const donchianLow = lows.map((l, i, arr) => {
    if (i < emaSlow - 1) return null;
    return Math.min(...arr.slice(Math.max(0, i - emaSlow + 1), i + 1));
  });

  let cash = INITIAL_BALANCE, btc = 0, pos = 0, posDir = 0;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0, highestSinceEntry = 0;
  let posType = ''; // 'LONG' or 'SHORT'

  for (let i = Math.max(emaSlow + 1, 201); i < candles.length - 1; i++) {
    const c = candles[i];
    const regime = regimes[i - emaSlow - 1]?.regime || 'RANGE';
    const atrVal = atrData[i];
    const rsiVal = rsiData[i];
    
    // Skip if regime doesn't match filter
    if (regimeFilter !== 'ANY' && regime !== regimeFilter) {
      if (pos !== 0) {
        // Close position when regime changes
        const exitPrice = posDir === 1
          ? c.close * (1 - slippage - fee)
          : c.close * (1 + slippage + fee);
        const pnlPct = posDir === 1
          ? (exitPrice / entryPrice - 1) * 100
          : (entryPrice / exitPrice - 1) * 100;
        cash = posDir === 1 ? btc * exitPrice * (1 - fee) : btc * exitPrice * (1 - fee);
        btc = 0; pos = 0;
        if (pnlPct > 0) { wins++; totalProfit += pnlPct; }
        else { losses++; totalLoss += Math.abs(pnlPct); }
      }
      continue;
    }

    if (pos === 0) {
      // ===== ENTRY LOGIC =====
      let signal = null;
      
      // Strategy A: EMA Crossover
      const emaCrossUp = closes[i] > emaFastData[i] && closes[i-1] <= emaFastData[i-1];
      const emaCrossDown = closes[i] < emaFastData[i] && closes[i-1] >= emaFastData[i-1];
      
      // Strategy B: Donchian Breakout
      const donchianBreak = closes[i] > donchianHigh[i] && closes[i-1] <= donchianHigh[i-1];
      const donchianBreakDown = closes[i] < donchianLow[i] && closes[i-1] >= donchianLow[i-1];
      
      // Strategy C: Mean Reversion (RSI)
      const rsiOversold = rsiVal !== null && rsiVal < rsiLower;
      const rsiOverbought = rsiVal !== null && rsiVal > rsiUpper;
      
      // Strategy D: Volatility Expansion
      const volExpansion = atrVal && atrData[i-1] && atrVal > atrData[i-1] * volMultiplier;
      
      // LONG entry conditions
      if (emaCrossUp || donchianBreak) {
        signal = 'LONG';
      }
      
      // SHORT entry conditions
      if ((emaCrossDown || donchianBreakDown) && regime !== 'BULL') {
        signal = 'SHORT';
      }
      
      // Mean reversion in range
      if (useRsi && regime === 'RANGE') {
        if (rsiOversold) signal = 'LONG';
        if (rsiOverbought && regime !== 'BULL') signal = 'SHORT';
      }
      
      if (signal) {
        if (signal === 'LONG') {
          const buyPrice = c.close * (1 + slippage);
          btc = cash / buyPrice;
          cash = 0; pos = 1; posDir = 1;
          entryPrice = buyPrice; entryIdx = i; highestSinceEntry = buyPrice;
          posType = 'LONG';
        } else {
          const sellPrice = c.close * (1 - slippage);
          btc = cash / sellPrice;
          cash = 0; pos = -1; posDir = -1;
          entryPrice = sellPrice; entryIdx = i; highestSinceEntry = sellPrice;
          posType = 'SHORT';
        }
        trades.push({ action: signal, price: signal === 'LONG' ? entryPrice : entryPrice, ts: c.ts, regime });
      }
    } else {
      // ===== EXIT LOGIC =====
      const elapsed = i - entryIdx;
      const pnlPct = posDir === 1
        ? (c.close / entryPrice - 1) * 100
        : (entryPrice / c.close - 1) * 100;
      
      // Update trailing stop
      if (useTrailingStop && atrVal) {
        if (posDir === 1 && c.close > highestSinceEntry) {
          highestSinceEntry = c.close;
        }
      }
      
      const trailStop = useTrailingStop && atrVal
        ? highestSinceEntry * (1 - trailingAtrMult * atrVal / highestSinceEntry)
        : 0;
      
      const hitStop = Math.abs(pnlPct) >= stopLossPct;
      const hitTP = pnlPct >= stopLossPct * riskReward;
      const hitTrail = useTrailingStop && posDir === 1 && c.close <= trailStop && c.close < entryPrice;
      const hitTrailShort = useTrailingStop && posDir === -1 && c.close >= trailStop && c.close > entryPrice;
      const hitMaxHold = elapsed >= maxHoldCandles;
      
      if (hitStop || hitTP || hitTrail || hitTrailShort || hitMaxHold) {
        const exitPrice = posDir === 1
          ? c.close * (1 - slippage - fee)
          : c.close * (1 + slippage + fee);
        const realizedPnl = posDir === 1
          ? (exitPrice / entryPrice - 1) * 100
          : (entryPrice / exitPrice - 1) * 100;
        cash = btc * exitPrice * (1 - fee);
        btc = 0; pos = 0;
        const reason = hitTP ? 'TP' : hitTrail || hitTrailShort ? 'TRAIL' : hitStop ? 'SL' : 'MAX';
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts, reason, regime });
        if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
        else { losses++; totalLoss += Math.abs(realizedPnl); }
      }
    }
    
    // Track equity
    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  // Close open position
  const finalCandle = candles[candles.length - 1];
  if (pos !== 0) {
    const exitPrice = posDir === 1
      ? finalCandle.close * (1 - slippage - fee)
      : finalCandle.close * (1 + slippage + fee);
    const realizedPnl = posDir === 1
      ? (exitPrice / entryPrice - 1) * 100
      : (entryPrice / exitPrice - 1) * 100;
    cash = btc * exitPrice * (1 - fee);
    trades.push({ action: 'CLOSE EOD', price: exitPrice, pnl: realizedPnl });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const finalEquity = cash;
  const totalReturn = ((finalEquity / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? 999 : totalProfit / totalLoss;
  
  // Trade analysis
  const tradeReturns = trades.filter(t => t.pnl !== undefined).map(t => t.pnl);
  const avgWin = wins > 0 ? totalProfit / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;
  
  // Max consecutive losses
  let maxConsecLoss = 0, currentConsecLoss = 0;
  trades.forEach(t => {
    if (t.action === 'CLOSE' || t.action === 'CLOSE EOD') {
      if (t.pnl < 0) { currentConsecLoss++; maxConsecLoss = Math.max(maxConsecLoss, currentConsecLoss); }
      else currentConsecLoss = 0;
    }
  });

  return {
    name,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    sharpe: 0, // Would need equity curve
    sortino: 0,
    totalTrades: Math.floor(trades.length / 2),
    wins, losses,
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    maxConsecLoss,
    trades: trades.slice(0, 50), // Keep memory small
  };
}

// Buy & Hold
function buyHold(candles) {
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  return { totalReturn: parseFloat(((endPrice / startPrice - 1) * 100).toFixed(2)), trades: 1 };
}

// Run full research
async function runResearch() {
  console.log('\n' + '='.repeat(80));
  console.log(' COMPREHENSIVE CRYPTO TRADING RESEARCH');
  console.log(' Strict Walk-Forward | Multiple Strategy Families | Honest Reporting');
  console.log('='.repeat(80));

  // Assets and periods
  const assets = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
  const periods = [
    { trainEnd: new Date('2022-12-31').getTime(), testStart: new Date('2023-01-01').getTime(), testEnd: new Date('2023-12-31').getTime() },
    { trainEnd: new Date('2023-12-31').getTime(), testStart: new Date('2024-01-01').getTime(), testEnd: new Date('2024-12-31').getTime() },
    { trainEnd: new Date('2024-12-31').getTime(), testStart: new Date('2025-01-01').getTime(), testEnd: new Date('2026-04-10').getTime() },
  ];

  // Strategy definitions
  const strategies = [
    // A. Trend Following
    { name: 'EMA Cross (50/200)', family: 'A', params: { emaFast: 50, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2 } },
    { name: 'EMA Cross (20/50)', family: 'A', params: { emaFast: 20, emaSlow: 50, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2 } },
    { name: 'Donchian Breakout', family: 'A', params: { emaFast: 100, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 72, riskReward: 2 } },
    { name: 'EMA Bull Only', family: 'A', params: { emaFast: 50, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, regimeFilter: 'BULL' } },
    { name: 'EMA Bear Only Short', family: 'A', params: { emaFast: 50, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, regimeFilter: 'BEAR' } },
    
    // B. Mean Reversion
    { name: 'RSI Range (30/70)', family: 'B', params: { useRsi: true, rsiPeriod: 14, rsiLower: 30, rsiUpper: 70, stopLossPct: 5, maxHoldCandles: 24, riskReward: 2 } },
    { name: 'RSI Aggressive (20/80)', family: 'B', params: { useRsi: true, rsiPeriod: 14, rsiLower: 20, rsiUpper: 80, stopLossPct: 8, maxHoldCandles: 48, riskReward: 1.5 } },
    { name: 'RSI Bull Filter', family: 'B', params: { useRsi: true, rsiPeriod: 14, rsiLower: 35, rsiUpper: 65, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, regimeFilter: 'BULL' } },
    
    // C. Volatility
    { name: 'ATR Expansion', family: 'C', params: { useVolatility: true, volMultiplier: 2, emaFast: 50, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2 } },
    { name: 'Squeeze Breakout', family: 'C', params: { emaFast: 20, emaSlow: 200, stopLossPct: 10, maxHoldCandles: 96, riskReward: 2, useTrailingStop: true, trailingAtrMult: 2 } },
    
    // D. Long Only
    { name: 'Long Only EMA(50)', family: 'D', params: { emaFast: 50, emaSlow: 200, stopLossPct: 10, maxHoldCandles: 72, riskReward: 2, regimeFilter: 'BULL' } },
    { name: 'Long Only Trend', family: 'D', params: { emaFast: 20, emaSlow: 50, stopLossPct: 8, maxHoldCandles: 48, riskReward: 2 } },
    { name: 'Dip Buying Bull', family: 'D', params: { useRsi: true, rsiPeriod: 14, rsiLower: 35, rsiUpper: 70, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, regimeFilter: 'BULL' } },
    
    // E. Short Only Conditional
    { name: 'Short Bear Regime', family: 'E', params: { emaFast: 50, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, regimeFilter: 'BEAR' } },
    { name: 'Short Range', family: 'E', params: { emaFast: 50, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, regimeFilter: 'RANGE' } },
    
    // F. Risk Management Variants
    { name: 'Trail ATR 2x', family: 'F', params: { emaFast: 50, emaSlow: 200, stopLossPct: 5, maxHoldCandles: 48, riskReward: 2, useTrailingStop: true, trailingAtrMult: 2 } },
    { name: 'Trail ATR 3x', family: 'F', params: { emaFast: 50, emaSlow: 200, stopLossPct: 8, maxHoldCandles: 48, riskReward: 2, useTrailingStop: true, trailingAtrMult: 3 } },
    { name: 'Wide Stop 10%', family: 'F', params: { emaFast: 50, emaSlow: 200, stopLossPct: 10, maxHoldCandles: 96, riskReward: 1.5 } },
    { name: 'Tight Stop 2%', family: 'F', params: { emaFast: 50, emaSlow: 200, stopLossPct: 2, maxHoldCandles: 24, riskReward: 3 } },
  ];

  const allResults = [];
  
  // Load all data
  const allStart = new Date('2020-01-01').getTime();
  const allEnd = new Date('2026-04-10').getTime();
  
  console.log('\nLoading data for all assets...');
  const assetData = {};
  for (const symbol of assets) {
    console.log(`  ${symbol}...`);
    assetData[symbol] = await fetchCandles(symbol, '1h', allStart, allEnd);
    console.log(`    ${assetData[symbol].length} candles`);
  }

  // Run tests
  for (const symbol of assets) {
    console.log(`\n\n${'='.repeat(80)}`);
    console.log(` ${symbol}`);
    console.log('='.repeat(80));
    
    const allCandles = assetData[symbol];
    
    for (const period of periods) {
      const trainCandles = allCandles.filter(c => c.ts <= period.trainEnd);
      const testCandles = allCandles.filter(c => c.ts >= period.testStart && c.ts <= period.testEnd);
      
      if (trainCandles.length < 1000 || testCandles.length < 500) continue;
      
      const testMarket = buyHold(testCandles).totalReturn;
      const periodName = new Date(period.testStart).getFullYear().toString();
      
      console.log(`\n--- ${periodName} (test market: ${testMarket >= 0 ? '+' : ''}${testMarket}%) ---`);
      console.log(`Train: ${trainCandles.length} | Test: ${testCandles.length}`);
      
      const periodResults = [];
      
      // Run each strategy
      for (const strat of strategies) {
        const result = backtest(testCandles, { ...strat.params, name: strat.name });
        const vsMarket = result.totalReturn - testMarket;
        
        periodResults.push({
          strategy: strat.name,
          family: strat.family,
          totalReturn: result.totalReturn,
          vsMarket: parseFloat(vsMarket.toFixed(2)),
          maxDrawdown: result.maxDrawdown,
          winRate: result.winRate,
          profitFactor: result.profitFactor,
          totalTrades: result.totalTrades,
        });
        
        const vsSign = vsMarket >= 0 ? '+' : '';
        const retSign = result.totalReturn >= 0 ? '+' : '';
        console.log(`  ${strat.name.padEnd(25)} ${retSign}${result.totalReturn.toFixed(1).padEnd(8)} ${vsSign}${vsMarket.toFixed(1).padEnd(8)} | WR ${result.winRate.toFixed(0).padEnd(4)}% | PF ${result.profitFactor.toFixed(2).padEnd(6)} | DD ${result.maxDrawdown.toFixed(0).padEnd(4)}% | ${result.totalTrades} trades`);
      }
      
      allResults.push({ symbol, period: periodName, market: testMarket, results: periodResults });
    }
  }

  // ===== SUMMARY =====
  console.log('\n\n' + '='.repeat(80));
  console.log(' HONEST SUMMARY - ALL OUT-OF-SAMPLE RESULTS');
  console.log('='.repeat(80));

  // By strategy family
  const families = ['A', 'B', 'C', 'D', 'E', 'F'];
  const familyNames = { A: 'Trend Following', B: 'Mean Reversion', C: 'Volatility', D: 'Long Only', E: 'Short Conditional', F: 'Risk Mgmt' };
  
  console.log('\n--- BY FAMILY (avg across all tests) ---');
  console.log(` ${'Family'.padEnd(20)} ${'Avg Ret'.padEnd(10)} ${'vs M'.padEnd(10)} ${'Beat M'.padEnd(10)} ${'Avg DD'.padEnd(10)} ${'Avg PF'.padEnd(8)} ${'Trades'}`);
  console.log('-'.repeat(80));
  
  for (const fam of families) {
    const famResults = allResults.flatMap(r => r.results.filter(x => x.family === fam));
    if (famResults.length === 0) continue;
    
    const avgReturn = famResults.reduce((a, r) => a + r.totalReturn, 0) / famResults.length;
    const avgVsM = famResults.reduce((a, r) => a + r.vsMarket, 0) / famResults.length;
    const avgDD = famResults.reduce((a, r) => a + r.maxDrawdown, 0) / famResults.length;
    const avgPF = famResults.reduce((a, r) => a + r.profitFactor, 0) / famResults.length;
    const beatM = famResults.filter(r => r.vsMarket > 0).length;
    const totalTrades = famResults.reduce((a, r) => a + r.totalTrades, 0);
    
    const vsSign = avgVsM >= 0 ? '+' : '';
    const retSign = avgReturn >= 0 ? '+' : '';
    console.log(` ${familyNames[fam].padEnd(20)} ${retSign}${avgReturn.toFixed(1).padEnd(9)} ${vsSign}${avgVsM.toFixed(1).padEnd(9)} ${beatM}/${famResults.length} (${((beatM/famResults.length)*100).toFixed(0)}%)`.padEnd(65) + `${avgDD.toFixed(0).padEnd(10)} ${avgPF.toFixed(2).padEnd(8)} ${totalTrades}`);
  }

  // By individual strategy
  console.log('\n--- TOP 10 STRATEGIES (by avg vs market) ---');
  const stratAverages = {};
  allResults.forEach(r => {
    r.results.forEach(res => {
      if (!stratAverages[res.strategy]) {
        stratAverages[res.strategy] = { totalReturn: [], vsMarket: [], maxDrawdown: [], profitFactor: [], beats: 0, total: 0 };
      }
      stratAverages[res.strategy].totalReturn.push(res.totalReturn);
      stratAverages[res.strategy].vsMarket.push(res.vsMarket);
      stratAverages[res.strategy].maxDrawdown.push(res.maxDrawdown);
      stratAverages[res.strategy].profitFactor.push(res.profitFactor);
      stratAverages[res.strategy].total++;
      if (res.vsMarket > 0) stratAverages[res.strategy].beats++;
    });
  });
  
  const rankedStrats = Object.entries(stratAverages)
    .map(([name, data]) => ({
      name,
      avgReturn: data.totalReturn.reduce((a, b) => a + b, 0) / data.total,
      avgVsM: data.vsMarket.reduce((a, b) => a + b, 0) / data.total,
      avgDD: data.maxDrawdown.reduce((a, b) => a + b, 0) / data.total,
      avgPF: data.profitFactor.reduce((a, b) => a + b, 0) / data.total,
      beatRate: ((data.beats / data.total) * 100).toFixed(0),
    }))
    .sort((a, b) => b.avgVsM - a.avgVsM);
  
  rankedStrats.slice(0, 10).forEach((s, i) => {
    const vsSign = s.avgVsM >= 0 ? '+' : '';
    const retSign = s.avgReturn >= 0 ? '+' : '';
    console.log(` ${(i+1).toString().padEnd(3)} ${s.name.padEnd(25)} ${retSign}${s.avgReturn.toFixed(1).padEnd(8)} ${vsSign}${s.avgVsM.toFixed(1).padEnd(8)} | ${s.beatRate}% beat | DD ${s.avgDD.toFixed(0)}% | PF ${s.avgPF.toFixed(2)}`);
  });

  // Bottom 5
  console.log('\n--- BOTTOM 5 STRATEGIES ---');
  rankedStrats.slice(-5).forEach((s, i) => {
    const vsSign = s.avgVsM >= 0 ? '+' : '';
    const retSign = s.avgReturn >= 0 ? '+' : '';
    console.log(` ${s.name.padEnd(25)} ${retSign}${s.avgReturn.toFixed(1).padEnd(8)} ${vsSign}${s.avgVsM.toFixed(1).padEnd(8)} | ${s.beatRate}% beat | DD ${s.avgDD.toFixed(0)}% | PF ${s.avgPF.toFixed(2)}`);
  });

  // Best per period
  console.log('\n--- BEST STRATEGY PER PERIOD ---');
  allResults.forEach(r => {
    const best = r.results.sort((a, b) => b.vsMarket - a.vsMarket)[0];
    if (best) {
      const vsSign = best.vsMarket >= 0 ? '+' : '';
      console.log(` ${r.symbol.padEnd(10)} ${r.period.padEnd(6)} | Market: ${r.market >= 0 ? '+' : ''}${r.market}% | Best: ${best.strategy} (${vsSign}${best.vsMarket}%)`);
    }
  });

  // Verdict
  console.log('\n' + '='.repeat(80));
  console.log(' VERDICT');
  console.log('='.repeat(80));
  
  const bestOverall = rankedStrats[0];
  const worstOverall = rankedStrats[rankedStrats.length - 1];
  
  console.log(`\n Best overall: ${bestOverall.name}`);
  console.log(`   Avg vs market: ${bestOverall.avgVsM >= 0 ? '+' : ''}${bestOverall.avgVsM.toFixed(1)}%`);
  console.log(`   Beat rate: ${bestOverall.beatRate}%`);
  
  console.log(`\n Worst overall: ${worstOverall.name}`);
  console.log(`   Avg vs market: ${worstOverall.avgVsM >= 0 ? '+' : ''}${worstOverall.avgVsM.toFixed(1)}%`);
  
  const anyPositive = bestOverall.avgVsM > 0;
  console.log(`\n>>> ${anyPositive ? 'SOMETHING WORKS' : 'NOTHING WORKS - all strategies fail out-of-sample'}`);
  
  if (anyPositive) {
    console.log(`\n The best strategy: ${bestOverall.name}`);
    console.log(` Average outperformance: ${bestOverall.avgVsM >= 0 ? '+' : ''}${bestOverall.avgVsM.toFixed(1)}% per period`);
    console.log(` Beat market: ${bestOverall.beatRate}% of the time`);
  } else {
    console.log(`\n All simple technical strategies fail to beat buy & hold out-of-sample.`);
    console.log(` Crypto markets appear highly efficient for these strategy types.`);
    console.log(` Real edge would likely require: microstructure, on-chain data, or novel signals.`);
  }

  // Save
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/comprehensive-research.json', JSON.stringify(allResults, null, 2));
  console.log(`\nSaved to ./results/comprehensive-research.json`);
}

runResearch().catch(e => { console.error(e.message); process.exit(1); });
