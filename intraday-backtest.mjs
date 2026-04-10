import axios from 'axios';
import fs from 'fs';

// ============================================================
// CONFIG
// ============================================================
const INITIAL_BALANCE = 100;       // USD
const FEE_RATE       = 0.001;     // Binance maker fee ~0.1%
const SLIPPAGE       = 0.0005;    // 0.05% slippage per trade
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
      ts:     c[0],
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
    allCandles.push(...candles);
    if (candles.length < 1000) break;
    currentStart = candles[candles.length - 1].ts + 1;
  }
  
  // Sort by timestamp ascending
  allCandles.sort((a, b) => a.ts - b.ts);
  
  // Remove duplicates
  const seen = new Set();
  const unique = allCandles.filter(c => {
    if (seen.has(c.ts)) return false;
    seen.add(c.ts);
    return true;
  });
  
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
    gains  += ch > 0 ? ch : 0;
    losses += ch < 0 ? Math.abs(ch) : 0;
    if (i >= period) {
      if (i > period) { gains = gains * (period - 1) / period; losses = losses * (period - 1) / period; }
      const ag = gains / period, al = losses / period;
      result.push(ag + al === 0 ? 50 : 100 - 100 / (1 + ag / al));
      gains = ag; losses = al;
    } else {
      result.push(null);
    }
  }
  return result;
}

function macd(prices, fast = 12, slow = 26, signal = 9) {
  const efast = ema(prices, fast);
  const eslow = ema(prices, slow);
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
    const sliceH = high.slice(i - period + 1, i + 1);
    const sliceL = low.slice(i - period + 1, i + 1);
    const hh = Math.max(...sliceH);
    const ll = Math.min(...sliceL);
    return hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100;
  });
}

function vwap(high, low, close, volume) {
  let cumVP = 0, cumV = 0;
  return close.map((c, i) => {
    const typical = (high[i] + low[i] + c) / 3;
    cumVP += typical * volume[i];
    cumV  += volume[i];
    return cumV === 0 ? c : cumVP / cumV;
  });
}

function bollinger(prices, period = 20, stdDev = 2) {
  const sm = sma(prices, period);
  return prices.map((p, i) => {
    if (i < period - 1 || sm[i] === null) return null;
    const slice = prices.slice(i - period + 1, i + 1);
    const variance = slice.reduce((s, x) => s + Math.pow(x - sm[i], 2), 0) / period;
    return { upper: sm[i] + stdDev * Math.sqrt(variance), middle: sm[i], lower: sm[i] - stdDev * Math.sqrt(variance) };
  });
}

// ============================================================
// BACKTEST ENGINE
// ============================================================
function backtest(candles, { name, describe, entry, exit, stopLoss, takeProfit, onInterval }) {
  let cash   = INITIAL_BALANCE;
  let btc    = 0;
  let pos    = false;  // false = flat, true = long
  let short  = false;   // false = flat, true = short
  const trades = [];
  let peak   = cash;
  let maxDD  = 0;
  let wins   = 0, losses = 0;
  let totalProfit = 0, totalLoss = 0;
  let longs  = 0, shorts = 0;
  let longWins = 0, shortWins = 0;

  for (let i = 1; i < candles.length; i++) {
    const c   = candles[i];
    const p   = candles[i - 1];
    const ctx = { i, candles, cash, btc, pos, short };

    // Entry signals
    if (!pos && !short) {
      if (entry(ctx, c, p, i)) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc  = cash / buyPrice;
        cash = 0;
        pos  = true;
        longs++;
        trades.push({ ts: c.ts, action: 'LONG', price: buyPrice, reason: entry.name || 'entry', balance: cash });
      } else if (entry.short && entry.short(ctx, c, p, i)) {
        const sellPrice = c.close * (1 - SLIPPAGE);
        btc   = cash / sellPrice;
        cash  = 0;
        short = true;
        shorts++;
        trades.push({ ts: c.ts, action: 'SHORT', price: sellPrice, reason: entry.short.name || 'short', balance: cash });
      }
    }

    // Exit signals
    if (pos) {
      let shouldExit = false;
      let exitReason = '';
      
      if (exit && exit(ctx, c, p, i)) { shouldExit = true; exitReason = 'exit signal'; }
      if (stopLoss && stopLoss(ctx, c, p, i)) { shouldExit = true; exitReason = 'stop loss'; }
      if (takeProfit && takeProfit(ctx, c, p, i)) { shouldExit = true; exitReason = 'take profit'; }

      if (shouldExit) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / trades[trades.length - 1].price - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE);
        btc = 0; pos = false;
        trades.push({ ts: c.ts, action: 'CLOSE LONG', price: sellPrice, pnl, reason: exitReason, balance: cash });
        if (pnl > 0) { wins++; longWins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
      }
    }

    if (short) {
      let shouldCover = false;
      let coverReason = '';
      
      if (exit && exit(ctx, c, p, i)) { shouldCover = true; coverReason = 'exit signal'; }
      if (stopLoss && stopLoss(ctx, c, p, i)) { shouldCover = true; coverReason = 'stop loss'; }
      if (takeProfit && takeProfit(ctx, c, p, i)) { shouldCover = true; coverReason = 'take profit'; }

      if (shouldCover) {
        const coverPrice = c.close * (1 + SLIPPAGE + FEE_RATE);
        const pnl = (trades[trades.length - 1].price / coverPrice - 1) * 100;
        cash = btc * coverPrice * (1 - FEE_RATE);
        btc = 0; short = false;
        trades.push({ ts: c.ts, action: 'CLOSE SHORT', price: coverPrice, pnl, reason: coverReason, balance: cash });
        if (pnl > 0) { wins++; shortWins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
      }
    }

    // Track drawdown
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;

    // Interval callback (for logging, stats, etc.)
    if (onInterval) onInterval(i, c, { cash, btc, pos, short, value });
  }

  // Close any open position
  const finalCandle = candles[candles.length - 1];
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = (finalValue / INITIAL_BALANCE - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  const avgWin = wins > 0 ? totalProfit / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;

  return {
    name, describe,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue:  parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate:     parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: Math.floor(trades.length / 2),
    longs, shorts,
    longWins, shortWins,
    avgWin:      parseFloat(avgWin.toFixed(2)),
    avgLoss:     parseFloat(avgLoss.toFixed(2)),
    trades,
  };
}

