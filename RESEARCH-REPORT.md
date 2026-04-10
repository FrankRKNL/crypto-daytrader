# Crypto Day Trading Research Report
## Comprehensive Quantitative Study - April 10, 2026

---

## Executive Summary

**Research Question:** Can an AI autonomously grow €100 through day trading without selling products?

**Method:** Systematic walk-forward validation testing 19 strategy variants across 5 assets (BTC, ETH, BNB, SOL, XRP) over 3 out-of-sample periods (2023, 2024, 2025).

**Verdict:** All simple technical strategies fail to beat buy & hold out-of-sample. No strategy achieves >=40% beat market rate.

---

## Research Methodology

### Validation Setup
- **Train/Test Split:** Strict walk-forward
  - Train: 2020-2022 → Test: 2023
  - Train: 2020-2023 → Test: 2024  
  - Train: 2020-2024 → Test: 2025
- **Assets:** BTC, ETH, BNB, SOL, XRP
- **Fee Assumption:** 0.1% (Binance taker)
- **Slippage:** 0.05%
- **No leverage**

### Strategy Families Tested

| Family | Description | Strategies |
|--------|-------------|------------|
| A | Trend Following | EMA crossover, Donchian breakout |
| B | Mean Reversion | RSI extremes, RSI with regime filter |
| C | Volatility | ATR expansion, Squeeze breakout |
| D | Long Only | Trend following, Dip buying |
| E | Short Conditional | Short in bear/range regimes |
| F | Risk Management | Trailing stops, Wide stops, Tight stops |

---

## Results

### Table 1: Performance by Strategy Family (Out-of-Sample)

| Family | Avg Return | vs Market | Beat Rate | Avg DD% | PF | Trades |
|--------|-----------|------------|-----------|---------|-----|--------|
| **Mean Reversion** | +2.9% | -112.1% | 13% | 39% | 0.84 | 6,684 |
| **Long Only** | +2.2% | -112.8% | 29% | 24% | 0.83 | 2,817 |
| **Short Conditional** | -0.6% | -115.6% | 23% | 25% | 0.95 | 2,008 |
| **Trend Following** | -0.9% | -115.9% | 17% | 32% | 0.96 | 6,451 |
| **Risk Management** | -12.1% | -127.1% | 13% | 46% | 0.90 | 11,846 |
| **Volatility** | -16.1% | -131.1% | 3% | 50% | 0.91 | 5,889 |

**Key Insight:** ALL families underperform buy & hold significantly. Market returned +54% average over test periods.

---

### Table 2: Best and Worst Strategies Per Family

#### Trend Following
| Rank | Strategy | Return | vs Market | Beat Rate |
|------|----------|--------|-----------|-----------|
| BEST | EMA Cross (20/50) | +16.3% | -98.7% | 7% |
| WORST | EMA Bull Only | -7.0% | -122.1% | 33% |

#### Mean Reversion
| Rank | Strategy | Return | vs Market | Beat Rate |
|------|----------|--------|-----------|-----------|
| BEST | RSI Range (30/70) | +8.6% | -106.4% | 0% |
| WORST | RSI Bull Filter | -7.0% | -122.1% | 33% |

#### Long Only
| Rank | Strategy | Return | vs Market | Beat Rate |
|------|----------|--------|-----------|-----------|
| BEST | Long Only Trend | +21.7% | -93.3% | 20% |
| WORST | Long Only EMA(50) | -8.0% | -123.0% | 33% |

#### Short Conditional
| Rank | Strategy | Return | vs Market | Beat Rate |
|------|----------|--------|-----------|-----------|
| BEST | Short Range | +5.5% | -109.5% | 13% |
| WORST | Short Bear Regime | -6.7% | -121.7% | 33% |

#### Risk Management
| Rank | Strategy | Return | vs Market | Beat Rate |
|------|----------|--------|-----------|-----------|
| BEST | Wide Stop 10% | +23.9% | -91.1% | 20% |
| WORST | Tight Stop 2% | -27.7% | -142.7% | 7% |

#### Volatility
| Rank | Strategy | Return | vs Market | Beat Rate |
|------|----------|--------|-----------|-----------|
| BEST | ATR Expansion | -4.9% | -119.9% | 7% |
| WORST | Squeeze Breakout | -27.2% | -142.2% | 0% |

---

### Table 3: Performance by Asset

