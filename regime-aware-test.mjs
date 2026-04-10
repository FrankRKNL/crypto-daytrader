import axios from 'axios';
import fs from 'fs';

const INITIAL_BALANCE = 100;
const FEE_RATE = 0.001;
const SLIPPAGE = 0.0005;

async function fetchBinanceCandles(symbol = 'BTCUSDT', interval = '15m', days = 90) {
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
  const result = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    result.push(tr.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0) / period);
  }
  return result;
}

// ============================================================
// MARKET REGIME DETECTOR
// ============================================================
// Classify each candle into: BULL, BEAR, or RANGING
function detectRegime(candles, lookback = 20) {
  const closes = candles.map(c => c.close);
  const atrData = atr(candles.map(c => c.high), candles.map(c => c.low), closes, 14);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  
  const regimes = [];
  for (let i = lookback; i < closes.length; i++) {
    // Trend: 20 EMA vs 50 EMA
    const trendUp = ema20[i] > ema50[i];
    
    // Volatility: ATR as % of price
    const atrPct = atrData[i] !== null ? (atrData[i] / closes[i]) * 100 : 1;
    
    // Recent momentum: % change over lookback period
    const momentum = ((closes[i] - closes[i - lookback]) / closes[i - lookback]) * 100;
    
    // Classify
    let regime;
    if (trendUp && momentum > 2) regime = 'BULL';
    else if (!trendUp && momentum < -2) regime = 'BEAR';
    else regime = 'RANGING';
    
    regimes.push({
      ts: candles[i].ts,
      date: new Date(candles[i].ts).toISOString().slice(0, 16),
      close: closes[i],
      regime,
      momentum: momentum.toFixed(2),
      atrPct: atrPct.toFixed(2),
      trendUp,
    });
  }
  return regimes;
}

