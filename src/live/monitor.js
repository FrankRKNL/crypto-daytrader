/**
 * Live Signal Monitor + Paper Trading
 * Monitors microstructure signals in real-time and logs paper trades
 * 
 * This is NOT the RO15 validator - that continues separately.
 * This module is specifically for day trading edge research.
 */

import { getKlines, getPremiumIndex, getOpenInterest, getLongShortRatio, getAggTrades, getDepth } from '../data/binance.js';
import { getAggressiveFlow, getLSSignals, getFundingSignals } from '../indicators/microstructure.js';
import fs from 'fs';
import path from 'path';

const LOG_DIR = './logs';
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

class PaperTrader {
    constructor({ initialCapital = 10000, feeBps = 4, slippageBps = 5 } = {}) {
        this.capital = initialCapital;
        this.initialCapital = initialCapital;
        this.feeBps = feeBps;
        this.slippageBps = slippageBps;
        this.position = null;
        this.entryPrice = 0;
        this.entryTime = 0;
        this.trades = [];
        this.equity = [];
        this.closedPnl = 0;
    }

    canTrade() {
        return this.capital > this.initialCapital * 0.05; // Stop if 5% left
    }

    entry(side, price) {
        if (!this.canTrade()) return;
        
        const slippagePrice = side === 'LONG' 
            ? price * (1 + this.slippageBps / 10000)
            : price * (1 - this.slippageBps / 10000);
        
        this.position = side;
        this.entryPrice = slippagePrice;
        this.entryTime = Date.now();
        this.capital -= this.feeBps / 10000 * slippagePrice; // Entry fee
        
        this.log(`>>> ${side} ENTRY @ ${slippagePrice.toFixed(2)}`);
    }

    exit(currentPrice) {
        if (!this.position) return;
        
        const slippagePrice = this.position === 'LONG'
            ? currentPrice * (1 - this.slippageBps / 10000)
            : currentPrice * (1 + this.slippageBps / 10000);
        
        let pnl;
        if (this.position === 'LONG') {
            pnl = (slippagePrice - this.entryPrice) / this.entryPrice;
        } else {
            pnl = (this.entryPrice - slippagePrice) / this.entryPrice;
        }
        
        const pnlValue = this.capital * pnl;
        const exitFee = this.feeBps / 10000 * slippagePrice;
        
        this.capital += pnlValue - exitFee;
        this.closedPnl += pnl;
        
        const trade = {
            side: this.position,
            entry: this.entryPrice,
            exit: slippagePrice,
            pnl: pnl * 100,
            pnlValue,
            duration: Date.now() - this.entryTime,
            timestamp: Date.now()
        };
        
        this.trades.push(trade);
        this.log(`<<< ${this.position} EXIT @ ${slippagePrice.toFixed(2)} | PnL: ${(pnl*100).toFixed(2)}% (${pnlValue.toFixed(2)}) | Total: ${this.capital.toFixed(2)}`);
        
        this.position = null;
        this.entryPrice = 0;
        this.entryTime = 0;
    }

    getEquity(currentPrice) {
        if (!this.position) return this.capital;
        
        const unrealized = this.position === 'LONG'
            ? (currentPrice - this.entryPrice) / this.entryPrice
            : (this.entryPrice - currentPrice) / this.entryPrice;
        
        return this.capital * (1 + unrealized);
    }

    log(msg) {
        const ts = new Date().toISOString();
        const line = `[${ts}] ${msg}`;
        console.log(line);
        
        const logFile = `${LOG_DIR}/paper_trades_${new Date().toISOString().split('T')[0]}.log`;
        fs.appendFileSync(logFile, line + '\n');
    }

    getStats() {
        const totalTrades = this.trades.length;
        const wins = this.trades.filter(t => t.pnl > 0).length;
        const losses = this.trades.filter(t => t.pnl <= 0).length;
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;
        
        const avgWin = this.trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0) / Math.max(wins, 1);
        const avgLoss = this.trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0) / Math.max(losses, 1);
        
        const totalReturn = (this.capital - this.initialCapital) / this.initialCapital * 100;
        
        // Max drawdown on equity curve
        let peak = this.initialCapital;
        let maxDD = 0;
        this.equity.forEach(e => {
            if (e.total > peak) peak = e.total;
            const dd = (peak - e.total) / peak;
            if (dd > maxDD) maxDD = dd;
        });
        
        return {
            capital: this.capital,
            totalReturn,
            wins,
            losses,
            winRate,
            avgWin,
            avgLoss,
            maxDrawdown: maxDD * 100,
            trades: this.trades
        };
    }
}

