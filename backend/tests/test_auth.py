"""Auth: password hashing, JWT lifecycle, role ladder, and the DB-backed
refresh/revocation flow.

The password/token tests below need no database and always run. The
`database` fixture mirrors test_integration.py's: connect once for the
module, or skip the whole file when nothing is reachable -- config.SECRET_KEY
still has to be set either way (it has no default, see app/core/config.py),
same as running the app itself.
"""

import time
import uuid

import pytest

from app.api.deps import ROLE_LEVEL
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    validate_password_strength,
    verify_password,
)

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------- passwords
async def test_password_hash_roundtrip():
    hashed = hash_password("Sup3r$ecret!")
    assert verify_password("Sup3r$ecret!", hashed)
    assert not verify_password("wrong-password", hashed)


async def test_password_hash_is_not_the_plaintext():
    hashed = hash_password("Sup3r$ecret!")
    assert hashed != "Sup3r$ecret!"
    assert hashed.startswith("$argon2")


async def test_verify_password_rejects_empty_hash():
    assert not verify_password("anything", "")
    assert not verify_password("anything", None)


@pytest.mark.parametrize(
    "password,should_pass",
    [
        ("short1!", False),  # too short
        ("alllowercase1!", False),  # no uppercase
        ("ALLUPPERCASE1!", False),  # no lowercase
        ("NoDigitsHere!", False),  # no digit
        ("NoSymbolHere1", False),  # no symbol
        ("Valid1Password!", True),
    ],
)
async def test_password_strength_rules(password, should_pass):
    ok, message = validate_password_strength(password)
    assert ok is should_pass, message


# ------------------------------------------------------------------ tokens
async def test_access_token_round_trip():
    user_id = uuid.uuid4()
    token = create_access_token(user_id, "admin", token_version=1)
    payload = decode_token(token, "access")

    assert payload is not None
    assert payload["sub"] == str(user_id)
    assert payload["role"] == "admin"
    assert payload["tv"] == 1
    assert payload["token_type"] == "access"


async def test_refresh_token_round_trip():
    user_id = uuid.uuid4()
    token, jti = create_refresh_token(user_id)
    payload = decode_token(token, "refresh")

    assert payload is not None
    assert payload["sub"] == str(user_id)
    assert payload["jti"] == str(jti)
    assert payload["token_type"] == "refresh"


async def test_token_type_mismatch_is_rejected():
    """An access token presented where a refresh token is expected (or vice
    versa) must fail closed -- this is what stops a leaked access token from
    being replayed against /auth/refresh."""
    access_token = create_access_token(uuid.uuid4(), "viewer", 1)
    refresh_token, _ = create_refresh_token(uuid.uuid4())

    assert decode_token(access_token, "refresh") is None
    assert decode_token(refresh_token, "access") is None


async def test_garbage_and_empty_tokens_are_rejected():
    assert decode_token("not-a-jwt", "access") is None
    assert decode_token("", "access") is None
    assert decode_token(None, "access") is None


async def test_tampered_signature_is_rejected():
    token = create_access_token(uuid.uuid4(), "admin", 1)
    tampered = token[:-4] + ("0" * 4 if token[-4:] != "0000" else "1111")
    assert decode_token(tampered, "access") is None


async def test_expired_token_is_rejected(monkeypatch):
    from app.core import security as security_module

    monkeypatch.setattr(security_module.config, "access_token_expire_minutes", 0)
    token = create_access_token(uuid.uuid4(), "viewer", 1)
    time.sleep(1.1)
    assert decode_token(token, "access") is None


# ------------------------------------------------------------------- roles
async def test_role_ladder_is_ordered():
    assert ROLE_LEVEL["viewer"] < ROLE_LEVEL["operator"] < ROLE_LEVEL["admin"]


