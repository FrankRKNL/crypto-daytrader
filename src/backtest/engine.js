/**
 * Backtest Engine for Microstructure Strategies
 * Realistic fee/slippage model + walk-forward validation
 * 
 * Fee structure (Binance taker):
 * - BTC/USDT: $0.04/0.06 per BTC (~$0.04/contract for futures)
 * - Altcoins: roughly $0.10-0.20 per trade
 * 
 * Slippage: 0.05-0.15% depending on order book depth
 */

const TAKER_FEE_BPS = 4; // 4 bps = 0.04%
const MAKER_FEE_BPS = 2; // 2 bps = 0.02%
const SLIPPAGE_BPS = 5;  // 5 bps = 0.05% execution slippage

class BacktestEngine {
    constructor({ initialEquity = 10000, feeBps = TAKER_FEE_BPS, slippageBps = SLIPPAGE_BPS, positionSizePct = 0.1 } = {}) {
        this.initialEquity = initialEquity;
        this.feeBps = feeBps;
        this.slippageBps = slippageBps;
        this.positionSizePct = positionSizePct;
    }

    /**
     * Run a single backtest with walk-forward validation
     * @param {Array} data - Array of {timestamp, price, ...signals}
     * @param {Function} strategyFn - (data, index, state) => {action: 'BUY'|'SELL'|'HOLD', size?: number}
     * @param {Object} config - {trainDays, testDays, warmupBars}
     */
    runWalkForward(data, strategyFn, config = {}) {
        const { trainDays = 30, testDays = 7, warmupBars = 50 } = config;
        
        // Convert days to bar counts (assuming 1m bars for intraday)
        const trainBars = trainDays * 1440;
        const testBars = testDays * 1440;
        const totalBars = data.length;
        
        const results = [];
        let windowStart = warmupBars; // Need warmup period
        
        while (windowStart + trainBars + testBars <= totalBars) {
            const trainEnd = windowStart + trainBars;
            const testEnd = trainEnd + testBars;
            
            // Train set for parameter optimization
            const trainData = data.slice(windowStart, trainEnd);
            
            // Test set for out-of-sample validation
            const testData = data.slice(trainEnd, testEnd);
            
            console.log(`\nWindow ${results.length + 1}: Train ${new Date(trainData[0].timestamp).toISOString().split('T')[0]} - ${new Date(trainData[trainData.length-1].timestamp).toISOString().split('T')[0]} | Test ${new Date(testData[0].timestamp).toISOString().split('T')[0]} - ${new Date(testData[testData.length-1].timestamp).toISOString().split('T')[0]}`);
            
            // Optimize parameters on train set
            const bestParams = this.optimizeParams(trainData, strategyFn);
            
            // Run backtest on test set with best params
            const testResult = this.runBacktest(testData, strategyFn, bestParams);
            
            results.push({
                window: results.length,
                trainStart: trainData[0].timestamp,
                trainEnd: trainData[trainData.length - 1].timestamp,
                testStart: testData[0].timestamp,
                testEnd: testData[testData.length - 1].timestamp,
                params: bestParams,
                ...testResult
            });
            
            windowStart += testBars; // Move forward by test period
        }
        
        return this.summarizeResults(results);
    }

    /**
     * Optimize strategy parameters on training data
     */
    optimizeParams(trainData, strategyFn) {
        // Grid search over key parameters
        // For microstructure: lookback periods, thresholds
        const paramGrid = {
            lookback: [20, 50, 100, 200],
            threshold: [0.3, 0.5, 0.7],
            minConfidence: [0.5, 0.7, 0.9]
        };
        
        let bestParams = {};
        let bestSharpe = -Infinity;
        
        // Simple grid search
        for (const lookback of paramGrid.lookback) {
            for (const threshold of paramGrid.threshold) {
                for (const minConf of paramGrid.minConfidence) {
                    const params = { lookback, threshold, minConf };
                    const result = this.runBacktest(trainData, strategyFn, params, false);
                    
                    if (result.sharpe > bestSharpe) {
                        bestSharpe = result.sharpe;
                        bestParams = params;
                    }
                }
            }
        }
        
        console.log(`  Optimized params: lookback=${bestParams.lookback}, threshold=${bestParams.threshold}, minConf=${bestParams.minConf} | Train Sharpe: ${bestSharpe.toFixed(2)}`);
        return bestParams;
    }

