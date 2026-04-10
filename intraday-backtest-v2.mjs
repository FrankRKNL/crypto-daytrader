import axios from 'axios';
import fs from 'fs';

// ============================================================
// CONFIG
// ============================================================
const INITIAL_BALANCE = 100;
const FEE_RATE       = 0.001;
const SLIPPAGE       = 0.0005;
const OUTPUT_DIR     = './results';

// ============================================================
// DATA FETCHING
// ============================================================
async function fetchBinanceCandles(symbol = 'BTCUSDT', interval = '5m', days = 30) {
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  console.log(`Fetching ${symbol} ${interval} for ${days} days...`);
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

// ============================================================
// INDICATORS
// ============================================================
function ema(data, period) {
  const k = 2 / (period + 1);
  let cur = data[0];
  return data.map(v => { cur = v * k + cur * (1 - k); return cur; });
}
function sma(data, period) {
  return data.map((v, i) => {
    if (i < period - 1) return null;
    return data.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0) / period;
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
function macd(prices, fast = 12, slow = 26, signal = 9) {
  const efast = ema(prices, fast), eslow = ema(prices, slow);
  const macdLine = efast.map((f, i) => f - eslow[i]);
  const signalLine = ema(macdLine, signal);
  return macdLine.map((m, i) => ({ macd: m, signal: signalLine[i], hist: m - signalLine[i] }));
}
function atr(high, low, close, period = 14) {
  const tr = high.map((h, i) => {
    if (i === 0) return high[0] - low[0];
    return Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  });
  return sma(tr, period);
}
function stoch(high, low, close, period = 14) {
  return close.map((c, i) => {
    if (i < period - 1) return null;
    const hh = Math.max(...high.slice(i - period + 1, i + 1));
    const ll = Math.min(...low.slice(i - period + 1, i + 1));
    return hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100;
  });
}
function vwap(high, low, close, volume) {
  let cumVP = 0, cumV = 0;
  return close.map((c, i) => {
    const typical = (high[i] + low[i] + c) / 3;
    cumVP += typical * volume[i]; cumV += volume[i];
    return cumV === 0 ? c : cumVP / cumV;
  });
}
function bollinger(prices, period = 20, stdDev = 2) {
  const sm = sma(prices, period);
  return prices.map((p, i) => {
    if (i < period - 1 || sm[i] === null) return null;
    const variance = prices.slice(i - period + 1, i + 1).reduce((s, x) => s + Math.pow(x - sm[i], 2), 0) / period;
    return { upper: sm[i] + stdDev * Math.sqrt(variance), middle: sm[i], lower: sm[i] - stdDev * Math.sqrt(variance) };
  });
}
function adx(high, low, close, period = 14) {
  const plusDM = high.map((h, i) => i === 0 ? 0 : Math.max(h - high[i - 1], 0));
  const minusDM = low.map((l, i) => i === 0 ? 0 : Math.max(low[i - 1] - l, 0));
  const tr = atr(high, low, close, period).map((v, i) => v * period);
  const plusDI = plusDM.map((v, i) => tr[i] === 0 ? 0 : v / tr[i] * 100);
  const minusDI = minusDM.map((v, i) => tr[i] === 0 ? 0 : v / tr[i] * 100);
  const dx = plusDI.map((p, i) => (p + minusDI[i] === 0) ? 0 : Math.abs(p - minusDI[i]) / (p + minusDI[i]) * 100);
  return ema(dx, period);
}

// ============================================================
// BACKTEST ENGINE v2 (fixed scalp, better stats)
// ============================================================
function backtest(candles, strat) {
  let cash = INITIAL_BALANCE, btc = 0, pos = false, short = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let longs = 0, shorts = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const ctx = { i, candles, cash, btc, pos, short };

    // Entry
    if (!pos && !short) {
      if (strat.entry && strat.entry(ctx, c, p, i)) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true; longs++;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, reason: strat.name });
      } else if (strat.shortEntry && strat.shortEntry(ctx, c, p, i)) {
        const sellPrice = c.close * (1 - SLIPPAGE);
        btc = cash / sellPrice; cash = 0; short = true; shorts++;
        trades.push({ action: 'SHORT', price: sellPrice, ts: c.ts, reason: strat.name });
      }
    }

    // Exit logic
    if (pos) {
      const lastTrade = trades[trades.length - 1];
      let exit = false, exitReason = '';
      if (strat.exit && strat.exit(ctx, c, p, i)) { exit = true; exitReason = 'signal'; }
      if (strat.stopLoss && strat.stopLoss(ctx, c, p, i)) { exit = true; exitReason = 'SL'; }
      if (strat.takeProfit && strat.takeProfit(ctx, c, p, i)) { exit = true; exitReason = 'TP'; }
      if (strat.targetPct) {
        const pnl = (c.close - lastTrade.price) / lastTrade.price * 100;
        if (pnl >= strat.targetPct) { exit = true; exitReason = `TP+${strat.targetPct}%`; }
        if (pnl <= -(strat.stopLossPct || 1.0)) { exit = true; exitReason = `SL-${strat.stopLossPct || 1.0}%`; }
      }
      if (exit) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / lastTrade.price - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0; pos = false;
        trades.push({ action: 'CLOSE LONG', price: sellPrice, pnl, ts: c.ts, reason: exitReason });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
      }
    }

    if (short) {
      const lastTrade = trades[trades.length - 1];
      let cover = false, coverReason = '';
      if (strat.exit && strat.exit(ctx, c, p, i)) { cover = true; coverReason = 'signal'; }
      if (strat.stopLoss && strat.stopLoss(ctx, c, p, i)) { cover = true; coverReason = 'SL'; }
      if (strat.takeProfit && strat.takeProfit(ctx, c, p, i)) { cover = true; coverReason = 'TP'; }
      if (strat.targetPct) {
        const pnl = (lastTrade.price / c.close - 1) * 100;
        if (pnl >= strat.targetPct) { cover = true; coverReason = `TP+${strat.targetPct}%`; }
        if (pnl <= -(strat.stopLossPct || 1.0)) { cover = true; coverReason = `SL-${strat.stopLossPct || 1.0}%`; }
      }
      if (cover) {
        const coverPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
        const pnl = (lastTrade.price / coverPrice - 1) * 100;
        cash = btc * coverPrice * (1 - FEE_RATE); btc = 0; short = false;
        trades.push({ action: 'CLOSE SHORT', price: coverPrice, pnl, ts: c.ts, reason: coverReason });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
      }
    }

    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const finalCandle = candles[candles.length - 1];
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = (finalValue / INITIAL_BALANCE - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  const avgWin = wins > 0 ? totalProfit / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;

  return {
    name: strat.name, describe: strat.describe || '',
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    longs, shorts,
    avgWin: parseFloat(avgWin.toFixed(3)),
    avgLoss: parseFloat(avgLoss.toFixed(3)),
    trades,
  };
}

