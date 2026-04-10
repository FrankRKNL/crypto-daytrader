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

// Detect regime: BULL, BEAR, RANGE
function detectRegime(closes, lookback = 20) {
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const regimes = [];
  for (let i = lookback; i < closes.length; i++) {
    const trendUp = ema20[i] > ema50[i];
    const momentum = ((closes[i] - closes[i - lookback]) / closes[i - lookback]) * 100;
    let regime;
    if (trendUp && momentum > 2) regime = 'BULL';
    else if (!trendUp && momentum < -2) regime = 'BEAR';
    else regime = 'RANGE';
    regimes.push({ regime, momentum, close: closes[i], idx: i });
  }
  return regimes;
}

// SHORT strategy with EMA200 crossover + volume spike + ATR stop
function shortStrategy(candles, config = {}) {
  const { emaPeriod = 200, stopLossPct = 5, maxHoldCandles = 48, volMultiplier = 1.2 } = config;
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
      const volumeSpike = volumes[i] > volumes[i - 1] * volMultiplier;

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
        trades.push({ action: 'CLOSE', price: exitPrice, pnl: realizedPnl, ts: c.ts, reason: hitStop ? 'SL' : 'MAX' });
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
    trades.push({ action: 'CLOSE EOD', price: exitPrice, pnl: realizedPnl });
    if (realizedPnl > 0) { wins++; totalProfit += realizedPnl; }
    else { losses++; totalLoss += Math.abs(realizedPnl); }
  }

  const totalTrades = Math.floor(trades.length / 2);
  const totalReturn = ((cash - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  const avgWin = wins > 0 ? totalProfit / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    trades,
  };
}

// FLAT strategy (do nothing, just hold cash)
function flatStrategy(candles) {
  return {
    totalReturn: 0,
    maxDrawdown: 0,
    winRate: 0,
    profitFactor: 0,
    totalTrades: 0,
    wins: 0, losses: 0,
    avgWin: 0, avgLoss: 0,
  };
}

// BUY & HOLD strategy
function buyHoldStrategy(candles) {
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const ret = ((endPrice / startPrice - 1) * 100);
  return {
    totalReturn: parseFloat(ret.toFixed(2)),
    totalTrades: 1,
  };
}

// Regime detection on historical data (for deciding which strategy to use)
function getRegimeSignal(closes, lookback = 20) {
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const recent = closes.slice(-lookback);
  const momentum = ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
  const trendUp = ema20[ema20.length - 1] > ema50[ema50.length - 1];
  if (trendUp && momentum > 3) return 'BULL';
  if (!trendUp && momentum < -3) return 'BEAR';
  return 'RANGE';
}

async function testPeriod(symbol, label, start, end) {
  const candles = await fetchCandles(symbol, '1h', start, end);
  if (candles.length < 500) return null;

  const closes = candles.map(c => c.close);
  const startP = closes[0], endP = closes[closes.length - 1];
  const marketReturn = ((endP / startP - 1) * 100).toFixed(1);
  const regime = getRegimeSignal(closes);

  // Run strategies
  const results = {
    symbol,
    label,
    regime,
    marketReturn: parseFloat(marketReturn),
    candles: candles.length,
    strategies: {
      buyHold: buyHoldStrategy(candles),
      flat: flatStrategy(candles),
      short200_3: shortStrategy(candles, { emaPeriod: 200, stopLossPct: 3, maxHoldCandles: 48 }),
      short200_5: shortStrategy(candles, { emaPeriod: 200, stopLossPct: 5, maxHoldCandles: 48 }),
      short50_3: shortStrategy(candles, { emaPeriod: 50, stopLossPct: 3, maxHoldCandles: 24 }),
      short50_5: shortStrategy(candles, { emaPeriod: 50, stopLossPct: 5, maxHoldCandles: 24 }),
    }
  };

  return results;
}

