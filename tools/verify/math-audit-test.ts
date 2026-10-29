import { StdLib } from '../../apps/web/src/oakscript/runtime';
import { generateBars } from '../../apps/web/src/data-generator';
import { barEngine } from '../../apps/web/src/bar-engine';
import { priceToY, TOP_FRAC, BOT_FRAC } from '../../apps/web/src/chart-renderer';

// Helper: naive SMA for comparison
function naiveSMA(src:number[], len:number){
  const r=[]; for(let i=0;i<src.length;i++){ if(i<len-1) r.push(NaN); else { let s=0; for(let j=i-len+1;j<=i;j++) s+=src[j]; r.push(s/len);} } return r;
}
let fails=0, passes=0;
function assertClose(a:number,b:number,eps=1e-6,msg=""){ if(Math.abs(a-b)>eps){ console.error(`FAIL ${msg} ${a} vs ${b}`); fails++; } else passes++; }
function assert(cond:boolean,msg:string){ if(!cond){ console.error(`FAIL ${msg}`); fails++; } else passes++; }

console.log('=== SMA sliding ===');
{
  const src=[1,2,3,4,5,6,7,8,9,10];
  const sma=StdLib.sma(src,3);
  const naive=naiveSMA(src,3);
  for(let i=0;i<src.length;i++) if(isFinite(sma[i])&&isFinite(naive[i])) assertClose(sma[i],naive[i],1e-9,`SMA ${i}`);
  console.log('SMA PASS');
}
console.log('=== EMA seed ===');
{
  const src=[1,2,3,4,5];
  const ema=StdLib.ema(src,3);
  // With SMA seed, ema[2] should be SMA(1,2,3)=2, not source[0]=1
  assertClose(ema[2],2,1e-6,'EMA seed SMA');
  console.log('EMA seed PASS', ema.slice(0,4));
}
console.log('=== RSI NaN warmup ===');
{
  const src=Array.from({length:20},(_,i)=>100+i);
  const rsi=StdLib.rsi(src,14);
  assert(isNaN(rsi[0]) && isNaN(rsi[13]), 'RSI warmup NaN');
  assert(isFinite(rsi[14]), 'RSI first valid');
  console.log('RSI warmup PASS', rsi.slice(13,16));
}
console.log('=== ATR Wilder vs EMA ===');
{
  const high=Array.from({length:20},(_,i)=>10+Math.sin(i)*0.5), low=high.map(v=>v-1), close=high.map((v,i)=>v+0.2);
  const atr=StdLib.atr(high,low,close,14);
  assert(isFinite(atr[atr.length-1]), 'ATR finite');
  console.log('ATR', atr.slice(-2).map(v=>v?.toFixed(3)));
}
console.log('=== CCI meanDev vs stdev ===');
{
  const high=[10,11,12,11,10], low=[9,10,11,10,9], close=[9.5,10.5,11.5,10.5,9.5];
  const cci=StdLib.cci(high,low,close,5);
  assert(isFinite(cci[4]), 'CCI finite');
  console.log('CCI', cci.slice(-2).map(v=>v?.toFixed(1)));
}
console.log('=== ADX Wilder ===');
{
  const high=Array.from({length:20},(_,i)=>10+i*0.5), low=high.map(v=>v-1), close=high.map(v=>v+0.2);
  const adx=StdLib.adx(high,low,close,14);
  assert(isFinite(adx[adx.length-1]), 'ADX finite');
  console.log('ADX', adx.slice(-2).map(v=>v?.toFixed(1)));
}
console.log('=== priceToY clamp ===');
{
  const y=priceToY(100,100,0,600,{scrollX:0,barSpacing:8,offsetY:0,scaleY:1});
  assert(isFinite(y) && !isNaN(y), 'priceToY clamp zero range');
  console.log('priceToY flat', y);
}
console.log('=== Renko/Range clamp ===');
{
  const bars=generateBars(100,'1m','EURUSD=X'); // forex 1.08
  const renko=barEngine.transform(bars,'renko' as any,'1m','test');
  const range=barEngine.transform(bars,'range-bar' as any,'1m','test');
  assert(renko.bars.length>0 && renko.bars.length<5000, 'Renko clamp');
  assert(range.bars.length>0, 'Range clamp');
  console.log(`Renko ${renko.bars.length} Range ${range.bars.length}`);
}
console.log('=== Bar types all ===');
{
  for(const t of ['heikin-ashi','kagi','volume-bar','tick-bar','dollar-bar','imbalance-bar'] as const){
    const bars=generateBars(200,'1h','SPY');
    const res=barEngine.transform(bars,t as any,'1h','test');
    assert(res.health.ok, `bar ${t} ok`);
  }
  console.log('Bar types PASS');
}

console.log(`\nMath audit test: passes=${passes} fails=${fails} ${fails===0?'PASS':'FAIL'}`);
process.exit(fails===0?0:1);