| Asset | Avg Return | vs Market | Beat Rate | Avg DD% |
|-------|-----------|------------|-----------|---------|
| BNB | +2.1% | -44.0% | 18% | 31% |
| ETH | -10.7% | -45.0% | 14% | 36% |
| BTC | -2.5% | -85.9% | 11% | 29% |
| XRP | -6.9% | -99.3% | 16% | 39% |
| SOL | -0.7% | -319.5% | 26% | 44% |

**Key Insight:** BNB performed best relative to market, SOL worst.

---

### Table 4: Risk-Adjusted Performance (Return per % Drawdown)

| Family | Return/DD | Avg Return | Avg DD |
|--------|-----------|-----------|--------|
| Mean Reversion | +0.07 | +2.9% | 39% |
| Trend Following | +0.06 | -0.9% | 32% |
| Long Only | +0.03 | +2.2% | 24% |
| Short Conditional | +0.03 | -0.6% | 25% |
| Risk Management | -0.10 | -12.1% | 46% |
| Volatility | -0.14 | -16.1% | 50% |

**Key Insight:** Mean reversion has best risk-adjusted returns, but still negative vs market.

---

## Key Findings

### 1. Selection Bias Was the Original Problem
Our first analysis showed "81.8% beat market" - but that was because we cherry-picked bear periods (2022, 2026) where shorting happens to work. When tested across all periods (including 2023-2025 bull markets), the result is 0% beat rate.

### 2. Short-Only is Catastrophically Bad
Every short-only strategy lost money vs market in every period. The average underperformance was -115% vs market. Short selling requires correctly timing both entry AND exit in a structurally bullish asset class.

### 3. Long Only is Least Bad
Long only strategies had the highest beat rate (29%) and lowest average drawdown (24%). But they still underperformed buy & hold by -112% on average.

### 4. Risk Management Variants Make It Worse
Counterintuitively, adding sophisticated risk management (tight stops, trailing stops) made performance WORSE. More exits = more fees = more capital destruction.

### 5. Market Efficiency
Crypto markets appear highly efficient for simple technical strategies. The "edge" from any EMA or RSI system is quickly arbitraged away by the time a retail trader could implement it.

---

## What Does NOT Work

- Pure short-only strategies
- EMA crossover systems
- RSI mean reversion
- ATR volatility breakout
- Donchian channel systems
- Trailing stop strategies
- Tight stop loss strategies
- Any combination of the above with regime filters

---

## What Might Work (Needs Further Research)

Based on this study, the following deserve more investigation:

1. **Microstructure Analysis** - Order flow, bid-ask spread dynamics, liquid granularity
2. **On-Chain Data** - Fund flows, wallet distributions, exchange balances
3. **Sentiment / News** - Real-time news impact on price
4. **Cross-Exchange Arbitrage** - Price differences between exchanges
5. **Options Structures** - Defined-risk strategies like covered calls, collars
6. **Multi-Asset Rotation** - Rotating between assets based on relative strength

---

## Research Limitations

1. **Lookahead Bias** - Regime labels may use future information
2. **Survivorship Bias** - Only currently-listed assets tested
3. **No Funding Fees** - Perpetual futures would have additional costs
4. **No Slippage Modeling** - Real execution may differ
5. **Limited Time Period** - 2023-2025 may not represent all market conditions

---

## Conclusion

**Simple technical strategies on candle data do not produce robust out-of-sample edges in crypto markets.**

The research validated that:
- 0% of tested strategies beat market >=40% of the time
- All strategy families underperformed buy & hold by -112% on average
- Market returned +54% over test periods; average strategy returned -3.7%

**The original hypothesis ("give AI €100, it grows through day trading") is NOT supported by evidence.**

Real edge would likely require:
- Information advantages (microstructure, on-chain, news)
- Sophisticated risk management beyond simple stops
- Access to multiple asset classes and exchanges
- Significant capital and infrastructure

---

## Files in This Repository

- `comprehensive-research.mjs` - Full walk-forward testing script
- `honest-walkforward.mjs` - Regime-based validation
- `walkforward-analysis.mjs` - Basic walk-forward
- `results/comprehensive-research.json` - Raw test results
- `deep-analysis.mjs` - Analysis script

---

**Date:** April 10, 2026  
**Researcher:** MiniMax-M2.7 + GLM-5.1 (independent validation)  
**Status:** Complete - Negative Result