// ============================================================
// STRATEGY ITERATION 2: Improved with stop loss / take profit
// ============================================================
function defineStrategiesV2(candles) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema9   = ema(closes, 9);
  const ema21  = ema(closes, 21);
  const ema50  = ema(closes, 50);
  const rsi14  = rsi(closes, 14);
  const rsi7   = rsi(closes, 7);
  const macdData = macd(closes);
  const stoch14  = stoch(highs, lows, closes, 14);
  const atr14    = atr(highs, lows, closes, 14);
  const vwapData = vwap(highs, lows, closes, volumes);
  const bb20    = bollinger(closes, 20, 2);
  const adx14   = adx(highs, lows, closes, 14);
  const avgVol  = volumes.reduce((s, v) => s + v, 0) / volumes.length;

  return [
    // V2-1: VWAP Deviation with tight SL/TP
    {
      name: 'VWAP Dev v2 (SL1% TP1.5%)',
      describe: 'Buy 0.8% below VWAP, SL 1%, TP 1.5%',
      targetPct: 1.5, stopLossPct: 1.0,
      entry(ctx, c, p, i) { return c.close < vwapData[i] * 0.992; },
      exit(ctx, c, p, i) { return c.close > vwapData[i]; },
    },

    // V2-2: EMA 9/21 with stop loss
    {
      name: 'EMA 9/21 + SL1% TP2%',
      describe: 'EMA crossover + 1% stop loss, 2% take profit',
      targetPct: 2.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) { return ema9[i] > ema21[i] && ema9[i-1] <= ema21[i-1]; },
      exit(ctx, c, p, i) { return ema9[i] < ema21[i] && ema9[i-1] >= ema21[i-1]; },
    },

    // V2-3: RSI 14 < 30 with tight SL/TP
    {
      name: 'RSI14<30 + SL1% TP2%',
      describe: 'Buy RSI oversold, SL 1%, TP 2%',
      targetPct: 2.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) { return rsi14[i] !== null && rsi14[i] < 30; },
      exit(ctx, c, p, i) { return rsi14[i] > 60; },
    },

    // V2-4: MACD histogram reversal + tight stops
    {
      name: 'MACD Hist + SL1% TP1.5%',
      describe: 'MACD histogram reversal + tight stops',
      targetPct: 1.5, stopLossPct: 1.0,
      entry(ctx, c, p, i) { return macdData[i].hist > 0 && macdData[i-1].hist <= 0; },
      exit(ctx, c, p, i) { return macdData[i].hist < 0; },
    },

    // V2-5: Bollinger band + RSI confirm
    {
      name: 'BB touch + RSI<40 + SL1% TP2%',
      describe: 'Buy at lower BB when RSI < 40. Exit at middle BB or SL',
      targetPct: 2.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) {
        if (!bb20[i]) return false;
        return c.low <= bb20[i].lower && rsi14[i] !== null && rsi14[i] < 40;
      },
      exit(ctx, c, p, i) {
        if (!bb20[i]) return false;
        return c.close >= bb20[i].middle;
      },
    },

    // V2-6: ADX Trend filter
    {
      name: 'ADX>25 + EMA cross + SL1.5%',
      describe: 'Only trade EMA cross when ADX > 25 (strong trend)',
      targetPct: 2.5, stopLossPct: 1.5,
      entry(ctx, c, p, i) {
        return adx14[i] !== null && adx14[i] > 25 && ema9[i] > ema21[i] && ema9[i-1] <= ema21[i-1];
      },
      exit(ctx, c, p, i) { return ema9[i] < ema21[i]; },
    },

    // V2-7: Stochastic bounce
    {
      name: 'Stoch<20 + bounce + SL1% TP1.5%',
      describe: 'Buy when stochastic < 20 and turns up',
      targetPct: 1.5, stopLossPct: 1.0,
      entry(ctx, c, p, i) {
        return stoch14[i] !== null && stoch14[i] < 20 && stoch14[i] > stoch14[i-1];
      },
      exit(ctx, c, p, i) { return stoch14[i] > 80; },
    },

    // V2-8: Mean reversion - price far below SMA
    {
      name: 'Price< SMA20*0.95 + bounce + SL1% TP2%',
      describe: 'Buy when price is 5%+ below SMA20, sell at SMA20',
      targetPct: 2.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) {
        if (i < 20) return false;
        const sma20v = sma(closes, 20)[i];
        return c.close < sma20v * 0.95;
      },
      exit(ctx, c, p, i) {
        if (i < 20) return false;
        return c.close >= sma(closes, 20)[i];
      },
    },

    // V2-9: Volume explosion
    {
      name: 'Vol spike 2x + RSI<50 + SL1% TP2%',
      describe: 'Volume spike with some RSI room to run',
      targetPct: 2.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) {
        return c.volume > avgVol * 2 && rsi14[i] !== null && rsi14[i] < 50;
      },
      exit(ctx, c, p, i) { return rsi14[i] > 70; },
    },

    // V2-10: Scalp VWAP bounce (FIXED)
    {
      name: 'Scalp VWAP 0.3/0.3',
      describe: 'Buy VWAP bounce, target 0.3%, SL 0.3%',
      targetPct: 0.3, stopLossPct: 0.3,
      entry(ctx, c, p, i) {
        return p.close < vwapData[i-1] && c.close > vwapData[i];
      },
      exit(ctx, c, p, i) { return false; }, // handled by TP/SL
    },

    // V2-11: EMA 50 trend only (no counter-trend)
    {
      name: 'Trend-only EMA50 + SL1.5 TP2.5',
      describe: 'Only long when above EMA50, no shorting',
      targetPct: 2.5, stopLossPct: 1.5,
      entry(ctx, c, p, i) {
        return closes[i] > ema50[i] && c.close > vwapData[i] && rsi14[i] !== null && rsi14[i] < 40;
      },
      exit(ctx, c, p, i) {
        return closes[i] < ema50[i] || rsi14[i] > 65;
      },
    },

    // V2-12: Intraday range breakdown
    {
      name: 'Range-break + retest + SL1% TP1.5%',
      describe: 'Buy when price breaks 20-period range from above and retests',
      targetPct: 1.5, stopLossPct: 1.0,
      entry(ctx, c, p, i) {
        if (i < 20) return false;
        const rangeHigh = Math.max(...closes.slice(i - 20, i));
        const rangeLow  = Math.min(...closes.slice(i - 20, i));
        const rangeMid  = (rangeHigh + rangeLow) / 2;
        return c.close > rangeHigh && c.close < rangeMid;
      },
      exit(ctx, c, p, i) {
        if (i < 20) return false;
        const rangeLow = Math.min(...closes.slice(i - 20, i));
        return c.close < rangeLow;
      },
    },

    // V2-13: RSI extreme (< 20) only - deep value
    {
      name: 'RSI<20 deep + SL1% TP3%',
      describe: 'Only buy when RSI < 20 (deep capitulation), TP 3%',
      targetPct: 3.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) { return rsi14[i] !== null && rsi14[i] < 20; },
      exit(ctx, c, p, i) { return rsi14[i] > 50; },
    },

    // V2-14: MACD divergence + RSI
    {
      name: 'MACD div + RSI<40 + SL1% TP2%',
      describe: 'MACD bullish divergence + RSI confirm',
      targetPct: 2.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) {
        if (i < 3 || rsi14[i] === null) return false;
        const rsiSlope = rsi14[i] - rsi14[i-3];
        const priceSlope = closes[i] - closes[i-3];
        return rsiSlope > 5 && priceSlope < 0 && rsi14[i] < 40;
      },
      exit(ctx, c, p, i) { return rsi14[i] > 60; },
    },

    // V2-15: AM hour (high volatility trading)
    {
      name: 'AM-session + RSI<40 + SL1% TP2%',
      describe: 'Trade only during high-volatility AM hours when RSI < 40',
      targetPct: 2.0, stopLossPct: 1.0,
      entry(ctx, c, p, i) {
        const hour = new Date(c.ts).getUTCHours();
        const isAM = hour >= 7 && hour <= 14;
        return isAM && rsi14[i] !== null && rsi14[i] < 40;
      },
      exit(ctx, c, p, i) { return rsi14[i] > 60; },
    },
  ];
}