// ============================================================
// STRATEGY DEFINITIONS
// ============================================================
function defineStrategies(candles) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema9   = ema(closes, 9);
  const ema21  = ema(closes, 21);
  const ema50  = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14  = rsi(closes, 14);
  const rsi7   = rsi(closes, 7);
  const macdData = macd(closes);
  const stoch14  = stoch(highs, lows, closes, 14);
  const atr14    = atr(highs, lows, closes, 14);
  const vwapData = vwap(highs, lows, closes, volumes);
  const bb20    = bollinger(closes, 20, 2);

  const avgVolume = volumes.reduce((s, v) => s + v, 0) / volumes.length;

  return [
    // ================================================
    // STRATEGY 1: EMA 9/21 Crossover
    // ================================================
    {
      name: 'EMA 9/21 Crossover',
      describe: 'Long when 9 EMA crosses above 21 EMA. Exit when reverse.',
      entry(ctx, c, p, i) {
        return ema9[i] > ema21[i] && ema9[i-1] <= ema21[i-1];
      },
      exit(ctx, c, p, i) {
        return ema9[i] < ema21[i] && ema9[i-1] >= ema21[i-1];
      },
    },

    // ================================================
    // STRATEGY 2: RSI Reversal (mean reversion)
    // ================================================
    {
      name: 'RSI Reversal (Long < 30)',
      describe: 'Buy when RSI < 30 (oversold). Sell when RSI > 60.',
      entry(ctx, c, p, i) {
        return rsi14[i] !== null && rsi14[i] < 30;
      },
      exit(ctx, c, p, i) {
        return rsi14[i] > 60;
      },
    },

    // ================================================
    // STRATEGY 3: MACD Histogram Reversal
    // ================================================
    {
      name: 'MACD Histogram Reversal',
      describe: 'Buy when MACD histogram turns positive. Sell when negative.',
      entry(ctx, c, p, i) {
        return macdData[i].hist > 0 && macdData[i-1].hist <= 0;
      },
      exit(ctx, c, p, i) {
        return macdData[i].hist < 0 && macdData[i-1].hist >= 0;
      },
    },

    // ================================================
    // STRATEGY 4: Stochastic Overbought/Oversold
    // ================================================
    {
      name: 'Stochastic (K < 20 long, K > 80 exit)',
      describe: 'Buy when stochastic %K < 20, exit when %K > 80.',
      entry(ctx, c, p, i) {
        return stoch14[i] !== null && stoch14[i] < 20;
      },
      exit(ctx, c, p, i) {
        return stoch14[i] > 80;
      },
    },

    // ================================================
    // STRATEGY 5: VWAP Deviation
    // ================================================
    {
      name: 'VWAP Deviation (+1% below, +0.5% above)',
      describe: 'Buy when price drops 1%+ below VWAP. Sell when price > VWAP + 0.5%.',
      entry(ctx, c, p, i) {
        return c.close < vwapData[i] * 0.99;
      },
      exit(ctx, c, p, i) {
        return c.close > vwapData[i] * 1.005;
      },
    },

    // ================================================
    // STRATEGY 6: Bollinger Band Bounce
    // ================================================
    {
      name: 'Bollinger Band Bounce',
      describe: 'Buy when price touches lower band. Sell at middle band.',
      entry(ctx, c, p, i) {
        if (!bb20[i]) return false;
        return c.low <= bb20[i].lower;
      },
      exit(ctx, c, p, i) {
        if (!bb20[i]) return false;
        return c.close >= bb20[i].middle;
      },
    },

    // ================================================
    // STRATEGY 7: Volume Spike + RSI
    // ================================================
    {
      name: 'Volume Spike + RSI Confirm',
      describe: 'Buy when volume > 2x average AND RSI < 40. Sell when RSI > 60.',
      entry(ctx, c, p, i) {
        return c.volume > avgVolume * 2 && rsi14[i] !== null && rsi14[i] < 40;
      },
      exit(ctx, c, p, i) {
        return rsi14[i] > 60;
      },
    },

    // ================================================
    // STRATEGY 8: EMA Trend + RSI Filter
    // ================================================
    {
      name: 'EMA Trend (50) + RSI Filter',
      describe: 'Only long when price > EMA50 AND RSI < 40. Sell when RSI > 65.',
      entry(ctx, c, p, i) {
        return closes[i] > ema50[i] && rsi14[i] !== null && rsi14[i] < 40;
      },
      exit(ctx, c, p, i) {
        return rsi14[i] > 65;
      },
    },

    // ================================================
    // STRATEGY 9: News-Ready Momentum (RSI 7 fast)
    // ================================================
    {
      name: 'RSI-7 Momentum Burst',
      describe: 'Buy when fast RSI(7) crosses above 50 from below. Sell when RSI(7) < 40.',
      entry(ctx, c, p, i) {
        return rsi7[i] > 50 && rsi7[i-1] <= 50;
      },
      exit(ctx, c, p, i) {
        return rsi7[i] < 40;
      },
    },

    // ================================================
    // STRATEGY 10: Breakout + ATR confirmation
    // ================================================
    {
      name: 'Breakout + ATR Volatility Filter',
      describe: 'Buy on 20-period high breakout with ATR confirmation. Exit on opposite signal.',
      entry(ctx, c, p, i) {
        if (i < 20 || atr14[i] === null) return false;
        const recentHigh = Math.max(...closes.slice(i - 20, i));
        const atrVal = atr14[i];
        return c.close > recentHigh && (c.close - closes[i-1]) > atrVal * 0.5;
      },
      exit(ctx, c, p, i) {
        if (i < 20 || atr14[i] === null) return false;
        const recentLow = Math.min(...closes.slice(i - 20, i));
        return c.close < recentLow;
      },
    },

    // ================================================
    // STRATEGY 11: Short Setup (bearish)
    // ================================================
    {
      name: 'Short: RSI > 70 + EMA Death Cross',
      describe: 'SHORT when RSI > 70 AND EMA9 crosses below EMA21.',
      entry(ctx, c, p, i) {
        return rsi14[i] !== null && rsi14[i] > 70 && ema9[i] < ema21[i] && ema9[i-1] >= ema21[i-1];
      },
      exit(ctx, c, p, i) {
        return rsi14[i] < 40 || (ema9[i] > ema21[i] && ema9[i-1] <= ema21[i-1]);
      },
      short: { name: 'short-entry' },
    },

    // ================================================
    // STRATEGY 12: Mean Reversion + Trend
    // ================================================
    {
      name: 'Mean Reversion + Trend (SMA 20)',
      describe: 'Buy when price is 3%+ below SMA20 AND price above SMA50 (uptrend confirmation). Sell at SMA20.',
      entry(ctx, c, p, i) {
        if (i < 50 || sma(closes, 20)[i] === null) return false;
        const sma20 = sma(closes, 20)[i];
        return c.close < sma20 * 0.97 && closes[i] > ema50[i];
      },
      exit(ctx, c, p, i) {
        if (sma(closes, 20)[i] === null) return false;
        return c.close >= sma(closes, 20)[i];
      },
    },

    // ================================================
    // STRATEGY 13: Intraday Scalp (15m VWAP)
    // ================================================
    {
      name: 'Scalp: 5m VWAP Rebound',
      describe: 'Buy when 5m price rebounds from VWAP from below. Target +0.3%, stop -0.3%.',
      entry(ctx, c, p, i) {
        return p.close < vwapData[i-1] && c.close > vwapData[i];
      },
      exit(ctx, c, p, i) {
        const entryIdx = trades.filter(t => t.action === 'LONG').length;
        const lastLong = trades.filter(t => t.action === 'LONG')[trades.filter(t => t.action === 'LONG').length - 1];
        if (!lastLong) return false;
        const pnl = (c.close - lastLong.price) / lastLong.price * 100;
        return pnl > 0.3 || pnl < -0.3;
      },
    },
  ];
}

