# Crypto Day Trading Edge Research
## Project Daytrader - Phase 1 Complete
**Date:** 2026-04-11
**Status:** Infrastructure built, signals active, paper trading ready

---

## What We Built

```
crypto-daytrader-research/
├── src/
│   ├── data/
│   │   ├── binance.js          # Unified Binance API (futures + spot)
│   │   └── collector.js       # Historical data collector
│   ├── indicators/
│   │   └── microstructure.js   # Orderflow, funding, OI, L/S signals
│   ├── backtest/
│   │   └── engine.js           # Walk-forward backtest engine
│   └── live/
│       └── monitor.js          # Real-time signal monitor + paper trader
├── logs/                       # Signal logs + trade history
├── data/                       # Cache for klines/funding history
├── RESEARCH-PLAN.md             # Master plan
└── results/
    └── DAYTRADER-REPORT.md     # This file
```

---

## Current Market State (Live Data)

### BTCUSDT
- **Price:** $72,955
- **Funding:** -0.74 bps (short pressure slightly elevated)
- **OI:** 98,114 contracts
- **Order Book Imbalance:** +0.16 (slight bid pressure)
- **Trade Flow Imbalance:** +0.37 (buying pressure)

### ETHUSDT
- **Price:** $2,342
- **Funding:** +5.22 bps (longs pay)
- **OI:** rising

### Funding Extremes (All Symbols)
| Symbol | Funding Rate | Interpretation |
|--------|-------------|----------------|
| CYSUSDT | +23.86 bps | Extreme long crowding |
| SKYAIUSDT | +23.81 bps | Extreme long crowding |
| RIVERUSDT | +16.80 bps | Long pressure |
| TRADOORUSDT | +14.22 bps | Long pressure |
| BTCUSDT | -0.74 bps | Near neutral |
| ETHUSDT | +5.22 bps | Moderate long |

---

## Signal Sources Available

### 1. Funding Rate
- **Endpoint:** `GET /fapi/v1/premiumIndex`
- **Update:** Every 8 hours (Binance funding interval)
- **Signal:** Extreme rates (>10 bps) indicate crowded positions
- **Edge hypothesis:** Extreme funding reverts (long squeeze / short squeeze)

### 2. Open Interest
- **Endpoint:** `GET /fapi/v1/openInterest`
- **Update:** Real-time
- **Signal:** OI spike during price move = institutional interest
- **Edge hypothesis:** Rising OI + directional price = momentum continues

### 3. Trade Flow (AggTrades)
- **Endpoint:** `GET /fapi/v1/aggTrades`
- **Update:** Real-time (every trade)
- **Signal:** Buy/sell imbalance, aggressive spikes
- **Edge hypothesis:** Aggressive buying precedes price rise

### 4. Order Book Depth
- **Endpoint:** `GET /api/v3/depth`
- **Update:** Real-time
- **Signal:** Bid/ask imbalance, wall changes
- **Edge hypothesis:** Order book pressure predicts short-term direction

### 5. Liquidation Clusters (WebSocket - TODO)
- **Endpoint:** `GET /fapi/v1/allForceOrders`
- **Update:** Real-time
- **Signal:** Large liquidations cluster in time = potential reversal
- **Edge hypothesis:** Cascade liquidations exhaust selling/buying

---

## API Status

**Working endpoints:**
- `/fapi/v1/premiumIndex` - funding rates
- `/fapi/v1/openInterest` - OI data
- `/fapi/v1/aggTrades` - trade flow
- `/api/v3/depth` - order book
- `/api/v3/klines` - candlestick data

**Broken (404):**
- `/fapi/v1/LongShortRatio` - Binance appears to have removed this endpoint
- Alternative: use taker long/short ratio as proxy

**Available but not tested:**
- Liquidation stream (WebSocket)
- Block trade data
- Funding rate history (only real-time available)

---

## Research Phase Plan

### Phase 1: Infrastructure (DONE)
- Data fetcher (Binance public API)
- Signal indicators (orderflow, funding, OI, L/S)
- Backtest engine with walk-forward validation
- Live monitor with paper trading

### Phase 2: Signal Validation (Next)
Goal: Which signals have edge?

1. **Funding mean-reversion**
   - Hypothesis: funding > +10bps = longs crowded = reversal likely
   - Test: Enter SHORT when funding > +10bps, exit when funding < 0
   - Walk-forward: 30d train / 7d test

2. **Trade flow momentum**
   - Hypothesis: aggressive buy volume precedes price rise
   - Test: Enter LONG when buy/sell ratio > 1.5 over 20 trades
   - Walk-forward: 30d train / 7d test

3. **OI accumulation**
   - Hypothesis: rising OI + price rise = institutional longs = continues
   - Test: Enter LONG when OI up > 5% and price up > 1%

4. **Cross-signal fusion**
   - Combine funding + OI + flow for higher confidence entries

### Phase 3: Execution Modeling
- Fee model: 4 bps taker (Binance)
- Slippage: 5 bps (conservative)
- Position sizing based on confidence

### Phase 4: Live Paper Trading
- Start with $2,000 per symbol
- 1-minute tick interval
- Log all signals + trades
- Track paper P&L vs baselines

---

## Key Principles (from research mandate)

1. **NOT candle-based TA** - we already falsified EMA/RSI on candles
2. **Microstructure focus** - orderflow, funding, OI, liquidations
3. **Execution-aware** - realistic fees, slippage, position sizing
4. **Walk-forward validation** - no in-sample curve fitting
5. **Baselines to beat:**
   - Always neutral (no position)
   - Buy the dip (1% threshold)

---

## Running the System

```bash
# Live signal test (one-shot)
node test-live.mjs

# Start paper trading monitor (live)
node src/live/monitor.mjs

# Collect historical data
node src/data/collector.mjs klines

# Run backtest (requires historical data)
node src/backtest/run-backtest.mjs
```

---

## Current Open Questions

1. **L/S ratio API broken** - need to find alternative or derive from funding
2. **Liquidation data** - need WebSocket for real-time (not HTTP)
3. **Shorthorizon backtest** - need 1m klines over 6+ months for walk-forward
4. **Cross-exchange signals** - Binance only for now, could add Bybit/OKX
5. **Execution latency** - paper trading shows fills, real trading will have slippage

---

## Risks

1. **Endpoint reliability** - Binance changes APIs without notice
2. **Signal decay** - microstructure edges often disappear with competition
3. **Data availability** - funding history only available as snapshots, not time series
4. **Overfitting** - 30d train / 7d test still allows parameter optimization to find noise

---

## Next Steps

1. **collect-historical-data** - Pull 6 months of 1m klines for backtesting
2. **signal-validation** - Run walk-forward on each signal type
3. **start-live-monitor** - Paper trade BTC + ETH with real-time signals
4. **analyze-results** - After 1 week of paper trading, evaluate what's working

---

*RO15 validator continues running separately. This project is independent research.*