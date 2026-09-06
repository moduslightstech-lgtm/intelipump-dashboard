"""JWT auth helpers and FastAPI dependencies."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.models import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(
    *,
    subject: str,
    token_type: str,
    settings: Settings,
    expires_delta: timedelta,
    extra: Optional[dict[str, Any]] = None,
) -> str:
    payload: dict[str, Any] = {
        "sub": subject,
        "type": token_type,
        "exp": datetime.now(timezone.utc) + expires_delta,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def create_access_token(user: User, settings: Settings) -> str:
    return create_token(
        subject=str(user.id),
        token_type="access",
        settings=settings,
        expires_delta=timedelta(minutes=settings.jwt_access_token_expire_minutes),
        extra={"email": user.email, "role": user.role},
    )


def create_refresh_token(user: User, settings: Settings) -> str:
    return create_token(
        subject=str(user.id),
        token_type="refresh",
        settings=settings,
        expires_delta=timedelta(days=settings.jwt_refresh_token_expire_days),
    )


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        if payload.get("type") != "access":
            raise credentials_exception
        user_id = payload.get("sub")
        if not user_id:
            raise credentials_exception
        uid = UUID(user_id)
    except (JWTError, ValueError):
        raise credentials_exception from None

    user = db.get(User, uid)
    if user is None or user.status != "ACTIVE":
        raise credentials_exception
    return user