    /**
     * Run a single backtest on a dataset
     */
    runBacktest(data, strategyFn, params, logTrades = true) {
        let equity = this.initialEquity;
        let position = null; // null = flat, 'LONG' or 'SHORT'
        let entryPrice = 0;
        let equityCurve = [];
        let trades = [];
        let wins = 0;
        let losses = 0;
        
        let state = {};
        
        for (let i = 0; i < data.length; i++) {
            const bar = data[i];
            
            // Generate signal
            const signal = strategyFn(data, i, state, params);
            
            // Apply trading logic
            if (signal.action === 'BUY' && position !== 'LONG') {
                if (position === 'SHORT') {
                    // Close short
                    const pnl = (entryPrice - bar.close) / entryPrice;
                    const fees = this.feeBps / 10000 * 2;
                    equity *= (1 + pnl - fees);
                    trades.push({ type: 'SHORT_CLOSE', pnl, entryPrice, exitPrice: bar.close, timestamp: bar.timestamp });
                    if (pnl > 0) wins++; else losses++;
                }
                // Open long
                position = 'LONG';
                entryPrice = bar.close * (1 + this.slippageBps / 10000); // Slippage on entry
            } else if (signal.action === 'SELL' && position !== 'SHORT') {
                if (position === 'LONG') {
                    // Close long
                    const pnl = (bar.close - entryPrice) / entryPrice;
                    const fees = this.feeBps / 10000 * 2;
                    equity *= (1 + pnl - fees);
                    trades.push({ type: 'LONG_CLOSE', pnl, entryPrice, exitPrice: bar.close, timestamp: bar.timestamp });
                    if (pnl > 0) wins++; else losses++;
                }
                // Open short
                position = 'SHORT';
                entryPrice = bar.close * (1 - this.slippageBps / 10000); // Slippage on entry
            } else if (signal.action === 'FLAT' && position) {
                // Force close
                if (position === 'LONG') {
                    const pnl = (bar.close - entryPrice) / entryPrice;
                    const fees = this.feeBps / 10000 * 2;
                    equity *= (1 + pnl - fees);
                    if (pnl > 0) wins++; else losses++;
                } else {
                    const pnl = (entryPrice - bar.close) / entryPrice;
                    const fees = this.feeBps / 10000 * 2;
                    equity *= (1 + pnl - fees);
                    if (pnl > 0) wins++; else losses++;
                }
                trades.push({ type: 'FORCE_CLOSE', pnl, entryPrice, exitPrice: bar.close, timestamp: bar.timestamp });
                position = null;
            }
            
            // Update state for next bar
            if (signal.newState) {
                state = { ...state, ...signal.newState };
            }
            
            // Record equity
            if (position) {
                const currentPnL = position === 'LONG' 
                    ? (bar.close - entryPrice) / entryPrice
                    : (entryPrice - bar.close) / entryPrice;
                equityCurve.push({ timestamp: bar.timestamp, equity: equity * (1 + currentPnL) });
            } else {
                equityCurve.push({ timestamp: bar.timestamp, equity });
            }
        }
        
        // Close any open position at end
        if (position && data.length > 0) {
            const lastBar = data[data.length - 1];
            const pnl = position === 'LONG' 
                ? (lastBar.close - entryPrice) / entryPrice
                : (entryPrice - lastBar.close) / entryPrice;
            const fees = this.feeBps / 10000 * 2;
            equity *= (1 + pnl - fees);
        }
        
        // Calculate metrics
        const totalReturn = (equity - this.initialEquity) / this.initialEquity;
        const returns = equityCurve.map((e, i) => i === 0 ? 0 : (e.equity - equityCurve[i-1].equity) / equityCurve[i-1].equity);
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const stdReturn = Math.sqrt(returns.map(r => (r - avgReturn) ** 2).reduce((a, b) => a + b, 0) / returns.length);
        const sharpe = stdReturn > 0 ? (avgReturn * Math.sqrt(365 * 1440)) / stdReturn : 0;
        
        // Max drawdown
        let peak = this.initialEquity;
        let maxDrawdown = 0;
        equityCurve.forEach(e => {
            if (e.equity > peak) peak = e.equity;
            const dd = (peak - e.equity) / peak;
            if (dd > maxDrawdown) maxDrawdown = dd;
        });
        
        const winRate = trades.length > 0 ? wins / trades.length : 0;
        const avgWin = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0) / Math.max(wins, 1);
        const avgLoss = trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0) / Math.max(losses, 1);
        
        return {
            totalReturn,
            sharpe,
            maxDrawdown,
            winRate,
            tradeCount: trades.length,
            avgWin,
            avgLoss,
            equityFinal: equity,
            equityCurve,
            trades,
            wins,
            losses
        };
    }

    /**
     * Summarize walk-forward results
     */
    summarizeResults(results) {
        const totalReturn = results.map(r => r.totalReturn);
        const sharpes = results.map(r => r.sharpe);
        const winRates = results.map(r => r.winRate);
        const tradeCounts = results.map(r => r.tradeCount);
        
        // Aggregate
        const avgReturn = totalReturn.reduce((a, b) => a + b, 0) / totalReturn.length;
        const avgSharpe = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
        const avgWinRate = winRates.reduce((a, b) => a + b, 0) / winRates.length;
        const totalTrades = tradeCounts.reduce((a, b) => a + b, 0);
        const maxDrawdowns = results.map(r => r.maxDrawdown);
        
        console.log(`\n=== WALK-FORWARD SUMMARY ===`);
        console.log(`Windows: ${results.length}`);
        console.log(`Avg Return: ${(avgReturn * 100).toFixed(2)}% per ${config.testDays || 7}d window`);
        console.log(`Avg Sharpe: ${avgSharpe.toFixed(2)}`);
        console.log(`Avg Win Rate: ${(avgWinRate * 100).toFixed(1)}%`);
        console.log(`Total Trades: ${totalTrades}`);
        console.log(`Max Drawdown: ${(Math.max(...maxDrawdowns) * 100).toFixed(1)}%`);
        
        // Consistency check: how many windows beat buy & hold?
        // For each window, compare to buy & hold return in that window
        
        return {
            results,
            avgReturn,
            avgSharpe,
            avgWinRate,
            totalTrades,
            maxDrawdown: Math.max(...maxDrawdowns),
            windows: results.length
        };
    }
}

