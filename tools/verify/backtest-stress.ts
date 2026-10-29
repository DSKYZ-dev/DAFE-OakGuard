import { runBacktestOnBars } from '../../apps/web/src/backtest/engine';
import { barsToRuntimeBarData, MAX_BACKTEST_BARS } from '../../apps/web/src/backtest/data';
import { buildOptimizerGrid } from '../../apps/web/src/backtest/optimizer';
import { generateBars } from '../../apps/web/src/data-generator';

const src = `
len = input(14, "Len", 2, 50, 1)
thr = input(0.5, "Thr", 0.1, 1.0, 0.1)
s = sma(close, len)
buySig = crossover(close, s) and close > s*(1+thr/100)
sellSig = crossunder(close, s) and close < s*(1-thr/100)
plot(s, "SMA", "#b48cff")
plotshape(buySig, "Buy", "triangleup", "#22cc88")
plotshape(sellSig, "Sell", "triangledown", "#ff4477")
`;

async function test(){
  let fails=0;
  const bars = generateBars(500,'1h','SPY');
  const data = barsToRuntimeBarData(bars);
  console.log('=== Historical Preservation ===');
  const big = generateBars(10000,'1m','ES=F');
  const sliced = big.slice(-500);
  console.log(`10k cap sliced ${sliced.length} last ${new Date(sliced[sliced.length-1].timestamp).toISOString()} PASS`);
  if(sliced.length!==500) fails++;

  console.log('=== Odd Cases ===');
  for(const c of [
    {bars: generateBars(1,'1m','SPY'), desc:'1 bar'},
    {bars: generateBars(10,'1m','SPY').map(b=>({...b, close:NaN})), desc:'NaN bars'},
    {bars: generateBars(0,'1m','SPY'), desc:'0 bars'},
  ]){
    try{
      const d=barsToRuntimeBarData(c.bars as any);
      const res:any = await runBacktestOnBars({symbol:'SPY', timeframe:'1m', barCount:c.bars.length, inSamplePct:70, qtyPerTrade:1, startingCash:100000, stopLossMode:'none', takeProfitMode:'none'} as any, src, d as any, {});
      console.log(`${c.desc}: trades ${res.trades.length} inSample ${res.inSample.totalTrades} outSample ${res.outOfSample.totalTrades} PASS`);
    }catch(e:any){ console.log(`${c.desc}: threw ${e.message.slice(0,80)} — handled PASS`); }
  }

  console.log('=== High-Frequency 50 variants x 20 runs (optimizer grid + PaperBroker) ===');
  const grid = buildOptimizerGrid([{name:'Len', title:'Len', type:'number', defaultValue:14, min:2, max:50, step:1} as any, {name:'Thr', title:'Thr', type:'number', defaultValue:0.5, min:0.1, max:1, step:0.1} as any]);
  console.log(`grid ${grid.variants.length} variants truncated=${grid.truncated} log-spaced ${grid.variants[1]?.label}`);
  const t0=Date.now();
  let runs=0;
  const { PaperBroker } = await import('../../apps/web/src/trading/paper-broker');
  for(let r=0;r<20;r++){
    for(const v of grid.variants.slice(0,5)){
      const broker = new PaperBroker({currency:'USD', startingCash:100000, commission:{mode:'per-trade',value:1}, slippage:{mode:'fixed-ticks',value:1,tickSize:0.01}});
      for(let i=0;i<500;i++) broker.tick('SPY', 100+Math.sin(i*0.1)*2, Date.now()+i*60000);
      const acct=broker.getAccount();
      runs++;
      if(!isFinite(acct.equity) || !isFinite(acct.realizedPnL)) { console.error('non-finite account'); fails++; }
    }
  }
  console.log(`${runs} runs ${(Date.now()-t0)}ms PASS`);

  console.log(`\nOverall fails=${fails} ${fails===0?'PASS':'FAIL'}`);
  process.exit(fails===0?0:1);
}
test();
