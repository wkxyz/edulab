"""Prepare server-only configuration without overwriting existing credentials or enabling billing."""
from pathlib import Path
import os
import secrets

ROOT = Path(__file__).resolve().parents[2]
target = ROOT / "services/tutor/.env"
if target.exists():
    print("Using existing server configuration; no values changed.")
else:
    source = (ROOT / "services/tutor/.env.example").read_text()
    source = source.replace("ADMIN_TOKEN=\n", "ADMIN_TOKEN=" + secrets.token_hex(32) + "\n")
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(source)
    print("Server configuration prepared. Live KIE calls remain disabled.")
