"""Cellular gateway polling for antenna aiming."""

import ipaddress
import json
from datetime import datetime

from .util import http_json

def is_private_host(host):
    """True if `host` is a literal IP on a private/loopback range.

    Gateways live on the LAN, so a name or public address is always either a
    mistake or an attempt to point this server somewhere it has no business
    fetching (cloud metadata endpoints being the usual target).
    """
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    # Link-local is deliberately NOT allowed: no home gateway self-assigns a 169.254 address,
    # and that range is where cloud metadata services sit.
    return (addr.is_private or addr.is_loopback) and not addr.is_link_local


def action_cellular(ip, username, password):
    """Pull LTE/5G signal from a T-Mobile Home Internet gateway via the TMI API.
    Works across Sagemcom 5688W / Arcadyan KVD21 / Sercomm G4AR-G4SE."""
    ip = (ip or "192.168.12.1").strip()
    username = (username or "admin").strip()
    if not is_private_host(ip):
        return {"ok": False, "error": "gateway address must be a private LAN IP (e.g. 192.168.12.1)"}
    base = "http://%s" % ip

    # Newer firmware needs a bearer token; older/simpler setups answer unauthenticated.
    token, login_error = None, None
    if password:
        try:
            st, body = http_json(
                "POST", base + "/TMI/v1/auth/login",
                body={"username": username, "password": password}, timeout=8)
            if st == 200:
                token = (json.loads(body).get("auth") or {}).get("token")
            else:
                login_error = "login returned HTTP %s" % st
        except Exception as e:  # noqa: BLE001
            login_error = str(e)

    headers = {"Authorization": "Bearer %s" % token} if token else {}
    try:
        st, body = http_json("GET", base + "/TMI/v1/gateway?get=all", headers=headers, timeout=8)
    except Exception as e:  # noqa: BLE001
        return {"ok": False,
                "error": "Can't reach the gateway at %s. Is the Mac on the gateway's Wi-Fi? (%s)" % (ip, e)}
    if st == 401 or st == 403:
        return {"ok": False, "error": "Gateway rejected the password (HTTP %s). Check the admin password." % st}
    if st != 200:
        return {"ok": False, "error": "Gateway returned HTTP %s%s"
                % (st, ". " + login_error if login_error else "")}
    try:
        d = json.loads(body)
    except ValueError:
        return {"ok": False, "error": "Gateway replied but not in the expected format (unusual model/firmware)."}

    sig = d.get("signal") or {}
    dev = d.get("device") or {}

    def norm(x):
        if not isinstance(x, dict):
            return None
        bands = x.get("bands") or x.get("band")
        if isinstance(bands, list):
            bands = ", ".join(str(b) for b in bands)
        return {"rsrp": x.get("rsrp"), "rsrq": x.get("rsrq"),
                "rssi": x.get("rssi"), "sinr": x.get("sinr"), "bands": bands}

    return {
        "ok": True,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "model": dev.get("friendlyName") or dev.get("model") or "T-Mobile Gateway",
        "lte": norm(sig.get("4g")),
        "nr": norm(sig.get("5g")),
    }
