"""Password hashing and signed, expiring login tokens (standard library only)."""

import base64
import hashlib
import hmac
import json
import os
import time

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app import config
from app.db import get_conn

_bearer = HTTPBearer(auto_error=False)
_SCRYPT = dict(n=2**14, r=8, p=1, dklen=32)


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), **_SCRYPT)
        return hmac.compare_digest(candidate.hex(), digest)
    except (ValueError, TypeError):
        return False


# Used to spend the same time on unknown emails, so login timing does not reveal accounts.
_DUMMY_HASH = hash_password("not-a-real-password")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: str) -> str:
    return _b64(hmac.new(config.SECRET_KEY.encode(), payload.encode(), hashlib.sha256).digest())


def create_token(user_id: int) -> str:
    body = _b64(json.dumps({"sub": user_id, "exp": int(time.time()) + config.TOKEN_TTL_SECONDS}).encode())
    return f"{body}.{_sign(body)}"


def decode_token(token: str) -> int | None:
    try:
        body, signature = token.split(".")
        if not hmac.compare_digest(signature, _sign(body)):
            return None
        data = json.loads(_unb64(body))
        if data["exp"] < time.time():
            return None
        return int(data["sub"])
    except (ValueError, KeyError, TypeError):
        return None


def get_current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    user_id = decode_token(creds.credentials) if creds else None
    if user_id is not None:
        with get_conn() as conn:
            row = conn.execute("SELECT id, email FROM users WHERE id = ?", (user_id,)).fetchone()
        if row:
            return {"id": row["id"], "email": row["email"]}
    raise HTTPException(401, "Please log in.", headers={"WWW-Authenticate": "Bearer"})
