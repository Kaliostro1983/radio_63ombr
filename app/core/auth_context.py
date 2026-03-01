from __future__ import annotations
from fastapi import Request

TAILSCALE_HEADERS = [
    "Tailscale-Device-Name",
    "Tailscale-User-Login",
    "Tailscale-User",
    "X-Tailscale-User-Login",
    "X-Tailscale-User",
    "X-Tailscale-Device",
]

def get_actor(request: Request) -> str:
    for h in TAILSCALE_HEADERS:
        v = request.headers.get(h)
        if v:
            return v.strip()
    # fallback: client host
    if request.client and request.client.host:
        return request.client.host
    return "unknown"
