// ============================================================
//  CONFIG — tune everything about the bot's behavior here
// ============================================================

export const config = {
  // "paper" -> simulated trades, nothing sent to any exchange.
  // "live"  -> sends REAL orders via ccxt. Because exchange.demoTrading is
  //            true below, these orders go to Binance's own demo/paper
  //            environment (enableDemoTrading), not your real balance —
  //            but the code path is identical to real live trading.
  mode: "live",

  exchange: {
    id: "toobit",
    defaultType: "swap", // ccxt option: fetch USDT-M futures markets
    demoTrading: false, // calls exchange.enableDemoTrading(true) — Binance's official demo/paper mode
    defaultLeverage: 10, // affects position sizing/margin only — never the SL/TP levels themselves
    attachRealStopOrders: true, // place STOP_MARKET / TAKE_PROFIT_MARKET orders on the exchange itself
  },

  // How many top-volume USDT-margined perpetuals to scan each cycle
  universe: {
    quote: "USDT",
    topN: 200,
    excludeSymbols: [
      "1000WHY/USDT:USDT",
      "FXS/USDT:USDT",
      "SLERF/USDT:USDT",
      "BABY/USDT:USDT",
      "1000SHIB/USDT:USDT",
      "REZ/USDT:USDT",
      "T/USDT:USDT",
    ], // e.g. ["DOGE/USDT:USDT"] to blacklist a symbol
  },

  // --- Macro filters: decide DIRECTION only (long/short/no-trade). ---
  timeframe: "1h",
  candleLimit: 100,
  htTimeframe: "4h",
  htCandleLimit: 100,
  scanIntervalMinutes: 5, // how often the bot re-scans for new directional candidates

  // --- Entry timing: a fast confirmation + limit-price layer on 5m.
  //     A macro (1h) candidate sits in a queue until the 5m timeframe
  //     confirms the move via Supertrend + candle close, THEN a LIMIT
  //     order (not market) is placed at the 5m swing support/resistance —
  //     buying a small pullback on longs, selling a small bounce on shorts
  //     — instead of chasing the current market price.
  entryTimeframe: "5m",
  entryCandleLimit: 100,
  entry: {
    pollSeconds: 20, // how often the entry-timing loop re-checks pending candidates
    maxWaitMinutes: 10, // give up on a queued candidate if it never confirms within this window
    limitLookback: 8, // 5m candles used to find the limit-entry support/resistance (~1h of 5m data)
    limitFillTimeoutMinutes: 240, // cancel the limit entry order if it never fills within this window
    limitPollSeconds: 15, // how often to check whether a placed limit order has filled
    maxLimitDistancePercent: 1, // limit order
  },

  risk: {
    // --- Position sizing ---
    riskPerTradePercent: 1, // % of balance risked per trade — only used if fixedMarginPerTradeUSDT is null
    maxMarginPercentPerTrade: 0.2, // fallback cap as % of balance — only used if fixedMarginPerTradeUSDT is null
    fixedMarginPerTradeUSDT: 10, // if set, every trade uses exactly this much margin (USDT), ignoring the % settings above
    maxOpenPositions: 4,
    maxLeverage: 10,

    // --- Structure-based SL/TP (src/structureRiskManager.js) ---
    // Stop-loss: swing low/high (over `slLookback` 1h candles) plus a
    // 0.5xATR buffer beyond it, so ordinary noise/liquidity-sweep wicks at
    // the level don't trigger the stop.
    // Take-profit: a % of the distance to the next swing high/low (over
    // `tpLookback` 1h candles) — never placed ON or past the level itself.
    // Trades below minRR are rejected entirely (maxRR is an optional upper
    // sanity cap — null disables it), and the TP fraction shrinks
    // automatically in a choppy (low-ADX) market.
    structure: {
      slLookback: 18, // 15-20 range per typical swing-stop practice
      tpLookback: 25, // 20-30 range for the resistance/support target
      slAtrBuffer: 0.5, // stop = swing level ± 0.5 × ATR
      minRR: 0.6, // reject the trade outright below this
      maxRR: null, // no upper cap by default — set a number to re-enable one
      adxTrendThreshold: 20, // below this, market is considered choppy/sideways
      tpFractionTrending: 0.75, // % of distance to the swing level, when ADX is healthy
      tpFractionChoppy: 0.65, // tighter target when ADX < adxTrendThreshold
    },

    // --- Position management guardrails, checked every 1 minute ---
    // (src/structureRiskManager.js `monitorPosition` + `checkProfitGatedReversal`,
    // wired in trendMonitor.js)
    management: {
      // Breakeven — noise-resistant: triggers on EITHER condition below,
      // and never sets the stop exactly at entry.
      breakevenAtrTrigger: 1.2, // profit (in ATR multiples) that triggers breakeven
      breakevenSLBufferAtr: 0.15, // new SL = entry ± this × ATR (covers noise + fees)
      // reaching 50% of the distance to TP also triggers breakeven — see
      // structureRiskManager.js, no separate config needed for that half.

      // Profit-gated trend-reversal exit — THE ONLY early-exit-on-indicator
      // path, and it is structurally incapable of firing at a loss (see
      // structureRiskManager.js `checkProfitGatedReversal`). A losing trade
      // can ONLY be closed by the hard stop-loss sitting on the exchange.
      reversalProfitAtrTrigger: 0.5, // must be at least this many ATRs in profit before this check even runs
      reversalRsiLongExitMax: 45, // for longs: exit only if RSI is below this
      reversalRsiShortExitMin: 55, // for shorts: exit only if RSI is above this

      // Time-based exit — unconditional (can fire even at a loss, since
      // it's a structural "don't let this drag on" guard, not a reaction
      // to indicators).
      maxHoldCandles: 24, // close at market if held this many 1h candles without hitting TP/breakeven
    },

    minADX: 15, // macro (1h) filter — reject choppy/ranging markets from even being considered
    minVolumeSpike: 0.6, // macro (1h) filter — last candle volume vs recent average
    // --- Manual SL/TP (optional, each side independent) ---
    // A number > 0 = flat % distance from the entry price for that side.
    // null = use the structure-based level (swing + ATR buffer / % of the
    // distance to the next swing) exactly as before.
    // If BOTH are numbers, the min/max RR gate above is skipped, since the
    // ratio is entirely your choice; with only one set, the other side is
    // still structure-based and the RR gate still applies.
    stopLossPercent: 1.5, // e.g. 1.5 => SL 1.5% from entry
    takeProfitPercent: 3, // e.g. 1.0 => TP 1.0% from entry

    // --- Pin bar (hammer / shooting star) check on the last closed 1h candles ---
    pinBar: {
      enabled: true,
      // What to do when a pin bar points AGAINST the trend setup (e.g. the
      // setup says short but a bullish pin bar just printed at a new low):
      //   "flip"  = take the pin bar's direction instead (long). It still has to
      //             pass every other filter, including the 4h trend check, so a
      //             flip is rejected if the 4h trend opposes it.
      //   "block" = just skip the symbol.
      onConflict: "flip",
      recentCandles: 2, // the pin bar may be on any of the last N closed candles
      minWickRatio: 0.6, // the long wick must be >= 60% of the candle's full range
      maxOppositeWickRatio: 0.25, // ...and the opposite wick <= 25% of it
      minRangeAtr: 0.8, // ignore small candles: range must be >= 0.8 x ATR
      requireAtExtreme: true, // must print a new low (bullish) / high (bearish) vs the previous candles
      extremeLookback: 20,
    },
  },

  paper: {
    startingBalanceUSDT: 1000,
    stateFile: "./data/paper-state.json",
    tradeLogFile: "./data/trade-log.json",
  },

  // Every closed live trade (win or loss) is appended here — see
  // src/tradeHistory.js and `npm run winrate`.
  tradeHistoryFile: "./data/live-trade-log.json",
};