// ============================================================
// RUN
// ============================================================
async function main() {
  const [interval, days] = [process.argv[2] || '5m', parseInt(process.argv[3]) || 30];
  const candles = await fetchBinanceCandles('BTCUSDT', interval, days);
  const strategies = defineStrategiesV2(candles);
  
  const results = [];
  for (const strat of strategies) {
    try {
      results.push(backtest(candles, strat));
    } catch (err) {
      results.push({ name: strat.name, error: err.message });
    }
  }

  results.sort((a, b) => (b.totalReturn ?? -999) - (a.totalReturn ?? -999));

  console.log('\n' + '='.repeat(90));
  console.log(` ITERATION 2 - DAY TRADING BACKTEST | ${interval} | ${days} days | ${candles.length} candles`);
  console.log(` $${INITIAL_BALANCE} start | Fee: ${(FEE_RATE*100).toFixed(2)}% | Slippage: ${(SLIPPAGE*100).toFixed(3)}% | SL+TP enabled`);
  console.log('='.repeat(90));
  console.log(` ${'#'.padEnd(2)} ${'Strategy'.padEnd(38)} ${'Return'.padEnd(8)} ${'Win%'.padEnd(6)} ${'PF'.padEnd(6)} ${'DD%'.padEnd(7)} ${'Trades'.padEnd(7)} ${'Avg W'.padEnd(7)} ${'Avg L'}`);
  console.log('-'.repeat(90));
  results.forEach((r, i) => {
    if (r.error) { console.log(` ${String(i+1).padEnd(2)} ${r.name.padEnd(38)} ERROR`); return; }
    const sign = r.totalReturn >= 0 ? '+' : '';
    const winRate = r.winRate !== undefined ? `${r.winRate.toFixed(0)}%` : '-';
    const pf = r.profitFactor !== undefined ? r.profitFactor.toFixed(2) : '-';
    console.log(` ${String(i+1).padEnd(2)} ${r.name.padEnd(38)} ${sign}${r.totalReturn.toFixed(1).padEnd(7)} ${winRate.padEnd(5)} ${pf.padEnd(6)} ${r.maxDrawdown.toFixed(1).padEnd(6)}% ${String(r.totalTrades).padEnd(6)} ${r.avgWin.toFixed(2).padEnd(7)} ${r.avgLoss.toFixed(2)}`);
  });
  console.log('='.repeat(90));

  const profitable = results.filter(r => !r.error && r.totalReturn > 0);
  console.log(`\n Profitable: ${profitable.length}/${results.length}`);
  if (profitable.length > 0) {
    const best = profitable[0];
    console.log(`\n BEST: ${best.name}`);
    console.log(`   Return: ${best.totalReturn >= 0 ? '+' : ''}${best.totalReturn}%`);
    console.log(`   Win rate: ${best.winRate}% | Profit Factor: ${best.profitFactor}`);
    console.log(`   Max DD: ${best.maxDrawdown}% | Trades: ${best.totalTrades}`);
    console.log(`   Avg win: $${best.avgWin} | Avg loss: $${best.avgLoss}`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(`${OUTPUT_DIR}/backtest-v2-${interval}-${days}d.json`, JSON.stringify(results, null, 2));
  console.log(`\nSaved: ${OUTPUT_DIR}/backtest-v2-${interval}-${days}d.json`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