// ===== SIGNAL GENERATORS =====

function fundingSignal(fundingBps, threshold = 8) {
    // Extreme funding = potential reversal
    if (fundingBps < -threshold) return 'LONG_SQUEEZE'; // Shorts overleveraged
    if (fundingBps > threshold) return 'LONG_SQUEEZE_REVERSE'; // Longs overleveraged
    return 'NEUTRAL';
}

function lsSignal(longPct, shortPct) {
    if (shortPct > 55) return 'LONG_ENTRY'; // Too many shorts
    if (longPct > 55) return 'SHORT_ENTRY'; // Too many longs
    return 'NEUTRAL';
}

function tradeFlowSignal(imbalance, momentum) {
    if (imbalance > 0.4 && momentum > 1.2) return 'AGGRESSIVE_BUY';
    if (imbalance < -0.4 && momentum < 0.8) return 'AGGRESSIVE_SELL';
    return 'NEUTRAL';
}

// ===== LIVE MONITOR =====

class LiveMonitor {
    constructor(symbols = ['BTCUSDT', 'ETHUSDT']) {
        this.symbols = symbols;
        this.traders = {};
        this.interval = 60000; // 1 minute
        this.running = false;
        this.tickCount = 0;
        
        symbols.forEach(s => {
            this.traders[s] = new PaperTrader({ 
                initialCapital: 2000, // Smaller per-symbol capital for paper trading
                feeBps: 4,
                slippageBps: 5
            });
        });
        
        this.signalLog = [];
    }

    async checkSignals(symbol) {
        try {
            // Fetch all signals in parallel
            const [funding, ls, aggFlow, depth] = await Promise.all([
                getFundingSignals(symbol),
                getLSSignals(symbol, 10),
                getAggressiveFlow(symbol, 50),
                getDepth(symbol, 20)
            ]);
            
            const signals = {
                symbol,
                timestamp: Date.now(),
                fundingBps: funding?.fundingBps || 0,
                longPct: ls?.currentLongPct || 50,
                shortPct: ls?.currentShortPct || 50,
                tradeFlowImbalance: aggFlow?.vwapDeviation || 0,
                aggressiveBuySpikes: aggFlow?.aggressiveBuySpikes || 0,
                aggressiveSellSpikes: aggFlow?.aggressiveSellSpikes || 0,
                orderBookImbalance: 0,
                price: funding?.markPrice || 0
            };
            
            // Calculate order book imbalance
            if (depth?.bids && depth?.asks) {
                let bidVol = 0, askVol = 0;
                depth.bids.forEach(b => bidVol += parseFloat(b[1]));
                depth.asks.forEach(a => askVol += parseFloat(a[1]));
                signals.orderBookImbalance = (bidVol - askVol) / (bidVol + askVol);
            }
            
            // Interpret signals
            signals.interpretation = {
                funding: fundingSignal(signals.fundingBps),
                ls: lsSignal(signals.longPct, signals.shortPct),
                tradeFlow: tradeFlowSignal(signals.tradeFlowImbalance, 0)
            };
            
            return signals;
        } catch (e) {
            console.error(`${symbol} signal error: ${e.message}`);
            return null;
        }
    }

