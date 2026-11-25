import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request

from app.config import AUTH_RATE_LIMIT_PER_MINUTE
from app.db import get_conn
from app.rate_limit import RateLimiter
from app.schemas.projects import AuthResponse, Credentials, UserOut
from app.security import _DUMMY_HASH, create_token, get_current_user, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])
_limiter = RateLimiter(AUTH_RATE_LIMIT_PER_MINUTE)


def auth_rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    if not _limiter.allow(ip):
        raise HTTPException(429, "Too many attempts. Please wait a minute and try again.")


@router.post("/register", response_model=AuthResponse, dependencies=[Depends(auth_rate_limit)])
def register(creds: Credentials):
    try:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash) VALUES (?, ?)", (creds.email, hash_password(creds.password))
            )
            user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(409, "An account with this email already exists.") from None
    return AuthResponse(token=create_token(user_id), user=UserOut(id=user_id, email=creds.email))


@router.post("/login", response_model=AuthResponse, dependencies=[Depends(auth_rate_limit)])
def login(creds: Credentials):
    with get_conn() as conn:
        row = conn.execute("SELECT id, email, password_hash FROM users WHERE email = ?", (creds.email,)).fetchone()
    ok = verify_password(creds.password, row["password_hash"] if row else _DUMMY_HASH)
    if not row or not ok:
        raise HTTPException(401, "Incorrect email or password.")
    return AuthResponse(token=create_token(row["id"]), user=UserOut(id=row["id"], email=row["email"]))


@router.get("/me", response_model=UserOut)
def me(user: dict = Depends(get_current_user)):
    return UserOut(**user)