/**
 * Funding Rate Mean-Reversion Strategy
 * Hypothesis: extreme funding rates revert
 * 
 * Entry:
 * - Long when funding < -10 bps (extreme negative = shorts overleveraged)
 * - Short when funding > +10 bps (extreme positive = longs overleveraged)
 * 
 * Exit:
 * - Funding rate crosses zero
 * - Or time-based (8h cycle)
 */
function fundingMeanReversionStrategy(data, i, state, params = {}) {
    const { threshold = 10, holdHours = 2 } = params;
    
    if (!data[i].fundingRate && data[i].fundingRate !== 0) {
        return { action: 'HOLD' };
    }
    
    const fundingBps = data[i].fundingRate * 10000;
    
    // Entry signals
    if (fundingBps < -threshold && !state.position) {
        return { 
            action: 'BUY', 
            newState: { position: 'LONG', entryFunding: fundingBps, entryTime: data[i].timestamp }
        };
    } else if (fundingBps > threshold && !state.position) {
        return { 
            action: 'SELL', 
            newState: { position: 'SHORT', entryFunding: fundingBps, entryTime: data[i].timestamp }
        };
    }
    
    // Exit signals
    if (state.position === 'LONG' && fundingBps > 0) {
        return { action: 'FLAT', newState: {} };
    } else if (state.position === 'SHORT' && fundingBps < 0) {
        return { action: 'FLAT', newState: {} };
    }
    
    // Time-based exit (if funding hasn't crossed zero)
    if (state.position && state.entryTime) {
        const hoursHeld = (data[i].timestamp - state.entryTime) / (1000 * 3600);
        if (hoursHeld >= holdHours) {
            return { action: state.position === 'LONG' ? 'FLAT' : 'FLAT', newState: {} };
        }
    }
    
    return { action: 'HOLD' };
}

/**
 * Trade Flow Imbalance Strategy
 * Hypothesis: aggressive buying/selling pressure precedes price moves
 * 
 * Entry:
 * - Long when buy volume imbalance > threshold
 * - Short when sell volume imbalance > threshold
 */