// ============================================================
// RUN BACKTEST
// ============================================================
function runBacktest(candles, strategies) {
  const results = [];
  for (const strat of strategies) {
    try {
      const r = backtest(candles, strat);
      results.push(r);
    } catch (err) {
      results.push({ name: strat.name, describe: strat.describe, error: err.message });
    }
  }
  return results;
}

// ============================================================
// PRINT RESULTS
// ============================================================
function printResults(results, candleCount, interval) {
  results.sort((a, b) => (b.totalReturn ?? -999) - (a.totalReturn ?? -999));

  console.log('\n' + '='.repeat(85));
  console.log(` DAY TRADING BACKTEST RESULTS | ${interval} candles | ${candleCount} candles | $${INITIAL_BALANCE} start`);
  console.log('='.repeat(85));
  console.log(` Fee: ${(FEE_RATE*100).toFixed(2)}% | Slippage: ${(SLIPPAGE*100).toFixed(3)}%`);
  console.log('='.repeat(85));
  console.log(` ${'#'.padEnd(2)} ${'Strategy'.padEnd(35)} ${'Return'.padEnd(8)} ${'Win%'.padEnd(6)} ${'PF'.padEnd(6)} ${'DD%'.padEnd(7)} ${'Trades'.padEnd(7)} ${'Avg Win'.padEnd(8)} ${'Avg Loss'}`);
  console.log('-'.repeat(85));

  results.forEach((r, idx) => {
    if (r.error) { console.log(` ${String(idx+1).padEnd(2)} ${r.name.padEnd(35)} ERROR: ${r.error}`); return; }
    const sign = r.totalReturn >= 0 ? '+' : '';
    const signDD = r.maxDrawdown >= 0 ? '' : '-';
    const winRate = r.winRate !== undefined ? `${r.winRate.toFixed(0)}%` : '-';
    const pf = r.profitFactor !== undefined ? r.profitFactor.toFixed(2) : '-';
    console.log(` ${String(idx+1).padEnd(2)} ${r.name.padEnd(35)} ${sign}${r.totalReturn.toFixed(1).padEnd(7)} ${winRate.padEnd(5)} ${pf.padEnd(6)} ${r.maxDrawdown.toFixed(1).padEnd(6)}% ${String(r.totalTrades).padEnd(6)} ${r.avgWin.toFixed(2).padEnd(8)} ${r.avgLoss.toFixed(2)}`);
  });

  console.log('='.repeat(85));

  // Summary
  const profitable = results.filter(r => !r.error && r.totalReturn > 0);
  const totalReturn = results.filter(r => !r.error);
  console.log(`\nSUMMARY:`);
  console.log(` Total strategies tested: ${results.length}`);
  console.log(` Profitable: ${profitable.length} (${(profitable.length/results.length*100).toFixed(0)}%)`);
  if (profitable.length > 0) {
    const best = profitable[0];
    console.log(` BEST: ${best.name} with ${best.totalReturn >= 0 ? '+' : ''}${best.totalReturn}% return`);
    console.log(`   Win rate: ${best.winRate}% | Profit Factor: ${best.profitFactor} | Max DD: ${best.maxDrawdown}%`);
    console.log(`   ${best.totalTrades} trades | Avg win: $${best.avgWin} | Avg loss: $${best.avgLoss}`);
  }

  return results;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  try {
    const [interval, days] = [process.argv[2] || '5m', parseInt(process.argv[3]) || 30];
    const symbol = 'BTCUSDT';

    const candles = await fetchBinanceCandles(symbol, interval, days);
    const strategies = defineStrategies(candles);
    const results = runBacktest(candles, strategies);
    const ranked = printResults(results, candles.length, interval);

    // Save results
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const report = {
      timestamp: new Date().toISOString(),
      symbol,
      interval,
      days,
      candleCount: candles.length,
      initialBalance: INITIAL_BALANCE,
      feeRate: FEE_RATE,
      slippage: SLIPPAGE,
      results: ranked.map(r => ({
        name: r.name,
        describe: r.describe,
        totalReturn: r.totalReturn,
        finalValue: r.finalValue,
        maxDrawdown: r.maxDrawdown,
        winRate: r.winRate,
        profitFactor: r.profitFactor,
        totalTrades: r.totalTrades,
        longs: r.longs,
        shorts: r.shorts,
        avgWin: r.avgWin,
        avgLoss: r.avgLoss,
      })),
    };
    fs.writeFileSync(`${OUTPUT_DIR}/backtest-${interval}-${days}d.json`, JSON.stringify(report, null, 2));
    console.log(`\nResults saved to ${OUTPUT_DIR}/backtest-${interval}-${days}d.json`);

  } catch (err) {
    console.error('Fatal:', err.message);
    process.exit(1);
  }
}

main();
