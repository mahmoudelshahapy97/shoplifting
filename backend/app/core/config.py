# app/core/config.py
"""Central application configuration loaded from environment variables and .env."""

from typing import List, Literal

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()


class Settings(BaseSettings):
    """
    Central application configuration.
    Loaded from:
    - Environment variables
    - .env
    - Defaults below
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # =========================================================================
    # APPLICATION
    # =========================================================================
    app_name: str = "Shoplifting API"
    app_description: str = "Pose-based shoplifting detection, incident triage and loss analytics"
    app_version: str = "1.0.0"
    app_api_prefix: str = "/api/v1"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_debug: bool = True
    environment: Literal["development", "staging", "production"] = "development"

    # =========================================================================
    # CORS
    # =========================================================================
    cors_origins: List[str] = ["http://localhost:3000", "http://localhost:8000"]
    cors_allow_credentials: bool = True
    cors_allow_methods: List[str] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    cors_allow_headers: List[str] = ["Content-Type", "Authorization", "X-Request-ID", "X-Workspace-Id"]

    # =========================================================================
    # AUTH
    # =========================================================================
    # No default: pydantic-settings refuses to build Settings without this set,
    # which is the right failure mode for a signing key. Generate one with:
    #   python -c "import secrets; print(secrets.token_urlsafe(48))"
    secret_key: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # Sent alongside the bearer token so <img src="..."> endpoints (camera
    # snapshots, incident frames and clips) can authenticate without a
    # header. Never accepted on a route that changes state -- see
    # app/api/deps.py.
    auth_cookie_name: str = "sl_access"
    auth_cookie_secure: bool = False
    auth_cookie_samesite: str = "lax"

    # There is no public signup. If app_user is empty at startup, one admin is
    # created from these three values -- see ensure_bootstrap_admin() in
    # app/services/user_service.py. Change the password immediately after.
    bootstrap_admin_username: str = "admin"
    bootstrap_admin_email: str = "admin@insighteye.local"
    bootstrap_admin_password: str = "ChangeMe!123"

    # "Forgot your password?": a one-time code mailed to the account's email
    # (app/services/otp_service.py). Off while SMTP_HOST is empty.
    otp_ttl_seconds: int = 600
    otp_resend_seconds: int = 60
    otp_max_attempts: int = 5

    # =========================================================================
    # EMAIL (SMTP)
    # =========================================================================
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "Shoplifting <no-reply@insighteye.local>"
    smtp_starttls: bool = True   # STARTTLS on smtp_port (587)
    smtp_ssl: bool = False       # implicit TLS instead (465)
    smtp_timeout_seconds: float = 20.0

    @property
    def password_reset_enabled(self) -> bool:
        return bool(self.smtp_host)

    # =========================================================================
    # LOGGING
    # =========================================================================
    log_level: str = "INFO"
    log_format: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    log_file_path: str = "logs/shoplifting.log"

    # =========================================================================
    # DATABASE
    # =========================================================================
    postgres_db: str = "shoplifting_db"
    postgres_user: str = "shoplifting"
    postgres_password: str = "shoplifting_pass"
    db_host: str = "db"
    db_port: int = 5432

    db_min_pool_size: int = 2
    db_max_pool_size: int = 10
    db_timeout: float = 30.0
    db_command_timeout: float = 60.0
    db_max_retries: int = 10
    db_retry_delay_base: int = 2
    db_retry_delay_max: int = 30

    # database/migrations, mounted read-only by docker-compose.yml. When this
    # path is missing (a checkout run outside Docker) the repo's own folder is
    # used -- see app/core/migrations.py.
    migrations_dir: str = "/app/migrations"

    @property
    def database_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.db_host}:{self.db_port}/{self.postgres_db}"
        )

    # =========================================================================
    # MODELS
    # =========================================================================
    model_device: str = "cpu"

    # People and their 17 COCO keypoints, tracked across frames. The pose
    # model is what InsightEye runs (yolo26m-pose); ByteTrack gives every person
    # their own id, so each is judged on their own movements.
    pose_model_path: str = "models/yolo26m-pose.pt"
    pose_confidence: float = 0.25
    pose_input_size: int = 640
    pose_tracker: str = "trackers/shoplifting_bytetrack.yaml"
    # FP16 inference on CUDA; ignored on CPU.
    pose_half: bool = True

    # The temporal classifier (Conv1d + BiGRU + attention over keypoint
    # sequences) from InsightEye: app/services/shoplifting_model.py. Its
    # window is fixed by training: 120 samples of 17 keypoints x 12 features.
    classifier_model_path: str = "models/shoplifting.pt"

    # =========================================================================
    # SHOPLIFTING DETECTOR
    # =========================================================================
    # Samples per second fed into a person's window. InsightEye samples every
    # 10th frame of a 30 fps stream, i.e. 3 fps, so a window spans 40 s; the
    # weights separate shoplifting from normal shopping best at that rate
    # (backend/tools/eval_shoplifting.py).
    sample_fps: float = 3.0
    # Smoothed (mean of the last smooth_window) shoplifting probability that
    # raises an alert. InsightEye's .env runs at 0.15; 0.5 is the class boundary.
    shoplifting_threshold: float = 0.5
    smooth_window: int = 3
    # Ignore people whose box is shorter than this: too small to read a pose.
    min_person_height_px: float = 60.0
    # One alert per person per this many seconds, and per camera across people.
    track_cooldown_seconds: float = 300.0
    camera_cooldown_seconds: float = 30.0
    # Processed frames a person may be missing before their session ends.
    track_max_misses: int = 15
    # A new tracker id appearing this soon after a person vanished, at a
    # similar size, continues that person's window (0 = never). 5 s is as long
    # as a lost person is remembered (TRACK_MAX_MISSES at 3 fps).
    track_handover_seconds: float = 5.0
    # Real samples of a person before they are first judged (30 = 10 s at
    # 3 fps); the rest of the 120-row window is the empty rows InsightEye's
    # buffer held before anyone walked in.
    min_window_samples: int = 30
    # Peak probability -> severity: critical >= .9, high >= .75, medium >= .6.
    severity_critical: float = 0.9
    severity_high: float = 0.75
    severity_medium: float = 0.6
    # One probability sample per tracked person this often feeds the model
    # audit, the real-time monitor and camera health.
    observation_interval_s: float = 5.0

    # =========================================================================
    # RTSP / STREAM
    # =========================================================================
    rtsp_transport: str = "tcp"
    rtsp_buffer_size: int = 1
    rtsp_open_timeout: float = 15.0
    rtsp_read_failure_limit: int = 30
    rtsp_reconnect_delay_base: float = 2.0
    rtsp_reconnect_delay_max: float = 30.0

    frame_skip: int = 5
    # Matches sample_fps: every processed frame is one sample of the window.
    target_process_fps: float = 3.0
    jpeg_quality: int = 85

    stream_start_stagger_delay: float = 2.0
    stream_worker_restart_delay: float = 5.0

    # Every live viewer costs one JPEG encode per frame; cap them so a wall of
    # open browser tabs cannot starve detection.
    max_mjpeg_clients: int = 4

    # =========================================================================
    # WORKER SUPERVISION
    # =========================================================================
    # Restarts workers that died, errored, or wedged inside a blocking read,
    # and starts enabled cameras that have no worker. Without it a camera whose
    # model load failed stays dark until someone notices by hand.
    worker_supervision_enabled: bool = True
    worker_supervision_interval_s: float = 15.0
    worker_restart_backoff_base_s: float = 5.0
    worker_restart_backoff_max_s: float = 300.0

    # =========================================================================
    # EVIDENCE CLIPS
    # =========================================================================
    # One annotated mp4 per incident: clip_pre_seconds before the alert and
    # clip_post_seconds after. The classifier judges the last 40 s, so the
    # pre-roll holds the behaviour that raised it.
    clip_enabled: bool = True
    clip_dir: str = "data/clips"
    clip_pre_seconds: float = 20.0
    clip_post_seconds: float = 10.0
    clip_max_width: int = 960
    clip_jpeg_quality: int = 70

    # =========================================================================
    # OBJECT STORAGE (MinIO)
    # =========================================================================
    # Images and videos go to MinIO; Postgres keeps the records and object keys.
    # Empty endpoint = disabled: media stays in Postgres bytes / clip files.
    minio_endpoint: str = ""
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "shoplifting"
    minio_secure: bool = False

    # =========================================================================
    # NOTIFICATIONS
    # =========================================================================
    # Every incident is addressed to each account that can see its workspace
    # and pushed to their open consoles (app/services/notification_service.py).
    notifications_enabled: bool = True
    # Incidents below this severity are recorded but notify no one.
    notification_min_severity: Literal["low", "medium", "high", "critical"] = "low"
    # An idle socket gets a ping this often, which also re-checks the account
    # and closes the socket once the access token it opened with expires.
    notification_ws_ping_s: float = 25.0

    # =========================================================================
    # RETENTION
    # =========================================================================
    retention_enabled: bool = True
    retention_interval_s: float = 21600.0  # 6 hours
    clip_retention_days: int = 30
    clip_max_total_mb: int = 5120
    # Probability samples are only read in aggregate; older ones are dropped.
    observation_retention_days: int = 30
    notification_retention_days: int = 30


config = Settings()
