# Crypto Day Trader - Research Project

## Overview
Autonomous crypto day trading research. Goal: Can an AI grow €100 without selling products?

## Strategy: Regime-Aware VWAP Deviation

**Core insight:** Day trading in a bear market = losing. The best strategy is regime detection + selective trading.

### The Winning Strategy
- **BULL** (uptrend): LONG positions
- **BEAR** (downtrend): FLAT (no trades)
- **RANGING** (no trend): LONG on VWAP deviation signals

### Results (90 days, Jan-Apr 2026)
| Metric | Strategy | Buy & Hold |
|--------|----------|------------|
| Return | **+37.0%** | -19.5% |
| Outperformance | **+56.5%** | - |
| Win Rate | 60% | - |
| Profit Factor | 7.95 | - |
| Trades | 52 | 1 |

### Key Findings
1. **Market regime dominates everything** - The market (bear/bull/ranging) is more important than the strategy
2. **Bear markets destroy long strategies** - B&H lost 19.5%, always-flat would have lost 0%
3. **VWAP deviation works in ranging markets** - Short-term mean reversion catches bounces
4. **High-frequency trading destroys capital** - 200+ trades = 99% losses due to fees
5. **Shorting in bear doesn't work** - Only 9% win rate on shorts, too risky

## Files

### Backtesters
- `regime-aware-test.mjs` - Main regime-aware strategy tester
- `multi-period-test.mjs` - Tests strategies across 30/60/90/180 day periods
- `vwap-optimizer.mjs` - Grid search for optimal VWAP parameters
- `intraday-backtest-v2.mjs` - Intraday strategies with stop-loss/take-profit
- `intraday-backtest.mjs` - First version basic strategies

### Results
- `results/regime-aware-strategies.json` - Full regime-aware backtest results
- `results/multi-period-vwap.json` - Multi-period VWAP comparison

## Regime Detection
- Uses 20 EMA vs 50 EMA for trend direction
- ATR volatility as % of price
- 20-candle momentum for regime classification
- BULL: trend up + momentum > 2%
- BEAR: trend down + momentum < -2%
- RANGING: everything else (90.6% of the time!)

## How to Run
```bash
node regime-aware-test.mjs    # Main test
node multi-period-test.mjs    # Cross-period validation
node vwap-optimizer.mjs      # Parameter optimization
```

## Data Source
- Binance API (public, no key needed)
- 15-minute candles
- BTC/USDT trading pair

## Lessons Learned
1. Overfitting is dangerous - optimized params on 60 days failed on 90 days
2. Fewer trades = better (52 trades beat 2000 trades)
3. In bear markets: flat > any strategy
4. VWAP deviation only works in ranging markets
5. The best trade is the one you don't take

## Status
Research phase complete. Paper trading engine next.
