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
  const unique = allCandles.filter(c => { if (seen.has(c.ts)) return false; seen.add(c.ts); return true; });
  return unique;
}

function vwap(high, low, close, volume) {
  let cumVP = 0, cumV = 0;
  return close.map((c, i) => {
    const typical = (high[i] + low[i] + c) / 3;
    cumVP += typical * volume[i]; cumV += volume[i];
    return cumV === 0 ? c : cumVP / cumV;
  });
}

function ema(prices, period) {
  const k = 2 / (period + 1);
  let cur = prices[0];
  return prices.map(v => { cur = v * k + cur * (1 - k); return cur; });
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
      gains = ag; losses = al;
    } else result.push(null);
  }
  return result;
}

function backtest(candles, { devThreshold, exitMultiplier, emaPeriod, rsiThreshold }) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const vwapData = vwap(highs, lows, closes, volumes);
  const emaData  = emaPeriod > 0 ? ema(closes, emaPeriod) : null;
  const rsiData  = rsiThreshold > 0 ? rsi(closes, 14) : null;

  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];

    if (!pos) {
      const entryCond = c.close < vwapData[i] * (1 - devThreshold);
      const emaOk = !emaData || closes[i] > emaData[i];
      const rsiOk  = !rsiData  || (rsiData[i] !== null && rsiData[i] < rsiThreshold);
      if (entryCond && emaOk && rsiOk) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, date: new Date(c.ts).toISOString() });
      }
    } else {
      const lastTrade = trades[trades.length - 1];
      const exitPrice = vwapData[i] * (1 + exitMultiplier);
      if (c.close >= exitPrice) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / lastTrade.price - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0; pos = false;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, date: new Date(c.ts).toISOString() });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
      }
    }

    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Close at end if still in position
  const finalPrice = candles[candles.length - 1].close;
  const finalValue = pos ? btc * finalPrice : cash;
  if (pos) trades.push({ action: 'CLOSE (end)', price: finalPrice, pnl: 0 });

  const totalReturn = (finalValue / INITIAL_BALANCE - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;

  return {
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

async function main() {
  console.log('\n=============================================================');
  console.log(' VWAP OPTIMIZED - 15m x 90 DAYS (Jan-Apr 2026)');
  console.log('=============================================================');

  // Best params from optimization: dev=1.0%, exp=0.3%, EMA=20, RSI=50
  const candles = await fetchBinanceCandles('BTCUSDT', '15m', 90);
  console.log(`Loaded ${candles.length} candles`);
  console.log(`Range: ${new Date(candles[0].ts).toISOString()} → ${new Date(candles[candles.length-1].ts).toISOString()}`);
  
  const params = [
    { devThreshold: 0.01, exitMultiplier: 0.003, emaPeriod: 20, rsiThreshold: 50, label: 'OPTIMAL (dev=1%, exp=0.3%, EMA20, RSI50)' },
    { devThreshold: 0.008, exitMultiplier: 0.003, emaPeriod: 20, rsiThreshold: 50, label: 'dev=0.8%' },
    { devThreshold: 0.012, exitMultiplier: 0.003, emaPeriod: 20, rsiThreshold: 50, label: 'dev=1.2%' },
    { devThreshold: 0.01, exitMultiplier: 0.005, emaPeriod: 20, rsiThreshold: 50, label: 'exp=0.5%' },
    { devThreshold: 0.01, exitMultiplier: 0.003, emaPeriod: 50, rsiThreshold: 50, label: 'EMA50' },
    { devThreshold: 0.01, exitMultiplier: 0.003, emaPeriod: 20, rsiThreshold: 30, label: 'RSI30' },
    { devThreshold: 0.01, exitMultiplier: 0.003, emaPeriod: 0,  rsiThreshold: 0,  label: 'NO FILTERS' },
    { devThreshold: 0.015, exitMultiplier: 0.005, emaPeriod: 20, rsiThreshold: 50, label: 'wider dev+exit' },
  ];

  const results = [];
  for (const p of params) {
    const r = backtest(candles, p);
    results.push({ label: p.label, ...r });
    const sign = r.totalReturn >= 0 ? '+' : '';
    console.log(`\n ${p.label}`);
    console.log(`   Return: ${sign}${r.totalReturn}% | Win: ${r.winRate}% | PF: ${r.profitFactor} | DD: ${r.maxDrawdown}% | Trades: ${r.totalTrades} | Avg: $${r.avgWin} / -$${r.avgLoss}`);
    if (r.trades.length > 0) {
      const closed = r.trades.filter(t => t.pnl !== undefined && t.pnl !== 0);
      closed.slice(0, 5).forEach(t => {
        const signP = t.pnl >= 0 ? '+' : '';
        console.log(`   ${t.date} ${t.action} @ $${t.price.toFixed(2)} => ${signP}${t.pnl.toFixed(2)}%`);
      });
    }
  }

  // Save all results
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/vwap-optimized-90d.json', JSON.stringify(results, null, 2));
  console.log(`\n=============================================================`);
  
  const best = results.reduce((a, b) => a.totalReturn > b.totalReturn ? a : b);
  console.log(`BEST: ${best.label} => ${best.totalReturn >= 0 ? '+' : ''}${best.totalReturn}%`);
  console.log(`=============================================================`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
