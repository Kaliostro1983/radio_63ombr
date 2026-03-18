"""Request actor extraction (lightweight auth context).

This project can be deployed behind Tailscale. In that environment, the
reverse proxy (or Tailscale itself) may inject headers that identify the
user/device. This module centralizes the logic for extracting an "actor"
identifier from a FastAPI request.

Usage in the system:

- Routers/services that need audit fields (e.g. `changed_by` in
  `network_changes`) call `get_actor(request)` to attribute changes.
"""

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
    """Extract the actor identifier from a request.

    The function checks a list of known Tailscale-related headers and
    returns the first non-empty value. If no headers are present, it falls
    back to the client IP/host.

    Args:
        request: FastAPI request object.

    Returns:
        str: actor identifier string (user/device header value), client host
        as fallback, or "unknown" if not available.
    """
    for h in TAILSCALE_HEADERS:
        v = request.headers.get(h)
        if v:
            return v.strip()
    # fallback: client host
    if request.client and request.client.host:
        return request.client.host
    return "unknown"
