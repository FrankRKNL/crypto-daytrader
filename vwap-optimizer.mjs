import axios from 'axios';
import fs from 'fs';

const INITIAL_BALANCE = 100;
const FEE_RATE = 0.001;
const SLIPPAGE = 0.0005;

async function fetchBinanceCandles(symbol = 'BTCUSDT', interval = '15m', days = 60) {
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
  console.log(`Loaded ${unique.length} candles (${new Date(unique[0].ts).toISOString()} → ${new Date(unique[unique.length-1].ts).toISOString()})`);
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

function sma(prices, period) {
  return prices.map((v, i) => {
    if (i < period - 1) return null;
    return prices.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0) / period;
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
      gains = ag; losses = al;
    } else result.push(null);
  }
  return result;
}

function backtest(candles, {
  vwapDevThreshold = 0.01,
  exitMultiplier = 0.005,
  useEmaFilter = false,
  emaPeriod = 50,
  useRsiFilter = false,
  rsiThreshold = 40,
}) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const vwapData = vwap(highs, lows, closes, volumes);
  const ema50 = useEmaFilter ? ema(closes, emaPeriod) : null;
  const rsi14 = useRsiFilter ? rsi(closes, 14) : null;

  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const ctx = { i, candles, cash, btc, pos };

    if (!pos) {
      // Entry: price drops below VWAP by threshold
      const meetsEma = !useEmaFilter || closes[i] > ema50[i];
      const meetsRsi  = !useRsiFilter  || (rsi14[i] !== null && rsi14[i] < rsiThreshold);
      if (c.close < vwapData[i] * (1 - vwapDevThreshold) && meetsEma && meetsRsi) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts });
      }
    } else {
      const lastTrade = trades[trades.length - 1];
      // Exit: price returns to VWAP (exitMultiplier)
      const exitPrice = vwapData[i] * (1 + exitMultiplier);
      if (c.close >= exitPrice) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / lastTrade.price - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0; pos = false;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
      }
    }

    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalValue = cash + btc * candles[candles.length - 1].close;
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
  };
}

async function main() {
  const candles = await fetchBinanceCandles('BTCUSDT', '15m', 60);
  const closes = candles.map(c => c.close);

  // Grid search over VWAP parameters
  const thresholds = [0.005, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025, 0.03];
  const exitMults  = [0.003, 0.005, 0.008, 0.01, 0.015, 0.02];
  const emaPeriods = [0, 20, 50, 100, 200];
  const rsiThresholds = [0, 30, 40, 50];

  console.log('\n VWAP DEVIATION PARAMETER OPTIMIZATION');
  console.log(' 15m candles | 60 days | BTC/USDT');
  console.log('='.repeat(75));

  const results = [];

  for (const vt of thresholds) {
    for (const em of exitMults) {
      for (const ep of emaPeriods) {
        for (const rt of rsiThresholds) {
          const useEma = ep > 0;
          const useRsi = rt > 0;
          const r = backtest(candles, {
            vwapDevThreshold: vt,
            exitMultiplier: em,
            useEmaFilter: useEma,
            emaPeriod: ep,
            useRsiFilter: useRsi,
            rsiThreshold: rt,
          });
          if (r.totalTrades > 0) {
            results.push({
              vt, em, ep, rt,
              ...r,
              label: `dev=${(vt*100).toFixed(1)}% exp=${(em*100).toFixed(1)}% EMA=${ep||'none'} RSI=${rt||'none'}`,
            });
          }
        }
      }
    }
  }

  results.sort((a, b) => b.totalReturn - a.totalReturn);

  console.log('\n TOP 15 PARAMETER COMBINATIONS:');
  console.log('='.repeat(75));
  console.log(` ${'Rank'.padEnd(4)} ${'VWAP Dev'.padEnd(10)} ${'Exit Mult'.padEnd(10)} ${'EMA'.padEnd(5)} ${'RSI'.padEnd(5)} ${'Return'.padEnd(8)} ${'Win%'.padEnd(6)} ${'PF'.padEnd(6)} ${'DD%'.padEnd(7)} ${'Trades'}`);
  console.log('-'.repeat(75));
  results.slice(0, 15).forEach((r, i) => {
    const sign = r.totalReturn >= 0 ? '+' : '';
    console.log(` ${String(i+1).padEnd(4)} ${(r.vt*100).toFixed(1).padEnd(10)}% ${(r.em*100).toFixed(1).padEnd(10)}% ${String(r.ep).padEnd(5)} ${String(r.rt).padEnd(5)} ${sign}${r.totalReturn.toFixed(1).padEnd(7)} ${r.winRate.toFixed(0).padEnd(5)}% ${r.profitFactor.toFixed(2).padEnd(6)} ${r.maxDrawdown.toFixed(1).padEnd(6)}% ${r.totalTrades}`);
  });

  // Also show bottom 5
  console.log('\n WORST 5:');
  results.slice(-5).forEach((r, i) => {
    const sign = r.totalReturn >= 0 ? '+' : '';
    console.log(`  dev=${(r.vt*100).toFixed(1)}% exp=${(r.em*100).toFixed(1)}% EMA=${r.ep||'none'} RSI=${r.rt||'none'} => ${sign}${r.totalReturn}%, ${r.totalTrades} trades`);
  });

  fs.writeFileSync('./results/vwap-optimization.json', JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} combinations to ./results/vwap-optimization.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
