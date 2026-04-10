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

function longCash(candles, maPeriod = 200) {
  const closes = candles.map(c => c.close);
  const maData = ema(closes, maPeriod);
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false, entryPrice = 0;
  let peak = INITIAL_BALANCE, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let tradeCount = 0;
  
  for (let i = maPeriod + 1; i < candles.length; i++) {
    const c = candles[i];
    const aboveMa = closes[i] > maData[i];
    const prevBelow = closes[i - 1] <= maData[i - 1];
    
    if (!pos && aboveMa && prevBelow) {
      btc = cash / c.close;
      cash = 0;
      pos = true;
      entryPrice = c.close * (1 + SLIPPAGE);
      tradeCount++;
    } else if (pos && !aboveMa && closes[i - 1] > maData[i - 1]) {
      const pnl = (c.close * (1 - SLIPPAGE - FEE_RATE) / entryPrice - 1) * 100;
      cash = btc * c.close * (1 - SLIPPAGE - FEE_RATE);
      btc = 0;
      pos = false;
      if (pnl > 0) { wins++; totalProfit += pnl; }
      else { losses++; totalLoss += Math.abs(pnl); }
      tradeCount++;
    }
    
    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalEquity = cash + btc * candles[candles.length - 1].close;
  const totalReturn = ((finalEquity / INITIAL_BALANCE) - 1) * 100;
  const returnPerDD = maxDD > 0 ? totalReturn / (maxDD * 100) : 0;
  
  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: wins + losses > 0 ? parseFloat((wins / (wins + losses) * 100).toFixed(1)) : 0,
    totalTrades: Math.floor(tradeCount / 2),
    returnPerDD: parseFloat(returnPerDD.toFixed(2)),
    timeInMarket: 0,
  };
}

function longWithTrail(candles, maPeriod = 200, atrMult = 2) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const maData = ema(closes, maPeriod);
  const atrData = atr(highs, lows, closes, 14);
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false, entryPrice = 0, highest = 0;
  let peak = INITIAL_BALANCE, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let tradeCount = 0;
  
  for (let i = maPeriod + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const aboveMa = closes[i] > maData[i];
    const prevBelow = closes[i - 1] <= maData[i - 1];
    const volSpike = c.volume > candles[i - 1].volume * 1.1;
    
    if (!pos && aboveMa && prevBelow && volSpike) {
      btc = cash / (c.close * (1 + SLIPPAGE));
      cash = 0;
      pos = true;
      entryPrice = c.close * (1 + SLIPPAGE);
      highest = entryPrice;
      tradeCount++;
    } else if (pos) {
      if (c.close > highest) highest = c.close;
      const trailStop = highest * (1 - atrMult * atrData[i] / highest);
      const pnlPct = (c.close / entryPrice - 1) * 100;
      
      if (c.close <= trailStop || pnlPct <= -10) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const realized = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE);
        btc = 0;
        pos = false;
        if (realized > 0) { wins++; totalProfit += realized; }
        else { losses++; totalLoss += Math.abs(realized); }
        tradeCount++;
      }
    }
    
    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalEquity = cash + btc * candles[candles.length - 1].close;
  const totalReturn = ((finalEquity / INITIAL_BALANCE) - 1) * 100;
  const returnPerDD = maxDD > 0 ? totalReturn / (maxDD * 100) : 0;
  
  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: wins + losses > 0 ? parseFloat((wins / (wins + losses) * 100).toFixed(1)) : 0,
    totalTrades: Math.floor(tradeCount / 2),
    returnPerDD: parseFloat(returnPerDD.toFixed(2)),
    timeInMarket: 0,
  };
}

function buyHold(candles) {
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const ret = ((endPrice / startPrice - 1) * 100);
  
  let peak = startPrice, maxDD = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > peak) peak = candles[i].close;
    const dd = (peak - candles[i].close) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  return {
    totalReturn: parseFloat(ret.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    timeInMarket: 100,
    returnPerDD: parseFloat((ret / (maxDD * 100)).toFixed(2)),
  };
}

