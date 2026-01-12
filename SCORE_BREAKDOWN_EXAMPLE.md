# Signal Score Breakdown - Example with VALE (Vale SA)

## The New Feature

You now have a detailed **Score Breakdown Table** that shows exactly how each metric is contributing to the BUY/SELL/HOLD signal!

## Example: VALE with RSI 71.74 (Overbought)

### Visual Display in App

```
╔════════════════════════════════════════════════════════════════════╗
║           SIGNAL SCORE BREAKDOWN                                   ║
╠═══════════════════════╦═════════╦═════════════════════════════════╣
║ Metric                ║ Score   ║ Details                         ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ MA Crossover (20/50)  ║  +3     ║ Bullish (SMA20: 25.80 >         ║
║                       ║         ║ SMA50: 24.30)                   ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ RSI (14)              ║  -2     ║ Overbought (RSI: 71.74 > 70) -  ║
║                       ║         ║ Selling pressure ⚠️              ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ Momentum (10d)        ║  +2     ║ Bullish (Momentum: 2.45 > 0)    ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ Price vs SMA(50)      ║  +1     ║ Above (Price: 25.95 >           ║
║                       ║         ║ SMA50: 24.30)                   ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ **TOTAL SCORE**       ║  **+4** ║ ✅ BUY Signal                   ║
╚═══════════════════════╩═════════╩═════════════════════════════════╝

Score Thresholds: ≥4 = BUY | ≤-4 = SELL | -3 to 3 = HOLD
```

## What This Shows

### Breaking Down VALE's Signal:

1. **MA Crossover: +3** ✅ Bullish Trend
   - The 20-day average is ABOVE the 50-day average
   - This is the strongest bullish indicator
   - Price trending upward

2. **RSI: -2** ⚠️ Overbought Warning
   - RSI of 71.74 is above the 70 threshold
   - Stock has risen too much, too fast
   - Risk of pullback/correction
   - **This is why we didn't see a "STRONG BUY" signal**

3. **Momentum: +2** 📈 Bullish Acceleration
   - Price moving faster over last 10 days
   - Confirms the uptrend has energy
   - Positive momentum supports the MA crossover

4. **Price vs SMA50: +1** 📊 Supporting the Trend
   - Current price is above the 50-day average
   - Additional confirmation of uptrend
   - Price is in "uptrend zone"

### The Verdict: BUY (score = +4)

**Total Score: +3 +2 +2 +1 - 2 = +4 ✅ BUY**

Even though RSI is overbought (-2), the strong MA crossover (+3), positive momentum (+2), and price position (+1) outweigh the overbought warning.

**What This Means:**
- The stock IS in a strong uptrend
- BUT it's gotten ahead of itself (overbought)
- Traders might see risk at current prices
- OR aggressive traders might see a "buy the dip" opportunity

---

## Another Example: If VALE Had Bearish MA Crossover

### Hypothetical Scenario: SMA20 < SMA50

```
║ MA Crossover (20/50)  ║  -3     ║ Bearish (SMA20: 23.80 <         ║
║                       ║         ║ SMA50: 24.30)                   ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ RSI (14)              ║  -2     ║ Overbought (RSI: 71.74 > 70)    ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ Momentum (10d)        ║  -2     ║ Bearish (Momentum: -1.45 < 0)   ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ Price vs SMA(50)      ║  +1     ║ Above (Price: 25.95 > SMA50)    ║
╠═══════════════════════╬═════════╬═════════════════════════════════╣
║ **TOTAL SCORE**       ║  **-6** ║ ⚠️ SELL Signal                  ║
╚═══════════════════════╩═════════╩═════════════════════════════════╝
```

**Total: -3 -2 -2 +1 = -6 SELL** ⚠️

In this scenario:
- Multiple red flags all pointing downward
- The BUY pressure would be overwhelmed
- Clear sell signal
- Even though price is above MA50, it's being rejected

---

## Why This Transparency Matters

✅ **See exactly what's driving the signal**
- No black box algorithm
- Each metric's contribution is visible
- Easy to understand the logic

✅ **Identify conflicting signals**
- Example: Bullish trend BUT overbought RSI
- You can decide what to prioritize
- Different trading styles value different signals

✅ **Better decision-making**
- Conservative traders: Wait for RSI to cool (< 70) before buying
- Aggressive traders: Buy strong trends even if overbought
- Technical traders: Use this to confirm their own analysis

✅ **Learn from the data**
- See how indicators relate to each other
- Build intuition about technical analysis
- Understand market conditions better

---

## Quick Reference: Score Meanings

| Total Score | Signal | What It Means |
|------------|--------|---------------|
| **≥ 4** | **BUY** 🟢 | Multiple bullish signals converging |
| **3 to 1** | **HOLD** 🟡 | Slightly bullish, but not enough conviction |
| **0 to -3** | **HOLD** 🟡 | Mixed or neutral signals |
| **-1** | **HOLD** 🟡 | Slightly bearish, insufficient for SELL |
| **≤ -4** | **SELL** 🔴 | Multiple bearish signals converging |

---

## How Each Metric Works

### MA Crossover Score (-3 to +3)
- **+3**: SMA20 > SMA50 (Bullish trend)
- **0**: SMA20 ≈ SMA50 (Neutral)
- **-3**: SMA20 < SMA50 (Bearish trend)

### RSI Score (-2 to +2)
- **+2**: RSI < 30 (Oversold - buying opportunity)
- **0**: RSI 30-70 (Neutral zone)
- **-2**: RSI > 70 (Overbought - selling pressure)

### Momentum Score (-2 to +2)
- **+2**: Momentum > 0 (Price accelerating up)
- **0**: Momentum = 0 (No net change)
- **-2**: Momentum < 0 (Price accelerating down)

### Price vs MA50 Score (-1 to +1)
- **+1**: Price > SMA50 (Supporting uptrend)
- **0**: Price ≈ SMA50 (At key level)
- **-1**: Price < SMA50 (Supporting downtrend)

---

## Bottom Line

You now have **complete transparency** into how each metric contributes to the trading signal.

For VALE with RSI 71.74:
- ✅ The overbought condition IS being counted (-2 points)
- ✅ It IS reducing the bullish signal strength
- ✅ But the strong trend (+3) and momentum (+2) overcome it
- ✅ Result: Still a BUY signal, but investors should be aware of the overbought risk

This is **exactly how professional traders think** about these indicators! 🎯