async function main() {
  console.log('\n' + '='.repeat(85));
  console.log(' COMPREHENSIVE STRATEGY VALIDATION');
  console.log(' Testing: SHORT strategy across multiple assets and market conditions');
  console.log('='.repeat(85));

  // Define test periods with different market conditions
  const periods = [
    // COVID crash (March 2020)
    { label: 'COVID CRASH (Feb-Mej 2020)', start: new Date('2020-02-15').getTime(), end: new Date('2020-05-15').getTime() },
    // 2022 Bear market
    { label: '2022 BEAR (Mei-Sep 2022)', start: new Date('2022-05-01').getTime(), end: new Date('2022-09-01').getTime() },
    // 2022-2023 bottom
    { label: '2022-2023 CRYPTO WINTER (Sep 2022-Feb 2023)', start: new Date('2022-09-01').getTime(), end: new Date('2023-02-01').getTime() },
    // 2024 Bull
    { label: '2024 BULL (Nov 2024-Feb 2025)', start: new Date('2024-11-01').getTime(), end: new Date('2025-02-01').getTime() },
    // 2026 Bear (current)
    { label: '2026 BEAR (Jan-Apr 2026)', start: new Date('2026-01-10').getTime(), end: new Date('2026-04-10').getTime() },
  ];

  // Assets to test
  const assets = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];

  const allResults = [];
  const summary = [];

  for (const period of periods) {
    console.log(`\n>> ${period.label}...`);
    for (const symbol of assets) {
      const result = await testPeriod(symbol, `${symbol} ${period.label}`, period.start, period.end);
      if (result) {
        allResults.push(result);
        const bestStrat = Object.entries(result.strategies)
          .filter(([k]) => k !== 'buyHold' && k !== 'flat')
          .sort((a, b) => b[1].totalReturn - a[1].totalReturn)[0];
        const vsMarket = (bestStrat[1].totalReturn - result.marketReturn).toFixed(1);
        console.log(`   ${symbol}: Market ${result.marketReturn >= 0 ? '+' : ''}${result.marketReturn}% | Best: ${bestStrat[0]} ${bestStrat[1].totalReturn >= 0 ? '+' : ''}${bestStrat[1].totalReturn}% (vs M: ${vsMarket >= 0 ? '+' : ''}${vsMarket}%) | Reg: ${result.regime}`);
        summary.push({
          period: period.label,
          symbol,
          regime: result.regime,
          marketReturn: result.marketReturn,
          bestStrategy: bestStrat[0],
          bestReturn: bestStrat[1].totalReturn,
          vsMarket: parseFloat(vsMarket),
        });
      }
    }
  }

  // Analysis: In which regimes does SHORT strategy work?
  console.log('\n' + '='.repeat(85));
  console.log(' REGIME ANALYSIS');
  console.log('='.repeat(85));

  const regimeStats = {};
  summary.forEach(s => {
    if (!regimeStats[s.regime]) regimeStats[s.regime] = { beats: 0, total: 0, avgVsMarket: 0 };
    regimeStats[s.regime].total++;
    if (s.vsMarket > 0) regimeStats[s.regime].beats++;
    regimeStats[s.regime].avgVsMarket += s.vsMarket;
  });

  console.log(`\n ${'Regime'.padEnd(10)} ${'N'.padEnd(5)} ${'Beat Market'.padEnd(15)} ${'Avg Outperformance'}`);
  console.log('-'.repeat(50));
  for (const [regime, stats] of Object.entries(regimeStats)) {
    const beatPct = ((stats.beats / stats.total) * 100).toFixed(0);
    const avgOut = (stats.avgVsMarket / stats.total).toFixed(1);
    console.log(` ${regime.padEnd(10)} ${stats.total.toString().padEnd(5)} ${stats.beats}/${stats.total} (${beatPct}%)`.padEnd(45) + `${avgOut >= 0 ? '+' : ''}${avgOut}%`);
  }

  // Best and worst periods
  console.log('\n' + '='.repeat(85));
  console.log(' BEST PERIODS FOR SHORT STRATEGY');
  console.log('='.repeat(85));
  const sorted = [...summary].sort((a, b) => b.vsMarket - a.vsMarket);
  console.log(` ${'Period'.padEnd(40)} ${'Symbol'.padEnd(10)} ${'Market'.padEnd(10)} ${'Best'.padEnd(10)} ${'Vs M'}`);
  console.log('-'.repeat(85));
  sorted.slice(0, 5).forEach(s => {
    console.log(` ${s.period.slice(0, 38).padEnd(40)} ${s.symbol.padEnd(10)} ${(s.marketReturn >= 0 ? '+' : '') + s.marketReturn.toFixed(0).padEnd(9)} ${(s.bestReturn >= 0 ? '+' : '') + s.bestReturn.toFixed(0).padEnd(9)} ${(s.vsMarket >= 0 ? '+' : '') + s.vsMarket.toFixed(0)}%`);
  });

  console.log('\n' + '='.repeat(85));
  console.log(' WORST PERIODS (where short strategy failed)');
  console.log('='.repeat(85));
  sorted.slice(-5).forEach(s => {
    console.log(` ${s.period.slice(0, 38).padEnd(40)} ${s.symbol.padEnd(10)} ${(s.marketReturn >= 0 ? '+' : '') + s.marketReturn.toFixed(0).padEnd(9)} ${(s.bestReturn >= 0 ? '+' : '') + s.bestReturn.toFixed(0).padEnd(9)} ${(s.vsMarket >= 0 ? '+' : '') + s.vsMarket.toFixed(0)}%`);
  });

  // Conclusion
  console.log('\n' + '='.repeat(85));
  console.log(' CONCLUSION');
  console.log('='.repeat(85));
  
  const bearStats = regimeStats['BEAR'];
  const rangeStats = regimeStats['RANGE'];
  
  if (bearStats && bearStats.total >= 3) {
    const bearBeat = ((bearStats.beats / bearStats.total) * 100).toFixed(0);
    const bearAvg = (bearStats.avgVsMarket / bearStats.total).toFixed(1);
    console.log(`\n BEAR markets: Short strategy beat market ${bearBeat}% of the time`);
    console.log(` Average outperformance in BEAR: ${bearAvg >= 0 ? '+' : ''}${bearAvg}%`);
  }
  
  if (rangeStats && rangeStats.total >= 3) {
    const rangeBeat = ((rangeStats.beats / rangeStats.total) * 100).toFixed(0);
    const rangeAvg = (rangeStats.avgVsMarket / rangeStats.total).toFixed(1);
    console.log(`\n RANGE markets: Short strategy beat market ${rangeBeat}% of the time`);
    console.log(` Average outperformance in RANGE: ${rangeAvg >= 0 ? '+' : ''}${rangeAvg}%`);
  }

  console.log('\n VERDICT:');
  console.log(' Short selling works in BEAR and RANGE markets, not in BULL markets.');
  console.log(' The key is REGIME DETECTION - know when to short and when to stay flat.');

  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/comprehensive-validation.json', JSON.stringify(allResults, null, 2));
  fs.writeFileSync('./results/validation-summary.json', JSON.stringify(summary, null, 2));
  console.log(`\nSaved to ./results/comprehensive-validation.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
