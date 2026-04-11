# Crypto Day Trading Edge Research
## Project Daytrader - 2026-04-11

### Context
RO15 continues as low-frequency trend-following (1h candles, daily signals).
This is a SEPARATE research project with different problem class.

### What We Already Falsified (don't repeat)
- EMA/RSI/crossover on OHLCV candles: NOT robust
- Short-only on candle signals: fails
- High-turnover indicator trading: no edge
- Simple TA patterns: overfitted, not generalizable

### Research Hypothesis
If crypto day trading edge exists, it comes from:
1. Orderflow / market microstructure
2. Derivatives signals (funding, OI, liquidations)
3. Cross-exchange / cross-asset correlations
4. Liquidity dynamics
5. Execution-aware strategies (not just signal-based)

### Data Sources
- Binance futures API (public endpoints)
- Binance spot API (public endpoints)
- Kline/candlestick (1m-5m intervals)
- AggTrades (individual trades)
- Order book depth
- Funding rates (8h intervals on Binance)
- Open interest
- Long/short ratios
- Liquidation streams (Binance WebSocket)

### Phase 1: Data Infrastructure
- [ ] Unified OHLCV fetcher (spot + futures, all intervals)
- [ ] Orderflow aggregator (trade direction, volume, imbalance)
- [ ] Order book snapshot + delta tracker
- [ ] Funding/OI history collector
- [ ] Liquidation stream catcher (WebSocket)

### Phase 2: Edge Detection
- [ ] Funding rate mean-reversion (funding spikes → reversal?)
- [ ] OI change signals (open interest spike → directional pressure?)
- [ ] Trade imbalance signals (aggressive buy/sell pressure)
- [ ] Order book pressure signals (bid-ask wall changes)
- [ ] Liquidation cascade detection
- [ ] Cross-asset correlation signals (BTC move → alts)

### Phase 3: Backtesting
- [ ] Simulate edges with realistic fees ($0.04/0.06 per BTC taker fees)
- [ ] Slippage model (0.05-0.1% for execution)
- [ ] Walk-forward validation (30d train / 7d test)
- [ ] Sharpe, win rate, max drawdown per strategy

### Phase 4: Execution-Aware Strategies
- [ ] Maker vs taker cost modeling
- [ ] Position sizing based on edge confidence
- [ ] Multi-signal fusion (combine orderflow + funding + OI)

### Success Criteria
- Sharpe > 1.0 after realistic fees
- Win rate > 52% (at minimum for 1:1 R/R)
- Out-of-sample validation on unseen data
- Must beat "always neutral" baseline
- Must beat simple "buy the dip" baseline

### Key Principles
1. Execution-aware (not just signal generation)
2. Microstructure-focused (not simple TA)
3. Realistic costs (not toy numbers)
4. Walk-forward validation (not in-sample curve fitting)
5. Independent verification (GLM-5.1 review each strategy)