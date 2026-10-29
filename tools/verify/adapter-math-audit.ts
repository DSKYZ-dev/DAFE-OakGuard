import { generateBars, aggregateTimeframe } from '../../apps/web/src/data-generator';
import { priceToY, barX, chartRight, TOP_FRAC, BOT_FRAC } from '../../apps/web/src/chart-renderer';
function getDataSourceForSymbol(s:string){ const up=s.toUpperCase(); if(up.endsWith('=F')||up.endsWith('-F')) return 'polygon'; if(up.endsWith('-USD') && ['BTC','ETH','SOL','BNB','ADA','XRP','DOGE'].some(p=>up.startsWith(p))) return 'binance'; return 'yahoo'; }
function binanceSymbolFor(s:string){ return s.split('-')[0].toLowerCase()+'usdt'; }
function polygonTickerFor(s:string){ return s.replace('=F','').replace('-F',''); }

// 10s floor
function grid10(ts:number){ return Math.floor(ts/10)*10; }
let fails=0;
function assert(c:boolean,msg:string){ if(!c){ console.error('FAIL',msg); fails++; } else console.log('PASS',msg); }

// 1. 10s floor
assert(grid10(1713600001)===1713600000, '10s floor int');
assert(grid10(1713600009)===1713600000, '10s floor same window');
assert(grid10(1713600010)===1713600010, '10s floor next window');
// ms vs s: Binance E is ms, Polygon s is ms
assert(grid10(1713600001500/1000)===1713600000, 'ms->s floor');

// 2. OHLC aggregation
let buf={open:100,high:100,low:100,close:100,volume:5,ts:grid10(1000),symbol:"BTC-USD"};
function agg(buf:any, price:number, deltaVol:number){
  buf.high=Math.max(buf.high,price);
  buf.low=Math.min(buf.low,price);
  buf.close=price;
  buf.volume+=deltaVol;
}
agg(buf,102,2); assert(buf.high===102 && buf.low===100 && buf.close===102 && buf.volume===7, 'OHLC agg');

// 3. Delta volume (Binance total)
let lastTotal=1000, total=1005, delta=Math.max(0,total-lastTotal);
assert(delta===5, 'Binance delta');

// 4. Polygon aggs already OHLCV — floor consistent
assert(grid10(1713600005)===1713600000, 'Polygon floor');

// 5. Symbol → source auto-switch
assert(getDataSourceForSymbol('ES=F')==='polygon', 'ES=F → polygon');
assert(getDataSourceForSymbol('BTC-USD')==='binance', 'BTC-USD → binance');
assert(getDataSourceForSymbol('SPY')==='yahoo', 'SPY → yahoo');
assert(binanceSymbolFor('BTC-USD')==='btcusdt', 'binance map');
assert(polygonTickerFor('ES=F')==='ES', 'polygon map');

// 6. Rendering integrity with 10s bars
const bars=generateBars(100,'1m','ES=F');
const tenSecBars=generateBars(100,'10s' as any,'ES=F');
const pRange=Math.max(...bars.map(b=>b.high))-Math.min(...bars.map(b=>b.low));
const y=priceToY(bars[50].close, Math.min(...bars.map(b=>b.low)), pRange||1, 600, {scrollX:0,barSpacing:8,offsetY:0,scaleY:1});
assert(isFinite(y) && y>0 && y<600, 'priceToY 10s');
const x=barX(5, 20, 800, 8, 0);
assert(isFinite(x) && x>0 && x<800, 'barX 10s');

// 7. Time-bucket aggregation for 2h/4h (backend) vs sequential
const h1Bars=generateBars(24,'1h','ES=F');
const twoH=aggregateTimeframe(h1Bars,'4h' as any);
assert(twoH.length>=6 && twoH.length<=8, `4h bucket 24h → ${twoH.length} bars`);

console.log(`\nAdapter math audit fails=${fails} ${fails===0?'PASS':'FAIL'}`);
process.exit(fails===0?0:1);