// ============================================================
// REGIME-AWARE BACKTEST
// ============================================================
function regimeBacktest(candles, regimes, strategy) {
  // strategy = { bull, bear, ranging } each with { action: 'long'|'short'|'flat', params }
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  
  // Simple VWAP
  let cumVP = 0, cumV = 0;
  const vwapData = closes.map((c, i) => {
    const typical = (highs[i] + lows[i] + c) / 3;
    cumVP += typical * volumes[i]; cumV += volumes[i];
    return cumV === 0 ? c : cumVP / cumV;
  });
  
  let cash = INITIAL_BALANCE, btc = 0, pos = 'flat'; // flat, long, short
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0;
  
  // Offset regimes by 1 (regime[i] applies to candles[i+1])
  for (let i = 1; i < candles.length - 1; i++) {
    const regime = regimes[i - 1]?.regime || 'RANGING';
    const c = candles[i];
    const config = strategy[regime.toLowerCase()];
    
    if (!config || config.action === 'flat') {
      // Close any open position
      if (pos === 'long') {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ regime, action: 'CLOSE LONG', price: sellPrice, pnl, ts: c.ts });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = 'flat';
      } else if (pos === 'short') {
        const coverPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
        const pnl = (entryPrice / coverPrice - 1) * 100;
        cash = btc * coverPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ regime, action: 'CLOSE SHORT', price: coverPrice, pnl, ts: c.ts });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = 'flat';
      }
      continue;
    }
    
    if (config.action === 'long') {
      if (pos === 'flat') {
        // Check entry condition
        const entryDev = (vwapData[i] - closes[i]) / vwapData[i];
        if (entryDev >= (config.devThreshold || 0.01)) {
          const buyPrice = c.close * (1 + SLIPPAGE);
          btc = cash / buyPrice; cash = 0; pos = 'long';
          entryPrice = buyPrice;
          trades.push({ regime, action: 'LONG', price: buyPrice, ts: c.ts });
        }
      } else if (pos === 'long') {
        // Check exit
        const pnl = (c.close / entryPrice - 1) * 100;
        const exit = config.trailingStopPct
          ? pnl <= -(config.trailingStopPct) || (vwapData[i] - closes[i]) / vwapData[i] <= -(config.devThreshold || 0.01)
          : (vwapData[i] - closes[i]) / vwapData[i] <= -(config.devThreshold || 0.01);
        if (exit) {
          const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
          const realizedPnl = (sellPrice / entryPrice - 1) * 100;
          cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
          trades.push({ regime, action: 'CLOSE LONG', price: sellPrice, pnl: realizedPnl, ts: c.ts });
          if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
          else { losses++; totalLoss += Math.abs(realizedPnl); }
          pos = 'flat';
        }
      }
    } else if (config.action === 'short') {
      if (pos === 'flat') {
        const entryDev = (closes[i] - vwapData[i]) / vwapData[i];
        if (entryDev >= (config.devThreshold || 0.01)) {
          const sellPrice = c.close * (1 - SLIPPAGE);
          btc = cash / sellPrice; cash = 0; pos = 'short';
          entryPrice = sellPrice;
          trades.push({ regime, action: 'SHORT', price: sellPrice, ts: c.ts });
        }
      } else if (pos === 'short') {
        const pnl = (entryPrice / c.close - 1) * 100;
        const exit = (closes[i] - vwapData[i]) / vwapData[i] <= (config.devThreshold || 0.01);
        if (exit) {
          const coverPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
          const realizedPnl = (entryPrice / coverPrice - 1) * 100;
          cash = btc * coverPrice * (1 - FEE_RATE); btc = 0;
          trades.push({ regime, action: 'CLOSE SHORT', price: coverPrice, pnl: realizedPnl, ts: c.ts });
          if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
          else { losses++; totalLoss += Math.abs(realizedPnl); }
          pos = 'flat';
        }
      }
    }
    
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  // Close open position at end
  const finalCandle = candles[candles.length - 1];
  const finalValue = cash + btc * finalCandle.close;
  if (pos === 'long') {
    const sellPrice = finalCandle.close * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    trades.push({ regime: 'EOD', action: 'CLOSE LONG', price: sellPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  } else if (pos === 'short') {
    const coverPrice = finalCandle.close * (1 + SLIPPAGE + FEE_RATE);
    const pnl = (entryPrice / coverPrice - 1) * 100;
    trades.push({ regime: 'EOD', action: 'CLOSE SHORT', price: coverPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }
  
  const totalReturn = ((cash + btc * finalCandle.close) / INITIAL_BALANCE - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  
  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat((cash + btc * finalCandle.close).toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
    regimeStats: computeRegimeStats(regimes, trades),
  };
}

function computeRegimeStats(regimes, trades) {
  const stats = { BULL: { trades: 0, pnl: 0 }, BEAR: { trades: 0, pnl: 0 }, RANGING: { trades: 0, pnl: 0 } };
  trades.forEach(t => {
    if (t.regime && stats[t.regime] !== undefined) {
      stats[t.regime].trades++;
      stats[t.regime].pnl += t.pnl || 0;
    }
  });
  return stats;
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log(' REGIME-AWARE TRADING + SHORT STRATEGY ANALYSIS');
  console.log(' BTC/USDT 15m | 90 days | Jan-Apr 2026');
  console.log('='.repeat(80));
  
  const candles = await fetchBinanceCandles('BTCUSDT', '15m', 90);
  console.log(`Loaded ${candles.length} candles`);
  
  const regimes = detectRegime(candles);
  
  // Count regimes
  const regimeCount = { BULL: 0, BEAR: 0, RANGING: 0 };
  regimes.forEach(r => regimeCount[r.regime]++);
  console.log(`\nRegime distribution:`);
  Object.entries(regimeCount).forEach(([k, v]) => {
    console.log(`  ${k}: ${v} periods (${(v/regimes.length*100).toFixed(1)}%)`);
  });
  
  // Test different regime-aware strategies
  const strategies = [
    {
      name: 'ALWAYS LONG (baseline)',
      config: { bull: {action:'long'}, bear: {action:'long'}, ranging: {action:'long'} },
    },
    {
      name: 'ALWAYS FLAT (cash)',
      config: { bull: {action:'flat'}, bear: {action:'flat'}, ranging: {action:'flat'} },
    },
    {
      name: 'Regime: BULL=long, BEAR=short, RANGE=flat',
      config: { bull: {action:'long'}, bear: {action:'short'}, ranging: {action:'flat'} },
    },
    {
      name: 'Regime: BULL=long, BEAR=flat, RANGE=flat',
      config: { bull: {action:'long'}, bear: {action:'flat'}, ranging: {action:'flat'} },
    },
    {
      name: 'Regime: BULL=long, BEAR=short, RANGE=long',
      config: { bull: {action:'long'}, bear: {action:'short'}, ranging: {action:'long'} },
    },
    {
      name: 'Regime: BULL=long, BEAR=short, RANGE=short',
      config: { bull: {action:'long'}, bear: {action:'short'}, ranging: {action:'short'} },
    },
    {
      name: 'Short ONLY in BEAR, flat otherwise',
      config: { bull: {action:'flat'}, bear: {action:'short'}, ranging: {action:'flat'} },
    },
    {
      name: 'Long ONLY in BULL, flat otherwise',
      config: { bull: {action:'long'}, bear: {action:'flat'}, ranging: {action:'flat'} },
    },
  ];
  
  const results = [];
  for (const strat of strategies) {
    const r = regimeBacktest(candles, regimes, strat.config);
    results.push({ name: strat.name, ...r });
  }
  
  results.sort((a, b) => b.totalReturn - a.totalReturn);
  
  console.log('\n STRATEGY RESULTS:');
  console.log('='.repeat(80));
  console.log(` ${'Strategy'.padEnd(50)} ${'Return'.padEnd(8)} ${'Win%'.padEnd(6)} ${'PF'.padEnd(5)} ${'Trades'.padEnd(7)} ${'Avg W'.padEnd(7)} ${'Avg L'}`);
  console.log('-'.repeat(80));
  results.forEach((r, i) => {
    const sign = r.totalReturn >= 0 ? '+' : '';
    const wr = r.winRate !== undefined ? `${r.winRate.toFixed(0)}%` : '-';
    const pf = r.profitFactor !== undefined ? r.profitFactor.toFixed(2) : '-';
    console.log(` ${r.name.padEnd(50)} ${sign}${r.totalReturn.toFixed(1).padEnd(7)} ${wr.padEnd(5)} ${pf.padEnd(5)} ${String(r.totalTrades).padEnd(6)} ${r.avgWin.toFixed(2).padEnd(7)} ${r.avgLoss.toFixed(2)}`);
    
    // Print regime breakdown
    if (r.regimeStats) {
      ['BULL', 'BEAR', 'RANGING'].forEach(reg => {
        const s = r.regimeStats[reg];
        if (s.trades > 0) {
          const signP = s.pnl >= 0 ? '+' : '';
          console.log(`   ${reg}: ${s.trades} trades, P&L: ${signP}${s.pnl.toFixed(1)}%`);
        }
      });
    }
  });
  
  // Find market return
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const marketReturn = ((endPrice / startPrice - 1) * 100).toFixed(1);
  console.log(`\n Buy & Hold return: ${marketReturn >= 0 ? '+' : ''}${marketReturn}%`);
  
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/regime-aware-strategies.json', JSON.stringify(results, null, 2));
  console.log(`\nSaved to ./results/regime-aware-strategies.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
