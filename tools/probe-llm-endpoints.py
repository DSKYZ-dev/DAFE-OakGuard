import os, httpx, asyncio, json
key=os.environ.get("OPENCODE_API_KEY","").strip()
if not key:
    print("no key in env"); exit(0)
candidates=[
    "https://api.opencode.ai/v1",
    "https://orcarouter.com/api/v1",
    "https://openrouter.ai/api/v1",
    "https://api.openai.com/v1",
]
async def probe(base):
    try:
        async with httpx.AsyncClient(timeout=12) as c:
            r=await c.get(base+"/models", headers={"Authorization": f"Bearer {key}"})
            txt=r.text[:300].replace("\n"," ")
            print(f"{base}: {r.status_code} {txt[:200]}")
            return r.status_code==200
    except Exception as e:
        print(f"{base} EXC {e}")
        return False

async def main():
    for b in candidates:
        ok=await probe(b)
        if ok:
            # try chat with Q-CLI
            try:
                async with httpx.AsyncClient(timeout=20) as c:
                    payload={"model":"Q-CLI","messages":[{"role":"user","content":"Generate OakScript: sma20=sma(close,20); plot(sma20);"}],"temperature":0.2}
                    # also try Q-CLI as model name might need lowercase
                    for m in ["Q-CLI","q-cli","QCLI"]:
                        payload["model"]=m
                        r=await c.post(b+"/chat/completions", headers={"Authorization": f"Bearer {key}","Content-Type":"application/json"}, json=payload)
                        print(f"  chat {m}: {r.status_code} {r.text[:250]}")
                        if r.status_code==200: break
            except Exception as e:
                print(f"  chat EXC {e}")

asyncio.run(main())
