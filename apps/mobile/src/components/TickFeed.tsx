// @ts-nocheck
import { useEffect, useRef, useState } from "react";

// DAFE TickFeed — 10s aggregated tick from relay.py → Three.js isotropic bars
// Auto-switch: futures (=F) → Polygon/Massive, crypto (-USD) → Binance, via data-adapter
// Render URL for dafe-relay (tea-da3rlmu1egvs73an60rg) — fallback to localhost for dev
import { getWsUrlForSymbol } from "../data-adapter";
const RENDER_WS = "wss://dafe-relay.onrender.com/ws"; // ← Render service tea-da3rlmu1egvs73an60rg — update if your subdomain differs
const DEFAULT_WS = (() => {
  try { return localStorage.getItem("dafe_tick_ws_url") || RENDER_WS; } catch { return RENDER_WS; }
})();

export interface Tick {
  symbol: string; price: number; ts: number;
  open: number; high: number; low: number; volume: number;
}

export function useTickFeed(symbol?: string, url?: string){
  const [tick, setTick] = useState<Tick|null>(null);
  const [status, setStatus] = useState<"idle"|"connecting"|"open"|"closed"|"error">("idle");
  const wsRef = useRef<WebSocket|null>(null);
  const target = url || DEFAULT_WS || (symbol ? getWsUrlForSymbol(symbol) : "") || (import.meta as any).env?.VITE_TICK_WS || "ws://localhost:8000/ws";

  useEffect(()=>{
    if(!target) { setStatus("idle"); return; }
    const wsUrl = target.replace(/^http/, "ws");
    setStatus("connecting");
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = ()=> setStatus("open");
    ws.onmessage = (ev)=>{
      try{
        const d = JSON.parse(ev.data);
        setTick({symbol:d.symbol, price:d.price ?? d.close, ts:d.ts, open:d.open, high:d.high, low:d.low, volume:d.volume});
      }catch{}
    };
    ws.onerror = ()=> setStatus("error");
    ws.onclose = ()=> setStatus("closed");
    return ()=> ws.close();
  }, [target]);

  return { tick, status, url: target };
}

export default function TickFeed({ onTick, wsUrl, symbol }: { onTick?: (t:Tick)=>void, wsUrl?:string, symbol?:string }){
  const { tick, status, url } = useTickFeed(symbol, wsUrl);
  useEffect(()=>{ if(tick && onTick) onTick(tick); }, [tick]);
  if(!tick) return <div style={{padding:12, fontSize:11, opacity:0.6}}>TickFeed {status} — {url} — waiting for 10s bar…</div>;
  return (
    <div style={{padding:10, fontSize:11, background:"rgba(10,10,20,0.6)", border:"1px solid rgba(180,140,255,0.15)", borderRadius:8}}>
      <div>{tick.symbol} {tick.price.toFixed(2)} — ts {tick.ts} — {status}</div>
      <div style={{opacity:0.7}}>O {tick.open.toFixed(2)} H {tick.high.toFixed(2)} L {tick.low.toFixed(2)} V {tick.volume.toFixed(4)}</div>
    </div>
  );
}
