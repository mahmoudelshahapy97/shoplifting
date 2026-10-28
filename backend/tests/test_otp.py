"""Login by email and "forgot your password?" by emailed code.

Needs a live Postgres, like test_integration.py; skipped when unreachable.
Mail never leaves the process: smtplib.SMTP is replaced by a fake that keeps
what would have been sent.
"""

import re
import uuid

import pytest

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.core.security import create_access_token, decode_token
from app.services.auth_service import auth_service
from app.services.otp_service import otp_service
from app.services.user_service import user_service

PASSWORD = "Valid1Password!"
NEW_PASSWORD = "Fresh2Password!"


@pytest.fixture(scope="module")
async def database():
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")
    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")
    await run_migrations()
    yield
    await close_db_pool()


@pytest.fixture
async def user(database):
    suffix = uuid.uuid4().hex[:8]
    row = await user_service.create_user(
        username=f"test-otp-{suffix}",
        email=f"Test.OTP.{suffix}@Example.com",
        password=PASSWORD,
        role="viewer",
    )
    yield row
    await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (row["user_id"],))


class FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout=None):
        self.host = host

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self):
        pass

    def login(self, username, password):
        pass

    def send_message(self, message):
        FakeSMTP.sent.append(message)


@pytest.fixture
def mailer(monkeypatch):
    FakeSMTP.sent = []
    monkeypatch.setattr("smtplib.SMTP", FakeSMTP)
    monkeypatch.setattr(config, "smtp_host", "smtp.test")
    return FakeSMTP


def _code_from(message) -> str:
    body = message.get_body(preferencelist=("plain",)).get_content()
    return re.search(r"code is (\d{6})", body).group(1)


# ------------------------------------------------------------ login by email
async def test_login_accepts_email_in_any_case(user):
    by_email = await user_service.verify_credentials(user["email"].upper(), PASSWORD)
    assert by_email and by_email["user_id"] == user["user_id"]
    assert await user_service.verify_credentials(user["email"], "Wrong1Password!") is None


async def test_login_route_with_email(user, api):
    response = await api.post("/auth/login", json={"username": user["email"].lower(), "password": PASSWORD})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["user_id"] == str(user["user_id"])


# ------------------------------------------------------------- service rules
async def test_code_is_single_use(user):
    code = await otp_service.issue(user["user_id"])
    assert re.fullmatch(r"\d{6}", code)
    assert await otp_service.consume(user["user_id"], code) is True
    assert await otp_service.consume(user["user_id"], code) is False


async def test_resend_window_blocks_a_second_code(user, monkeypatch):
    assert await otp_service.issue(user["user_id"])
    assert await otp_service.issue(user["user_id"]) is None
    monkeypatch.setattr(config, "otp_resend_seconds", 0)
    second = await otp_service.issue(user["user_id"])
    assert second
    # Only the newest code works.
    assert await otp_service.consume(user["user_id"], second) is True


async def test_expired_code_is_rejected(user):
    code = await otp_service.issue(user["user_id"])
    await db_manager.execute_query(
        "UPDATE password_otp SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1",
        (user["user_id"],),
    )
    assert await otp_service.consume(user["user_id"], code) is False
    row = await db_manager.execute_query(
        "SELECT 1 FROM password_otp WHERE user_id = $1", (user["user_id"],), fetch_one=True
    )
    assert row is None


async def test_wrong_guesses_burn_the_code(user, monkeypatch):
    monkeypatch.setattr(config, "otp_max_attempts", 3)
    code = await otp_service.issue(user["user_id"])
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(3):
        assert await otp_service.consume(user["user_id"], wrong) is False
    assert await otp_service.consume(user["user_id"], code) is False


async def test_stored_hash_is_not_the_code(user):
    code = await otp_service.issue(user["user_id"])
    row = await db_manager.execute_query(
        "SELECT otp_hash FROM password_otp WHERE user_id = $1", (user["user_id"],), fetch_one=True
    )
    assert code not in row["otp_hash"]


# ------------------------------------------------------------------- routes
async def test_reset_is_off_without_smtp(api, database, monkeypatch):
    monkeypatch.setattr(config, "smtp_host", "")
    assert (await api.get("/auth/options")).json()["password_reset"] is False
    response = await api.post("/auth/forgot-password", json={"email": "nobody@example.com"})
    assert response.status_code == 503


async def test_full_reset_flow_signs_out_everywhere(user, api, mailer):
    assert (await api.get("/auth/options")).json()["password_reset"] is True
    _, refresh_token, _ = await auth_service.login(user["username"], PASSWORD)
    old_access = create_access_token(user["user_id"], user["role"], user["token_version"])

    response = await api.post("/auth/forgot-password", json={"email": user["email"].lower()})
    assert response.status_code == 200
    assert len(mailer.sent) == 1
    assert mailer.sent[0]["To"] == user["email"]
    code = _code_from(mailer.sent[0])

    weak = await api.post(
        "/auth/reset-password", json={"email": user["email"], "code": code, "new_password": "weakweak"}
    )
    assert weak.status_code == 400

    done = await api.post(
        "/auth/reset-password", json={"email": user["email"], "code": code, "new_password": NEW_PASSWORD}
    )
    assert done.status_code == 200, done.text
    assert await user_service.verify_credentials(user["username"], NEW_PASSWORD)
    assert await user_service.verify_credentials(user["username"], PASSWORD) is None

    # Old sessions and tokens are dead.
    assert await auth_service.refresh(refresh_token) is None
    me = await api.get("/auth/me", headers={"Authorization": f"Bearer {old_access}"})
    assert me.status_code == 401
    assert decode_token(old_access, "access")  # still well-formed, just revoked

    again = await api.post(
        "/auth/reset-password", json={"email": user["email"], "code": code, "new_password": NEW_PASSWORD}
    )
    assert again.status_code == 400


async def test_forgot_password_does_not_reveal_accounts(user, api, mailer):
    unknown = await api.post("/auth/forgot-password", json={"email": "no-such-user@example.com"})
    known = await api.post("/auth/forgot-password", json={"email": user["email"]})
    within_window = await api.post("/auth/forgot-password", json={"email": user["email"]})
    assert unknown.status_code == known.status_code == within_window.status_code == 200
    assert unknown.json() == known.json() == within_window.json()
    assert len(mailer.sent) == 1


async def test_deactivated_account_gets_no_code(user, api, mailer):
    await user_service.update_user(user["user_id"], is_active=False)
    response = await api.post("/auth/forgot-password", json={"email": user["email"]})
    assert response.status_code == 200
    assert mailer.sent == []


async def test_wrong_code_and_unknown_email_look_the_same(user, api, mailer):
    await api.post("/auth/forgot-password", json={"email": user["email"]})
    code = _code_from(mailer.sent[0])
    wrong = "000000" if code != "000000" else "111111"
    bad_code = await api.post(
        "/auth/reset-password", json={"email": user["email"], "code": wrong, "new_password": NEW_PASSWORD}
    )
    no_user = await api.post(
        "/auth/reset-password",
        json={"email": "no-such-user@example.com", "code": code, "new_password": NEW_PASSWORD},
    )
    assert bad_code.status_code == no_user.status_code == 400
    assert bad_code.json() == no_user.json()