function tradeFlowStrategy(data, i, state, params = {}) {
    const { lookback = 50, threshold = 0.3, minSpikes = 2 } = params;
    
    if (i < lookback) return { action: 'HOLD' };
    
    // Calculate recent imbalance
    let buyVol = 0, sellVol = 0;
    for (let j = i - lookback; j < i; j++) {
        if (data[j].isBuyerMaker !== undefined) {
            if (data[j].isBuyerMaker) {
                sellVol += data[j].quantity || 0;
            } else {
                buyVol += data[j].quantity || 0;
            }
        }
    }
    
    const imbalance = (buyVol - sellVol) / (buyVol + sellVol + 0.0001);
    
    if (!state.position) {
        if (imbalance > threshold) {
            return { action: 'BUY', newState: { position: 'LONG', entryImbalance: imbalance } };
        } else if (imbalance < -threshold) {
            return { action: 'SELL', newState: { position: 'SHORT', entryImbalance: imbalance } };
        }
    } else {
        // Exit on reversal
        if (state.position === 'LONG' && imbalance < -threshold * 0.5) {
            return { action: 'FLAT', newState: {} };
        } else if (state.position === 'SHORT' && imbalance > threshold * 0.5) {
            return { action: 'FLAT', newState: {} };
        }
    }
    
    return { action: 'HOLD' };
}

/**
 * OI Accumulation Strategy
 * Hypothesis: increasing OI during price moves = institutional interest
 * 
 * Entry:
 * - Long when OI rising + price rising
 * - Short when OI rising + price falling
 */
function oiAccumulationStrategy(data, i, state, params = {}) {
    const { oiLookback = 10, priceLookback = 5 } = params;
    
    if (i < Math.max(oiLookback, priceLookback)) return { action: 'HOLD' };
    
    // OI change
    const currentOI = data[i].openInterest || 0;
    let pastOI = 0;
    for (let j = i - oiLookback; j < i; j++) {
        pastOI += data[j].openInterest || 0;
    }
    pastOI /= oiLookback;
    
    const oiChange = pastOI > 0 ? (currentOI - pastOI) / pastOI : 0;
    
    // Price momentum
    let priceChange = 0;
    for (let j = i - priceLookback; j < i; j++) {
        priceChange += (data[j].close - data[j].open) / data[j].open;
    }
    
    if (!state.position) {
        if (oiChange > 0.05 && priceChange > 0) {
            return { action: 'BUY', newState: { position: 'LONG', entryOI: currentOI } };
        } else if (oiChange > 0.05 && priceChange < 0) {
            return { action: 'SELL', newState: { position: 'SHORT', entryOI: currentOI } };
        }
    } else {
        // Exit after 3-5 bars
        if (state.entryBar && i - state.entryBar >= 5) {
            return { action: state.position === 'LONG' ? 'FLAT' : 'FLAT', newState: {} };
        }
    }
    
    return { action: 'HOLD' };
}

/**
 * Long/Short Ratio Contrarian Strategy
 * Hypothesis: extreme L/S ratios mean crowded trades = reversals
 */
function lsContrarianStrategy(data, i, state, params = {}) {
    const { longThreshold = 55, shortThreshold = 55, lookback = 5 } = params;
    
    if (!data[i].longAccount || !data[i].shortAccount) {
        return { action: 'HOLD' };
    }
    
    const longPct = parseFloat(data[i].longAccount) * 100;
    const shortPct = parseFloat(data[i].shortAccount) * 100;
    
    if (!state.position) {
        // Extreme readings
        if (shortPct > shortThreshold) {
            // Too many shorts = potential long squeeze
            return { action: 'BUY', newState: { position: 'LONG', entryRatio: shortPct } };
        } else if (longPct > longThreshold) {
            // Too many longs = potential selloff
            return { action: 'SELL', newState: { position: 'SHORT', entryRatio: longPct } };
        }
    } else {
        // Exit when ratio normalizes
        if (state.position === 'LONG' && shortPct < 45) {
            return { action: 'FLAT', newState: {} };
        } else if (state.position === 'SHORT' && longPct < 45) {
            return { action: 'FLAT', newState: {} };
        }
    }
    
    return { action: 'HOLD' };
}

export {
    BacktestEngine,
    fundingMeanReversionStrategy,
    tradeFlowStrategy,
    oiAccumulationStrategy,
    lsContrarianStrategy
};