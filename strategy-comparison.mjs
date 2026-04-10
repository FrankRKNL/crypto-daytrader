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

function vwap(highs, lows, closes, volumes) {
  let cumVP = 0, cumV = 0;
  return closes.map((c, i) => {
    const typical = (highs[i] + lows[i] + c) / 3;
    cumVP += typical * volumes[i]; cumV += volumes[i];
    return cumV === 0 ? c : cumVP / cumV;
  });
}

// STRATEGY 1: Momentum Breakout
// Buy when price breaks above EMA with strength
function momentumBacktest(candles, config = {}) {
  const { emaPeriod = 20, atrMultiplier = 2, holdHours = 4 } = config;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const emaData = ema(closes, emaPeriod);
  const atrData = atr(highs, lows, closes, 14);
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  
  for (let i = emaPeriod + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const atrVal = atrData[i];
    
    if (!pos) {
      // Entry: price crosses above EMA + ATR confirmation
      const aboveEma = closes[i] > emaData[i];
      const prevBelow = closes[i-1] <= emaData[i-1];
      const volumeSpike = volumes[i] > volumes[i-1] * 1.5;
      
      if (aboveEma && prevBelow && atrVal && volumeSpike) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, reason: 'EMA breakout + volume' });
      }
    } else {
      // Exit: ATR-based stop or hold time exceeded
      const holdCandles = holdHours * 4; // 15m candles
      const elapsed = i - entryIdx;
      
      const stopLoss = entryPrice * (1 - atrMultiplier * atrVal / entryPrice);
      const takeProfit = entryPrice * (1 + atrMultiplier * atrVal / entryPrice);
      
      if (c.low <= stopLoss) {
        const sellPrice = stopLoss * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, reason: 'ATR stop' });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      } else if (c.high >= takeProfit) {
        const sellPrice = takeProfit * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, reason: 'ATR TP' });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      } else if (elapsed >= holdCandles) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, reason: 'timeout' });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      }
    }
    
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const sellPrice = finalCandle.close * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
    trades.push({ action: 'CLOSE EOD', price: sellPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }
  
  const totalTrades = Math.floor(trades.length / 2);
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = ((finalValue / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  
  return {
    name: `Momentum EMA${emaPeriod} ATR${atrMultiplier}x`,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

// STRATEGY 2: RSI Mean Reversion (oversold -> long)
function rsiBacktest(candles, config = {}) {
  const { rsiPeriod = 14, oversold = 35, overbought = 65, holdCandles = 8 } = config;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const rsiData = rsi(closes, rsiPeriod);
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  
  for (let i = rsiPeriod + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    
    if (!pos) {
      if (rsiData[i] !== null && rsiData[i] < oversold) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, rsi: rsiData[i].toFixed(1) });
      }
    } else {
      const elapsed = i - entryIdx;
      const rsiExit = rsiData[i] > overbought;
      const timeExit = elapsed >= holdCandles;
      
      if (rsiExit || timeExit) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, reason: rsiExit ? 'RSI overbought' : 'timeout' });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      }
    }
    
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const sellPrice = finalCandle.close * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
    trades.push({ action: 'CLOSE EOD', price: sellPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }
  
  const totalTrades = Math.floor(trades.length / 2);
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = ((finalValue / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  
  return {
    name: `RSI ${oversold}/${overbought} hold${holdCandles}c`,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

// STRATEGY 3: MACD Crossover
function macdBacktest(candles, config = {}) {
  const { fast = 12, slow = 26, signal = 9, holdCandles = 8 } = config;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  
  // MACD = EMA(fast) - EMA(slow)
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((f, i) => f - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  
  for (let i = slow + signal + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    
    if (!pos) {
      // MACD crosses above signal line
      const macdAbove = macdLine[i] > signalLine[i];
      const prevBelow = macdLine[i-1] <= signalLine[i-1];
      
      if (macdAbove && prevBelow) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, macd: macdLine[i].toFixed(2) });
      }
    } else {
      const elapsed = i - entryIdx;
      // Exit on MACD cross down or time
      const macdBelow = macdLine[i] < signalLine[i];
      
      if (macdBelow || elapsed >= holdCandles) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, reason: macdBelow ? 'MACD cross down' : 'timeout' });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      }
    }
    
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const sellPrice = finalCandle.close * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
    trades.push({ action: 'CLOSE EOD', price: sellPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }
  
  const totalTrades = Math.floor(trades.length / 2);
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = ((finalValue / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  
  return {
    name: `MACD ${fast}/${slow}/${signal} hold${holdCandles}c`,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

// STRATEGY 4: EMA Crossover (multi timeframe)
function emaCrossBacktest(candles, config = {}) {
  const { fast = 9, slow = 21, holdCandles = 12 } = config;
  const closes = candles.map(c => c.close);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  
  for (let i = slow + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    
    if (!pos) {
      const fastAbove = emaFast[i] > emaSlow[i];
      const prevBelow = emaFast[i-1] <= emaSlow[i-1];
      
      if (fastAbove && prevBelow) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts });
      }
    } else {
      const elapsed = i - entryIdx;
      const fastBelow = emaFast[i] < emaSlow[i];
      
      if (fastBelow || elapsed >= holdCandles) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, reason: fastBelow ? 'EMA cross down' : 'timeout' });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      }
    }
    
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const sellPrice = finalCandle.close * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
    trades.push({ action: 'CLOSE EOD', price: sellPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }
  
  const totalTrades = Math.floor(trades.length / 2);
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = ((finalValue / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  
  return {
    name: `EMA Cross ${fast}/${slow} hold${holdCandles}c`,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

// STRATEGY 5: Bollinger Bands Mean Reversion
function bollingerBacktest(candles, config = {}) {
  const { period = 20, stdDev = 2, holdCandles = 8 } = config;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  
  // Calculate Bollinger Bands
  const sma = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    sma.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  
  const bbUpper = sma.map((m, i) => m + stdDev * Math.sqrt(closes.slice(i, i + period).reduce((s, c) => s + (c - m) ** 2, 0) / period));
  const bbLower = sma.map((m, i) => m - stdDev * Math.sqrt(closes.slice(i, i + period).reduce((s, c) => s + (c - m) ** 2, 0) / period));
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  
  for (let i = period; i < candles.length - 1; i++) {
    const c = candles[i];
    const idx = i - period + 1;
    
    if (!pos) {
      // Price touches lower band = oversold
      if (c.low <= bbLower[idx]) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, reason: 'BB lower touch' });
      }
    } else {
      const elapsed = i - entryIdx;
      // Exit when price reaches middle band or upper band
      if (c.high >= sma[idx] || elapsed >= holdCandles) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, reason: c.high >= sma[idx] ? 'BB middle' : 'timeout' });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      }
    }
    
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const sellPrice = finalCandle.close * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
    trades.push({ action: 'CLOSE EOD', price: sellPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }
  
  const totalTrades = Math.floor(trades.length / 2);
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = ((finalValue / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  
  return {
    name: `Bollinger ${period} std${stdDev} hold${holdCandles}c`,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

// COMBINED: Multi-strategy with voting
function multiStrategyBacktest(candles, config = {}) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const ema20 = ema(closes, 20);
  const ema9  = ema(closes, 9);
  const rsiData = rsi(closes, 14);
  const atrData = atr(highs, lows, closes, 14);
  const vwapData = vwap(highs, lows, closes, volumes);
  
  let cash = INITIAL_BALANCE, btc = 0, pos = false;
  const trades = [];
  let peak = cash, maxDD = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  let entryPrice = 0, entryIdx = 0;
  
  // Count how many indicators say LONG
  function longSignals(i) {
    let signals = 0;
    // RSI oversold
    if (rsiData[i] !== null && rsiData[i] < 35) signals++;
    // Price below VWAP
    if ((vwapData[i] - closes[i]) / vwapData[i] > 0.01) signals++;
    // EMA bullish
    if (ema9[i] > ema20[i]) signals++;
    // Volume spike
    if (volumes[i] > volumes[i-1] * 1.5) signals++;
    return signals;
  }
  
  for (let i = 30; i < candles.length - 1; i++) {
    const c = candles[i];
    const signals = longSignals(i);
    
    if (!pos) {
      // Enter if 3+ indicators agree
      if (signals >= 3) {
        const buyPrice = c.close * (1 + SLIPPAGE);
        btc = cash / buyPrice; cash = 0; pos = true;
        entryPrice = buyPrice; entryIdx = i;
        trades.push({ action: 'LONG', price: buyPrice, ts: c.ts, signals });
      }
    } else {
      const elapsed = i - entryIdx;
      const exitSignals = longSignals(i);
      
      // Exit if indicators turn bearish or after 12 candles
      if (exitSignals === 0 || elapsed >= 12) {
        const sellPrice = c.close * (1 - SLIPPAGE - FEE_RATE);
        const pnl = (sellPrice / entryPrice - 1) * 100;
        cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
        trades.push({ action: 'CLOSE', price: sellPrice, pnl, ts: c.ts, signals: exitSignals });
        if (pnl > 0) { wins++; totalProfit += pnl; }
        else { losses++; totalLoss += Math.abs(pnl); }
        pos = false;
      }
    }
    
    const value = cash + btc * c.close;
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  const finalCandle = candles[candles.length - 1];
  if (pos) {
    const sellPrice = finalCandle.close * (1 - SLIPPAGE - FEE_RATE);
    const pnl = (sellPrice / entryPrice - 1) * 100;
    cash = btc * sellPrice * (1 - FEE_RATE); btc = 0;
    trades.push({ action: 'CLOSE EOD', price: sellPrice, pnl, ts: finalCandle.ts });
    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }
  }
  
  const totalTrades = Math.floor(trades.length / 2);
  const finalValue = cash + btc * finalCandle.close;
  const totalReturn = ((finalValue / INITIAL_BALANCE) - 1) * 100;
  const winRate = wins + losses === 0 ? 0 : wins / (wins + losses) * 100;
  const profitFactor = totalLoss === 0 ? (totalProfit > 0 ? 999 : 0) : totalProfit / totalLoss;
  
  return {
    name: 'Multi-Signal (3+ indicators agree)',
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    finalValue: parseFloat(finalValue.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades,
    wins, losses,
    avgWin: wins > 0 ? parseFloat((totalProfit / wins).toFixed(3)) : 0,
    avgLoss: losses > 0 ? parseFloat((totalLoss / losses).toFixed(3)) : 0,
    trades,
  };
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log(' DAY TRADING STRATEGIES | BTC/USDT 15m | 90 days | Jan-Apr 2026');
  console.log(' Testing: Momentum, RSI, MACD, EMA Cross, Bollinger, Multi-Signal');
  console.log('='.repeat(80));
  
  const candles = await fetchBinanceCandles('BTCUSDT', '15m', 90);
  console.log(`\nLoaded ${candles.length} candles`);
  
  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const marketReturn = ((endPrice / startPrice - 1) * 100).toFixed(1);
  console.log(`Market return: ${marketReturn >= 0 ? '+' : ''}${marketReturn}%\n`);
  
  const results = [];
  
  // 1. MOMENTUM STRATEGIES
  console.log('--- MOMENTUM (EMA Breakout + ATR) ---');
  const momentum = [
    momentumBacktest(candles, { emaPeriod: 20, atrMultiplier: 2, holdHours: 4 }),
    momentumBacktest(candles, { emaPeriod: 20, atrMultiplier: 1.5, holdHours: 2 }),
    momentumBacktest(candles, { emaPeriod: 50, atrMultiplier: 2, holdHours: 6 }),
    momentumBacktest(candles, { emaPeriod: 20, atrMultiplier: 3, holdHours: 8 }),
  ];
  momentum.forEach(r => { console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | ${r.totalTrades} trades | WR ${r.winRate}%`); results.push(r); });
  
  // 2. RSI STRATEGIES
  console.log('\n--- RSI MEAN REVERSION ---');
  const rsiStrats = [
    rsiBacktest(candles, { rsiPeriod: 14, oversold: 30, overbought: 70, holdCandles: 8 }),
    rsiBacktest(candles, { rsiPeriod: 14, oversold: 35, overbought: 65, holdCandles: 8 }),
    rsiBacktest(candles, { rsiPeriod: 7, oversold: 30, overbought: 70, holdCandles: 4 }),
    rsiBacktest(candles, { rsiPeriod: 14, oversold: 40, overbought: 60, holdCandles: 12 }),
  ];
  rsiStrats.forEach(r => { console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | ${r.totalTrades} trades | WR ${r.winRate}%`); results.push(r); });
  
  // 3. MACD STRATEGIES
  console.log('\n--- MACD CROSSOVER ---');
  const macdStrats = [
    macdBacktest(candles, { fast: 12, slow: 26, signal: 9, holdCandles: 8 }),
    macdBacktest(candles, { fast: 8, slow: 21, signal: 9, holdCandles: 6 }),
    macdBacktest(candles, { fast: 12, slow: 26, signal: 9, holdCandles: 16 }),
    macdBacktest(candles, { fast: 5, slow: 35, signal: 5, holdCandles: 8 }),
  ];
  macdStrats.forEach(r => { console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | ${r.totalTrades} trades | WR ${r.winRate}%`); results.push(r); });
  
  // 4. EMA CROSSOVER
  console.log('\n--- EMA CROSSOVER ---');
  const emaCross = [
    emaCrossBacktest(candles, { fast: 9, slow: 21, holdCandles: 12 }),
    emaCrossBacktest(candles, { fast: 9, slow: 21, holdCandles: 6 }),
    emaCrossBacktest(candles, { fast: 12, slow: 26, holdCandles: 12 }),
    emaCrossBacktest(candles, { fast: 5, slow: 20, holdCandles: 8 }),
  ];
  emaCross.forEach(r => { console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | ${r.totalTrades} trades | WR ${r.winRate}%`); results.push(r); });
  
  // 5. BOLLINGER BANDS
  console.log('\n--- BOLLINGER BANDS ---');
  const bb = [
    bollingerBacktest(candles, { period: 20, stdDev: 2, holdCandles: 8 }),
    bollingerBacktest(candles, { period: 20, stdDev: 2.5, holdCandles: 12 }),
    bollingerBacktest(candles, { period: 10, stdDev: 2, holdCandles: 6 }),
  ];
  bb.forEach(r => { console.log(` ${r.name}: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% | ${r.totalTrades} trades | WR ${r.winRate}%`); results.push(r); });
  
  // 6. MULTI-SIGNAL
  console.log('\n--- MULTI-SIGNAL ---');
  const multi = multiStrategyBacktest(candles);
  console.log(` ${multi.name}: ${multi.totalReturn >= 0 ? '+' : ''}${multi.totalReturn}% | ${multi.totalTrades} trades | WR ${multi.winRate}%`);
  results.push(multi);
  
  // Sort by return
  console.log('\n' + '='.repeat(80));
  console.log(' ALL STRATEGIES RANKED');
  console.log('='.repeat(80));
  results.sort((a, b) => b.totalReturn - a.totalReturn);
  console.log(` ${'Strategy'.padEnd(40)} ${'Return'.padEnd(8)} ${'Win%'.padEnd(6)} ${'PF'.padEnd(6)} ${'Trades'}`);
  console.log('-'.repeat(70));
  results.forEach((r, i) => {
    const s = r.totalReturn >= 0 ? '+' : '';
    const marker = i === 0 ? '>>> ' : '    ';
    console.log(`${marker}${r.name.padEnd(36)} ${s}${r.totalReturn.toFixed(1).padEnd(7)} ${r.winRate.toFixed(0).padEnd(5)}% ${r.profitFactor.toFixed(2).padEnd(6)} ${r.totalTrades}`);
  });
  
  console.log(`\nMarket return: ${marketReturn >= 0 ? '+' : ''}${marketReturn}%`);
  console.log(`Best strategy beat market by: ${(results[0].totalReturn - parseFloat(marketReturn)) >= 0 ? '+' : ''}${(results[0].totalReturn - parseFloat(marketReturn)).toFixed(1)}%`);
  
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/strategy-comparison.json', JSON.stringify(results, null, 2));
  console.log(`\nSaved to ./results/strategy-comparison.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
