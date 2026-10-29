import httpx, asyncio
base='http://localhost:8788'
async def test():
    async with httpx.AsyncClient(timeout=20) as c:
        for sym, tf in [('ES=F','1m'),('ES=F','1h'),('NQ=F','1m'),('BTC-USD','1m'),('BTC-USD','1h'),('SPY','1m'),('AAPL','1m')]:
            r=await c.get(f'{base}/api/market-data/{sym}', params={'timeframe':tf,'period':'50'})
            try:
                j=r.json()
                print(f'{sym:8} {tf:3} -> {r.status_code} {j.get("provider","?"):7} {len(j.get("bars",[])):4} bars')
            except:
                print(f'{sym} {tf} -> {r.status_code} {r.text[:80]}')
        for sym in ['ES=F','BTC-USD','SPY']:
            r=await c.get(f'{base}/api/quote/{sym}', params={'provider':'massive'})
            print(f'quote {sym}: {r.status_code} {r.text[:80]}')
        r=await c.get(f'{base}/api/market-data/providers')
        print('providers', r.text[:200])
asyncio.run(test())