@pytest.mark.parametrize(
    "actual,minimum,allowed",
    [
        ("viewer", "viewer", True),
        ("viewer", "operator", False),
        ("viewer", "admin", False),
        ("operator", "viewer", True),
        ("operator", "operator", True),
        ("operator", "admin", False),
        ("admin", "viewer", True),
        ("admin", "operator", True),
        ("admin", "admin", True),
    ],
)
async def test_role_ladder_allows_and_denies(actual, minimum, allowed):
    assert (ROLE_LEVEL[actual] >= ROLE_LEVEL[minimum]) is allowed


# ============================================================== DB-backed
# Everything below needs a live Postgres with the auth tables applied (see
# database/schema.sql: app_user, refresh_session). Skipped automatically when
# unreachable, same as test_integration.py.

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.services.auth_service import auth_service
from app.services.user_service import user_service


@pytest.fixture(scope="module")
async def database():
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")

    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")

    yield
    await close_db_pool()


@pytest.fixture
async def test_user(database):
    """A throwaway operator account, deleted whether or not the test passed."""
    suffix = uuid.uuid4().hex[:8]
    user = await user_service.create_user(
        username=f"test-auth-{suffix}",
        email=f"test-auth-{suffix}@example.com",
        password="Valid1Password!",
        role="operator",
    )
    yield user
    await db_manager.execute_query(
        "DELETE FROM app_user WHERE user_id = $1", (user["user_id"],)
    )


async def test_verify_credentials_accepts_correct_password(test_user):
    result = await user_service.verify_credentials(test_user["username"], "Valid1Password!")
    assert result is not None
    assert result["user_id"] == test_user["user_id"]


async def test_verify_credentials_rejects_wrong_password(test_user):
    assert await user_service.verify_credentials(test_user["username"], "WrongPassword1!") is None


async def test_verify_credentials_rejects_deactivated_account(test_user):
    await user_service.update_user(test_user["user_id"], is_active=False)
    assert await user_service.verify_credentials(test_user["username"], "Valid1Password!") is None


async def test_token_version_bump_invalidates_existing_token(test_user):
    """The core of instant revocation: a token minted with the old
    token_version must be rejected once the row's version has moved on, even
    though the JWT itself has not expired."""
    access_token = create_access_token(test_user["user_id"], test_user["role"], test_user["token_version"])
    payload = decode_token(access_token, "access")
    assert payload["tv"] == test_user["token_version"]

    await user_service.bump_token_version(test_user["user_id"])
    refreshed = await user_service.get_by_id(test_user["user_id"])
    assert refreshed["token_version"] == test_user["token_version"] + 1
    # The guard in app/api/deps.py compares payload["tv"] to this new value and
    # would now reject the old token -- asserted directly here since exercising
    # the FastAPI dependency itself needs a running app.
    assert payload["tv"] != refreshed["token_version"]


async def test_refresh_rotates_and_revokes_the_old_session(test_user):
    access_token, refresh_token = await auth_service.issue_token_pair(test_user)
    old_payload = decode_token(refresh_token, "refresh")

    result = await auth_service.refresh(refresh_token)
    assert result is not None
    new_access, new_refresh, user = result
    assert user["user_id"] == test_user["user_id"]
    assert new_refresh != refresh_token

    # The spent refresh token is now a revoked session, not just an expired
    # claim, so presenting it again must fail even though the JWT itself would
    # still decode and pass expiry.
    assert await auth_service.refresh(refresh_token) is None

    session = await db_manager.execute_query(
        "SELECT revoked_at FROM refresh_session WHERE jti = $1",
        (uuid.UUID(old_payload["jti"]),),
        fetch_one=True,
    )
    assert session["revoked_at"] is not None


async def test_logout_all_revokes_every_session_for_the_user(test_user):
    _, refresh_a = await auth_service.issue_token_pair(test_user)
    _, refresh_b = await auth_service.issue_token_pair(test_user)

    await auth_service.logout_all(test_user["user_id"])

    assert await auth_service.refresh(refresh_a) is None
    assert await auth_service.refresh(refresh_b) is None
