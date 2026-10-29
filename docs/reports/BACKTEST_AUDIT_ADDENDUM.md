# Backtest & Optimizer Audit Addendum

## 6.1 Historical Data Preservation
fetchBacktestBars caps 10k, slice last N. Old: Massive 50k ancient tail. Improvement: time-bucket from=now-N*barMs.

## 6.2 Fill & Brackets
placeBracketOrders stop BEFORE limit, gap-through open < stop ? open : stop, tick + tickBar high/low. Old: tick alone missed wicks. Validated synthetic high 105 low 95.

## 6.3 Split
splitBarIdx floor(count*inSamplePct/100), per-sample peak drawdown. Validated 350/150.

## 6.4 Optimizer Sweeps
Old: linear 4-point for length params. Improvement: log-spaced base*[0.5,1,2,4] for len/period/lookback. Validated len 14 -> 7,14,28,56.

## 6.5 Scoring
profitFactor guard 1e-6 masked 0 trades as huge. Fix: 0 trades => 0. Validated.

## 6.6 High-Frequency
50 variants x 20 runs =1000 backtests 4.2s PASS, odd cases 0 trades, NaN, 10k cap.

## 7. Request Engine Question
Q: Can we send 1 req/min and force 6 resp/10s? Does every response count?
A: No. Each HTTP response counts as a request at the provider (Yahoo/Massive). Forcing 6 responses from 1 request would require server push (SSE/WebSocket) or long-poll with chunked ticks, which providers don't offer for REST. Each 10s tick would still be billed as 1 request if done via polling. Legitimate low-cost tick is what Hybrid already does: 1 Massive anchor/min + Yahoo 12s + synthetic 300ms ticks = ~5 requests/min for ~200 ticks/min (40:1). A receiving adapter that interpolates 60s bars into 10s synthetic ticks is allowed and already implemented (Hybrid tick()). Manipulating to get 6 real ticks per request without paying would violate ToS and be blocked by rate limits. Better: use Hybrid's synthetic + cache + 10k cap. Discuss before implementing any adapter that spoofs.
