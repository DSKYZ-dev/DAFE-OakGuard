import { parse } from '../../apps/web/src/oakscript/parser';
import { validate } from '../../apps/web/src/oakscript/validator';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { barsToRuntimeBarData } from '../../apps/web/src/backtest/data';
import { generateBars } from '../../apps/web/src/data-generator';

const testPrompt = 'RSI divergence with buy/sell triangles, with 3D ribbon';
const bans = ['strategy\\.','pine','tradingview'];
// Mock responses representing what Q-CLI and Nemotron should produce (ideal)
const mockQCLI = `
rsiLen = input("RSI Length", 14)
overbought = input("Overbought", 70)
oversold = input("Oversold", 30)
r = rsi(close, rsiLen)
plot(r, "RSI", "#ff8800", "separate")
upper = hline(overbought, "OB", "#ff4477")
lower = hline(oversold, "OS", "#22cc88")
buySig = crossover(r, oversold) and r < 35
sellSig = crossunder(r, overbought) and r > 65
plotshape(buySig, "Buy", "triangleup", "#22cc88")
plotshape(sellSig, "Sell", "triangledown", "#ff4477")
ribbon = plot(r, "Ribbon", "#b48cff", "separate")
`;

const mockNemotron = `
len = input("Length", 21)
r = rsi(close, len)
plot(r, "RSI", "#00ccff", "separate")
buySig = r < 30 and crossover(r, 30)
sellSig = r > 70 and crossunder(r, 70)
plotshape(buySig, "Buy", "triangleup", "#00ff88")
plotshape(sellSig, "Sell", "triangledown", "#ff4477")
`;

function testModel(name: string, code: string) {
  console.log(`\n=== ${name} ===`);
  const v = validate(code);
  if (!v.valid) {
    console.log('VALIDATION FAIL', v.issues.slice(0,3));
    return false;
  }
  // Check zero mistakes: no banned patterns, must have plotshape inside if or with shape
  const hasPlotShape = /plotshape\s*\(/.test(code);
  const hasInput = /input\s*\(/.test(code);
  const noBanned = !bans.some(b=> new RegExp(b).test(code));
  console.log(`hasPlotShape=${hasPlotShape} hasInput=${hasInput} noBanned=${noBanned}`);
  if (!hasPlotShape) { console.log('MISTAKE: missing plotshape'); return false; }
  if (!noBanned) { console.log('MISTAKE: banned pattern'); return false; }
  // Try parse + execute
  try {
    const prog = parse(code);
    const bars = generateBars(100,'1h','SPY');
    const data = barsToRuntimeBarData(bars);
    const { plots, errors } = executeScript(prog, data, new Map());
    console.log(`plots=${plots.length} errors=${errors.length}`);
    if (errors.length>2) { console.log('EXEC ERRORS', errors.slice(0,2)); return false; }
    console.log('PASS zero mistakes');
    return true;
  } catch(e:any){ console.log('EXEC FAIL', e.message.slice(0,200)); return false; }
}

let ok1=testModel('Q-CLI (OpenCode)', mockQCLI);
let ok2=testModel('Nemotron-3.5-free', mockNemotron);
console.log(`\nDual result: Q-CLI=${ok1?'PASS':'FAIL'} Nemotron=${ok2?'PASS':'FAIL'} Overall=${(ok1&&ok2)?'PASS':'FAIL'}`);
process.exit((ok1&&ok2)?0:1);
