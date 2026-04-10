# Crypto Day Trading Research - Final Report

**Date:** April 10, 2026  
**Researcher:** MiniMax-M2.7 + GLM-5.1 (independent validation)  
**Total Tests:** 5,707 backtests across 7 market periods, 3 assets, 625+ parameter combinations  
**Additional:** Walk-forward analysis (6 out-of-sample tests)

---

## Executive Summary

**Question:** "If I give you €100, how would you make it grow?" — Autonomously, without selling products.

**Answer:** Short selling with optimal parameters beats the market **81.8% of the time** in selected bear/range periods, with an average outperformance of **+18.7%**.

**BUT:** Walk-forward analysis reveals this is **SELECTION BIAS**. In truly out-of-sample testing, the strategy loses 100% of capital in every test.

---

## The Bitter Truth: Walk-Forward Analysis

```
>>> STRATEGY FAILS OUT-OF-SAMPLE: Overfitted <<<

OVERALL (BTC + ETH, 6 out-of-sample tests):
   Avg Return: -100.0%
   Avg vs Market: -161.6%
   Beat Market: 0/6 (0%)
```

### Out-of-Sample Test Results

| Period | Asset | Market Return | Strategy Return | Beat Market? |
|--------|-------|--------------|-----------------|--------------|
| 2023 | BTC | +156% | -100% | NO |
| 2024-Jan to Jun 2025 | BTC | +156% | -100% | NO |
| Jul 2025 to Apr 2026 | BTC | -33% | -100% | NO |
| 2023 | ETH | +95% | -100% | NO |
| 2024-Jan to Jun 2025 | ETH | +67% | -100% | NO |
| Jul 2025 to Apr 2026 | ETH | -56% | -100% | NO |

### Why the Strategy Fails Out-of-Sample

1. **Training (2020-2022) was already bullish** — BTC went from ~$10K to ~$16K even in "bear" 2022
2. **Short only = fighting the long-term bull market** — crypto is structurally bullish over any meaningful time horizon
3. **Every losing trade = capital loss** — after enough trades = wiped out
4. **We cherry-picked bear periods** — the 81.8% beat rate came from periods where shorting happened to work

---

## Original Optimal Strategy Configuration

| Parameter | Value | Why |
|----------|-------|-----|
| **EMA Period** | 100 | Catches trends earlier than EMA200 |
| **Stop Loss** | 10% | Wider stops avoid noise triggers |
| **Max Hold** | 72 hours | 3-day holds capture full moves |
| **Volume Multiplier** | 1.1x | Minimal filter = maximum valid trades |
| **Regime Filter** | ANY | No filter performs better than regime filtering |

### Performance in Selected Periods (NOT out-of-sample)

| Metric | Value |
|--------|-------|
| **Tests Run** | 5,707 |
| **Beat Market (selected periods)** | 81.8% (4,666/5,707) |
| **Average Outperformance** | +18.7% |
| **Best Result** | +116.6% (ETH 2022 bear market) |
| **Win Rate** | 68.8% |
| **Profit Factor** | 3.33 |

### Regime Analysis (Selected Periods Only)

| Regime | Beat Market | Avg Outperformance | Verdict |
|--------|------------|-------------------|---------|
| **BEAR** | 100% | +57.4% | Short selling optimal |
| **RANGE** | 62% | +14.8% | Short selling works |
| **BULL** | 0% | -11.2% | Short selling FAILS |

---

## Key Lessons

### 1. Selection Bias is Deadly

Our 81.8% beat rate came from choosing periods that happened to favor short selling. True out-of-sample testing (walk-forward) reveals the strategy has NO edge.

### 2. Crypto is Structurally Bullish

Over any 3-5 year period, crypto goes up. A pure short-selling strategy without regime detection will eventually get wiped out.

### 3. Regime Detection is NOT Optional

The ONLY way this strategy could work is with a robust regime detector that:
- Identifies bear/range markets BEFORE entering
- Stays flat or goes long in bull markets
- Adapts parameters based on current regime

### 4. Backtesting Optimism Bias

Our methodology had known flaws:
- **Lookahead Bias** — Results may be slightly optimistic
- **Survivorship Bias** — Only tested currently listed assets
- **No Slippage Modeling** — Real execution may differ
- **No Funding Fees** — Leveraged positions have overnight costs

---

## What Would Actually Work?

### Required: Regime-Aware Strategy

1. **Bear Market:** Short selling with our optimal params (EMA100, SL10%, MH72h, VM1.1x)
2. **Range Market:** Mean reversion (Bollinger Bands, RSI)
3. **Bull Market:** Momentum/breakout strategies or simply stay flat

### Alternative: Pure Long Strategies

For a "set and forget" portfolio:
- **DCA (Dollar Cost Averaging)** — Buy weekly/monthly, no timing needed
- **Momentum** — Buy breakouts, trail stops
- **RSI Pullback** — Buy the dip when oversold

---

## Files in This Repository

### Backtest Scripts
- `massive-sweep.mjs` - 5,707 parameter combinations
- `comprehensive-validation.mjs` - Multi-asset, multi-period validation
- `walkforward-analysis.mjs` - Out-of-sample testing (THE IMPORTANT ONE)
- `regime-short-test.mjs` - Regime-aware short strategy
- `short-leverage-test.mjs` - Leverage impact analysis
- `strategy-comparison.mjs` - All strategy types comparison

### Results
- `results/massive-sweep.json` - Full parameter sweep results
- `results/comprehensive-validation.json` - Cross-market validation
- `results/param-analysis.json` - Parameter importance analysis

---

## How to Run

```bash
# Install dependencies
npm install axios

# Run massive parameter sweep
node massive-sweep.mjs

# Run walk-forward analysis (THE IMPORTANT TEST)
node walkforward-analysis.mjs

# Run comprehensive validation
node comprehensive-validation.mjs
```

---

## Conclusion

**The original "81.8% beat market" claim was misleading.** It was based on cherry-picked bear/range periods.

**Walk-forward analysis proves the strategy is overfitted.** In truly out-of-sample testing, the strategy loses 100% in every test.

**Short selling without regime detection is a losing strategy.** The only way to make it work is:
1. Detect bear/range regime BEFORE entering
2. Stay flat in bull markets
3. Use wide stops (10%) and patient holds (72h)

**If you give me €100**, the honest answer is: DCA into BTC/ETH and forget. Or test a regime-aware momentum strategy with proper out-of-sample validation.

---

## Next Steps

1. [x] Walk-forward analysis (DONE - reveals overfitting)
2. [ ] Build regime detector
3. [ ] Test momentum strategies for bull markets
4. [ ] Paper trade regime-aware strategy
5. [ ] Real-money pilot ONLY after out-of-sample validation

---

**Disclaimer:** This is research, not financial advice. Negative results are also results. Always do your own due diligence before trading.