    async tick() {
        this.tickCount++;
        const ts = new Date().toISOString();
        
        console.log(`\n========== TICK ${this.tickCount} [${ts}] ==========`);
        
        for (const symbol of this.symbols) {
            const signals = await this.checkSignals(symbol);
            
            if (!signals) continue;
            
            const trader = this.traders[symbol];
            const price = signals.price;
            
            // Log current state
            const tradeState = trader.position 
                ? `${trader.position} @ ${trader.entryPrice.toFixed(2)}` 
                : 'FLAT';
            
            console.log(`${symbol}: ${tradeState} | FR: ${signals.fundingBps.toFixed(1)}bps | L/S: ${signals.longPct.toFixed(0)}/${signals.shortPct.toFixed(0)}% | Flow: ${signals.orderBookImbalance.toFixed(2)} | Eq: ${trader.capital.toFixed(2)}`);
            
            // ===== TRADING LOGIC =====
            
            // 1. Funding-based entries
            if (!trader.position && signals.interpretation.funding !== 'NEUTRAL') {
                const action = signals.interpretation.funding;
                if (action === 'LONG_SQUEEZE' && signals.fundingBps < -10) {
                    trader.entry('LONG', price);
                } else if (action === 'LONG_SQUEEZE_REVERSE' && signals.fundingBps > 10) {
                    trader.entry('SHORT', price);
                }
            }
            
            // 2. L/S ratio entries (contrarian)
            if (!trader.position && signals.interpretation.ls !== 'NEUTRAL') {
                const action = signals.interpretation.ls;
                if (action === 'LONG_ENTRY') {
                    trader.entry('LONG', price);
                } else if (action === 'SHORT_ENTRY') {
                    trader.entry('SHORT', price);
                }
            }
            
            // 3. Exit logic: auto-exit after 30 minutes or on signal reversal
            if (trader.position && trader.entryTime) {
                const minutesHeld = (Date.now() - trader.entryTime) / 60000;
                
                if (minutesHeld > 30) {
                    trader.exit(price);
                }
                
                // Check for reversal signals
                const fr = signals.fundingBps;
                if (trader.position === 'LONG' && fr > 5) {
                    trader.exit(price); // Funding turning bullish = exit long
                } else if (trader.position === 'SHORT' && fr < -5) {
                    trader.exit(price); // Funding turning bearish = exit short
                }
            }
            
            // Update equity curve
            trader.equity.push({
                timestamp: signals.timestamp,
                equity: trader.getEquity(price),
                total: trader.capital,
                price
            });
            
            // Log signals
            this.signalLog.push(signals);
        }
        
        // Save signal log periodically
        if (this.tickCount % 60 === 0) {
            const logFile = `${LOG_DIR}/signals_${new Date().toISOString().split('T')[0]}.json`;
            fs.writeFileSync(logFile, JSON.stringify(this.signalLog.slice(-500), null, 2));
            
            // Save trader stats
            const stats = {};
            Object.entries(this.traders).forEach(([sym, t]) => stats[sym] = t.getStats());
            const statsFile = `${LOG_DIR}/stats_${new Date().toISOString().split('T')[0]}.json`;
            fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
            
            console.log(`[${ts}] Saved 60-tick snapshot to logs/`);
        }
    }

    async start() {
        console.log(`\n=== LIVE DAY TRADER MONITOR ===`);
        console.log(`Symbols: ${this.symbols.join(', ')}`);
        console.log(`Interval: ${this.interval / 1000}s`);
        console.log(`Starting at ${new Date().toISOString()}\n`);
        
        this.running = true;
        
        // Run first tick immediately
        await this.tick();
        
        // Continue on interval
        const runLoop = async () => {
            while (this.running) {
                await new Promise(r => setTimeout(r, this.interval));
                if (this.running) await this.tick();
            }
        };
        
        runLoop();
    }

    stop() {
        console.log('\n=== STOPPING MONITOR ===');
        this.running = false;
        
        // Final stats
        Object.entries(this.traders).forEach(([sym, t]) => {
            const stats = t.getStats();
            console.log(`\n{sym} FINAL:`);
            console.log(`  Capital: ${stats.capital.toFixed(2)}`);
            console.log(`  Return: ${stats.totalReturn.toFixed(2)}%`);
            console.log(`  Trades: ${stats.wins}/${stats.losses} (${(stats.winRate*100).toFixed(1)}% win rate)`);
            console.log(`  Avg Win: ${stats.avgWin.toFixed(2)}% | Avg Loss: ${stats.avgLoss.toFixed(2)}%`);
            console.log(`  Max DD: ${stats.maxDrawdown.toFixed(1)}%`);
        });
    }
}

// Run as script
if (process.argv[1]?.includes('live-monitor')) {
    const symbols = process.argv[2]?.split(',') || ['BTCUSDT', 'ETHUSDT'];
    const monitor = new LiveMonitor(symbols);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        monitor.stop();
        process.exit(0);
    });
    
    monitor.start();
}

export {
    PaperTrader,
    LiveMonitor,
    fundingSignal,
    lsSignal,
    tradeFlowSignal
};