async function main() {
  console.log('\n' + '='.repeat(85));
  console.log(' RISK-ADJUSTED CRYPTO RESEARCH');
  console.log(' Focus: Drawdown Reduction, Exposure Control, Risk-Adjusted Returns');
  console.log('='.repeat(85));

  const periods = [
    { label: '2023', start: new Date('2023-01-01').getTime(), end: new Date('2023-12-31').getTime() },
    { label: '2024', start: new Date('2024-01-01').getTime(), end: new Date('2024-12-31').getTime() },
    { label: '2025', start: new Date('2025-01-01').getTime(), end: new Date('2026-04-10').getTime() },
  ];

  const assets = ['BTCUSDT', 'ETHUSDT'];
  const allResults = [];

  for (const symbol of assets) {
    console.log('\n\n' + '='.repeat(85));
    console.log(' ' + symbol);
    console.log('='.repeat(85));

    const allCandles = await fetchCandles(symbol, '1h', new Date('2020-01-01').getTime(), new Date('2026-04-10').getTime());
    console.log('Total candles: ' + allCandles.length);

    for (const period of periods) {
      const candles = allCandles.filter(c => c.ts >= period.start && c.ts <= period.end);
      if (candles.length < 500) continue;

      console.log('\n--- ' + period.label + ' ---');
      
      const bnh = buyHold(candles);
      console.log('\n BUY & HOLD: Return ' + bnh.totalReturn + '% | MaxDD ' + bnh.maxDrawdown + '%');

      const strategies = [
        { name: 'Long+Cash EMA50', fn: () => longCash(candles, 50) },
        { name: 'Long+Cash EMA100', fn: () => longCash(candles, 100) },
        { name: 'Long+Cash EMA200', fn: () => longCash(candles, 200) },
        { name: 'Long+Trail EMA50', fn: () => longWithTrail(candles, 50, 2) },
        { name: 'Long+Trail EMA100', fn: () => longWithTrail(candles, 100, 2) },
        { name: 'Long+Trail EMA200', fn: () => longWithTrail(candles, 200, 2) },
      ];

      console.log('\n ' + 'Strategy'.padEnd(22) + 'Return'.padEnd(10) + 'vs B&H'.padEnd(10) + 'MaxDD'.padEnd(8) + 'DD Reduce'.padEnd(10) + 'Ret/DD');
      console.log(' ' + '-'.repeat(70));

      for (const strat of strategies) {
        const r = strat.fn();
        const vsBnh = r.totalReturn - bnh.totalReturn;
        const ddReduce = bnh.maxDrawdown - r.maxDrawdown;
        
        const retStr = (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1);
        const vsStr = (vsBnh >= 0 ? '+' : '') + vsBnh.toFixed(1);
        const ddRedStr = (ddReduce >= 0 ? '+' : '') + ddReduce.toFixed(1);
        
        console.log(' ' + strat.name.padEnd(22) + retStr.padEnd(10) + vsStr.padEnd(10) + r.maxDrawdown.toFixed(1).padEnd(8) + ddRedStr.padEnd(10) + r.returnPerDD);
        
        allResults.push({
          symbol,
          period: period.label,
          strategy: strat.name,
          return: r.totalReturn,
          vsBnh,
          maxDD: r.maxDrawdown,
          ddReduce,
          retPerDD: r.returnPerDD,
        });
      }
    }
  }

  // Summary
  console.log('\n\n' + '='.repeat(85));
  console.log(' SUMMARY');
  console.log('='.repeat(85));

  const stratGroups = {};
  allResults.forEach(r => {
    if (!stratGroups[r.strategy]) stratGroups[r.strategy] = [];
    stratGroups[r.strategy].push(r);
  });

  console.log('\n ' + 'Strategy'.padEnd(22) + 'Avg Ret'.padEnd(10) + 'vs B&H'.padEnd(10) + 'Avg DD'.padEnd(8) + 'DD Reduce'.padEnd(10) + 'Ret/DD');
  console.log(' ' + '-'.repeat(70));

  Object.entries(stratGroups)
    .map(([name, results]) => {
      const avgReturn = results.reduce((a, r) => a + r.return, 0) / results.length;
      const avgVsBnh = results.reduce((a, r) => a + r.vsBnh, 0) / results.length;
      const avgDD = results.reduce((a, r) => a + r.maxDD, 0) / results.length;
      const avgDDRe = results.reduce((a, r) => a + r.ddReduce, 0) / results.length;
      const avgRetPerDD = results.reduce((a, r) => a + r.retPerDD, 0) / results.length;
      return { name, avgReturn, avgVsBnh, avgDD, avgDDRe, avgRetPerDD };
    })
    .sort((a, b) => b.avgRetPerDD - a.avgRetPerDD)
    .forEach(s => {
      const retStr = (s.avgReturn >= 0 ? '+' : '') + s.avgReturn.toFixed(1);
      const vsStr = (s.avgVsBnh >= 0 ? '+' : '') + s.avgVsBnh.toFixed(1);
      const ddReStr = (s.avgDDRe >= 0 ? '+' : '') + s.avgDDRe.toFixed(1);
      console.log(' ' + s.name.padEnd(22) + retStr.padEnd(10) + vsStr.padEnd(10) + s.avgDD.toFixed(1).padEnd(8) + ddReStr.padEnd(10) + s.avgRetPerDD.toFixed(2));
    });

  console.log('\n' + '='.repeat(85));
  console.log(' VERDICT');
  console.log('='.repeat(85));

  const flat = Object.values(stratGroups).flat();
  const bestDD = flat.sort((a, b) => b.ddReduce - a.ddReduce)[0];
  const bestRiskAdj = flat.sort((a, b) => b.retPerDD - a.retPerDD)[0];

  console.log('\n Best for DRAWDOWN REDUCTION: ' + bestDD.strategy);
  console.log('   Reduces drawdown by ' + (bestDD.ddReduce >= 0 ? '+' : '') + bestDD.ddReduce + '% vs B&H');
  console.log('   Return: ' + (bestDD.return >= 0 ? '+' : '') + bestDD.return + '%');

  console.log('\n Best RISK-ADJUSTED: ' + bestRiskAdj.strategy);
  console.log('   Return/DD ratio: ' + (bestRiskAdj.retPerDD >= 0 ? '+' : '') + bestRiskAdj.retPerDD);
  console.log('   Return: ' + (bestRiskAdj.return >= 0 ? '+' : '') + bestRiskAdj.return + '%, DD: ' + bestRiskAdj.maxDD + '%');

  fs.writeFileSync('./results/risk-adjusted-research.json', JSON.stringify(allResults, null, 2));
  console.log('\nSaved to ./results/risk-adjusted-research.json');
}

main().catch(e => { console.error(e.message); process.exit(1); });
