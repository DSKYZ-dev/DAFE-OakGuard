import requests

URLS = [
    "https://api.opencode.ai/",
    "https://api.opencode.ai/v1",
    "https://api.opencode.ai/models",
    "https://opencode.ai",
    "https://opencode.ai/api/v1/models",
]
for u in URLS:
    try:
        r = requests.get(u, timeout=10)
        body = r.text[:120].replace("\n", " ")
        print(f"{u} => {r.status_code}: {body}")
    except Exception as e:
        print(f"{u} => FAIL {e}")
