import csv
import io
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.auth import (
    client_ip,
    create_access_token,
    login_limiter,
    register_limiter,
    require_admin,
    validate_auth_config,
    verify_admin_password,
)
from backend.database import Base, engine, get_db
from backend.models import Student, AppSettings
from backend.schemas import (
    EntryActionResponse,
    LoginRequest,
    LoginResponse,
    RegisterStudentRequest,
    RegisterStudentResponse,
    ResetEntryResponse,
    StudentResponse,
    VerifyQRRequest,
    VerifyQRResponse,
)
from backend.utils import generate_qr_image, generate_token, is_valid_token

load_dotenv()
validate_auth_config()

BASE_DIR = Path(__file__).resolve().parent.parent

_register_lock = threading.Lock()

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value) -> str:
    """Neutralise spreadsheet formula injection in exported CSV cells."""
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(_FORMULA_PREFIXES) else text


def csv_unsafe(value: str) -> str:
    """Undo csv_safe() when restoring one of our own backups."""
    if len(value) > 1 and value[0] == "'" and value[1] in "=+-@\t\r":
        return value[1:]
    return value


def sanitize_input(value: str, field_name: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} cannot be empty.",
        )
    return cleaned


def ensure_database_schema() -> None:
    from sqlalchemy import inspect

    inspector = inspect(engine)
    if "students" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("students")}
    # Older releases created roll_no as a unique index. Uniqueness is now enforced
    # according to the saved field configuration, so migrate it to a normal index.
    indexes = inspector.get_indexes("students")
    with engine.begin() as connection:
        for index in indexes:
            if index.get("name") == "ix_students_roll_no" and index.get("unique"):
                connection.exec_driver_sql("DROP INDEX IF EXISTS ix_students_roll_no")
        refreshed = __import__("sqlalchemy").inspect(connection).get_indexes("students")
        if not any(index.get("name") == "ix_students_roll_no" for index in refreshed):
            try: connection.exec_driver_sql("CREATE INDEX ix_students_roll_no ON students (roll_no)")
            except Exception: pass
        if "entry_at" not in columns:
            column_type = "DATETIME" if engine.dialect.name == "sqlite" else "TIMESTAMP"
            connection.exec_driver_sql(f"ALTER TABLE students ADD COLUMN entry_at {column_type}")
        if "extra_data" not in columns:
            connection.exec_driver_sql("ALTER TABLE students ADD COLUMN extra_data JSON")
        if engine.dialect.name == "sqlite":
            connection.exec_driver_sql("UPDATE students SET extra_data = '{}' WHERE extra_data IS NULL")
        else:
            connection.exec_driver_sql("UPDATE students SET extra_data = '{}'::json WHERE extra_data IS NULL")


(BASE_DIR / "frontend").mkdir(parents=True, exist_ok=True)
Base.metadata.create_all(bind=engine)
ensure_database_schema()

DEFAULT_SETTINGS = {
    "event_name": "Annual College Fest 2026",
    "organization_name": "Your College Name",
    "event_date": "",
    "event_location": "",
    "event_description": "Fill in the details to issue a single-use QR pass for the gate.",
    "logo_url": "/static/logo.png",
    "brand_color": "#0b6fb8",
    "theme": "system",
    "registration_open": True,
    "scanner_sound": True,
    "scanner_vibration": True,
    "course_options": ["BCA 1st", "BCA 2nd", "BCA 3rd", "PGDCA"],
    "custom_fields": [],
    "field_settings": {},
}

def get_settings(db: Session) -> dict:
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1, config=DEFAULT_SETTINGS.copy())
        db.add(row)
        db.commit()
        db.refresh(row)
    result = DEFAULT_SETTINGS.copy()
    result.update(row.config or {})
    result["field_settings"] = {}
    result.setdefault("search_field", "")
    return result

def clean_settings(payload: dict) -> dict:
    result = DEFAULT_SETTINGS.copy()
    # Only accept known settings keys; ignore anything else in the request body.
    result.update({key: value for key, value in payload.items() if key in DEFAULT_SETTINGS})
    for key in ("event_name", "organization_name", "event_description"):
        result[key] = str(result.get(key, "")).strip()[:500]
    result["event_date"] = str(result.get("event_date") or "").strip()[:40]
    result["event_location"] = str(result.get("event_location") or "").strip()[:200]
    logo_url = str(result.get("logo_url") or "").strip()
    if logo_url:
        is_local_path = re.fullmatch(r"/[A-Za-z0-9._~/-]{1,200}", logo_url) is not None and ".." not in logo_url
        is_http_url = re.fullmatch(r"https?://[^\s\"'<>\\]{1,500}", logo_url) is not None
        if not (is_local_path or is_http_url):
            raise HTTPException(status_code=400, detail="Logo must be a local /path or an http(s) URL.")
    result["logo_url"] = logo_url or DEFAULT_SETTINGS["logo_url"]
    if not result["event_name"]:
        raise HTTPException(status_code=400, detail="Event name is required.")
    color = str(result.get("brand_color", "#0b6fb8"))
    if not __import__("re").fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise HTTPException(status_code=400, detail="Brand color must be a valid hex color.")
    result["brand_color"] = color
    result["theme"] = result.get("theme") if result.get("theme") in ("system", "light", "dark") else "system"
    result["registration_open"] = bool(result.get("registration_open", True))
    result["scanner_sound"] = bool(result.get("scanner_sound", True))
    result["scanner_vibration"] = bool(result.get("scanner_vibration", True))
    options = result.get("course_options", [])
    result["course_options"] = [str(x).strip()[:120] for x in options if str(x).strip()][:50] or DEFAULT_SETTINGS["course_options"]
    fields = result.get("custom_fields", [])
    if not isinstance(fields, list) or len(fields) > 30:
        raise HTTPException(status_code=400, detail="Add up to 30 custom fields.")
    safe_fields = []
    seen_keys = set()
    reserved_keys = {"name", "extra_data"}
    allowed_types = ("text", "email", "tel", "number", "select", "textarea", "date", "url", "checkbox")
    for item in fields:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Each custom field must be a valid object.")
        key = str(item.get("key", "")).strip()
        key = key[:1].upper() + key[1:]  # first letter uppercase, rest kept as typed
        label = str(item.get("label", "")).strip()[:80]
        if not __import__("re").fullmatch(r"[A-Z][A-Za-z0-9_]{0,39}", key) or key.lower() in reserved_keys or not label:
            raise HTTPException(status_code=400, detail="Each custom field needs a label and a valid, non-reserved key.")
        if key.lower() in seen_keys:
            raise HTTPException(status_code=400, detail=f"Custom field key '{key}' is duplicated.")
        seen_keys.add(key.lower())
        field_type = item.get("type") if item.get("type") in allowed_types else "text"
        raw_options = item.get("options", [])
        if not isinstance(raw_options, list): raw_options = []
        options = list(dict.fromkeys(str(option).strip()[:100] for option in raw_options if str(option).strip()))[:30]
        if field_type == "select" and not options:
            raise HTTPException(status_code=400, detail=f"Add at least one dropdown option for '{label}'.")
        min_length = max(0, min(int(item.get("min_length", 0) or 0), 500))
        max_length = max(1, min(int(item.get("max_length", 250) or 250), 5000))
        if min_length > max_length: raise HTTPException(status_code=400, detail=f"Minimum length cannot exceed maximum length for '{label}'.")
        minimum = item.get("min")
        maximum = item.get("max")
        try:
            minimum = float(minimum) if minimum not in (None, "") else None
            maximum = float(maximum) if maximum not in (None, "") else None
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail=f"Minimum and maximum must be numbers for '{label}'.")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise HTTPException(status_code=400, detail=f"Minimum cannot exceed maximum for '{label}'.")
        pattern = str(item.get("pattern", ""))[:200]
        if pattern:
            try: __import__("re").compile(pattern)
            except Exception: raise HTTPException(status_code=400, detail=f"Invalid validation pattern for '{label}'.")
        safe_fields.append({"key":key,"label":label,"type":field_type,"required":bool(item.get("required",False)),"unique":bool(item.get("unique",False)),"search":bool(item.get("search",False)),"placeholder":str(item.get("placeholder", ""))[:160],"help_text":str(item.get("help_text", ""))[:250],"options":options,"min_length":min_length,"max_length":max_length,"min":minimum,"max":maximum,"pattern":pattern,"width":item.get("width") if item.get("width") in ("full","half","third") else "full"})
    result["custom_fields"] = safe_fields
    # Name is the only built-in registration field. All other fields are user-defined.
    result["field_settings"] = {}
    unique_fields = [f for f in safe_fields if f.get("unique")]
    if not safe_fields:
        result["search_field"] = ""
    else:
        selected_search = [f for f in safe_fields if f.get("search") and f.get("unique")]
        if len(selected_search) > 1:
            raise HTTPException(status_code=400, detail="Choose only one unique field for student search.")
        if not unique_fields:
            raise HTTPException(status_code=400, detail="Mark at least one custom field as unique so student records can be searched reliably.")
        result["search_field"] = (selected_search[0] if selected_search else unique_fields[0])["key"]
        for field in safe_fields:
            field["search"] = field["key"] == result["search_field"]
    result["field_settings"] = {}
    return result

app = FastAPI(
    title="College Event QR Entry System",
    description="FastAPI application for QR-based student registration and entry verification.",
    version="1.0.0",
)

# The frontend is served by this app (same origin), so cross-origin access is off
# unless explicitly enabled with a comma-separated CORS_ALLOWED_ORIGINS list.
_cors_origins = [o.strip() for o in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip() and o.strip() != "*"]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

MAX_BODY_BYTES = 1_000_000  # /import has its own 25 MB limit below


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH") and request.url.path != "/import":
        length = request.headers.get("content-length", "")
        if length.isdigit() and int(length) > MAX_BODY_BYTES:
            return JSONResponse({"detail": "Request body too large."}, status_code=413)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
    return response


app.mount("/static", StaticFiles(directory=str(BASE_DIR / "frontend")), name="static")


# Custom 404 Exception Handler
@app.exception_handler(404)
async def custom_404_handler(request: Request, exc):
    return FileResponse(BASE_DIR / "frontend" / "404.html", status_code=404, headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/", include_in_schema=False)
def serve_home():
    return FileResponse(BASE_DIR / "frontend" / "index.html", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/register", include_in_schema=False)
def serve_registration():
    return FileResponse(BASE_DIR / "frontend" / "register.html", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/scanner", include_in_schema=False)
def serve_scanner():
    return FileResponse(BASE_DIR / "frontend" / "scanner.html", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/admin", include_in_schema=False)
def serve_admin():
    return FileResponse(BASE_DIR / "frontend" / "admin.html", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/settings", include_in_schema=False)
def serve_settings():
    return FileResponse(BASE_DIR / "frontend" / "settings.html", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/health")
@app.head("/health")
def health_check():
    return {"status": "ok"}


@app.get("/public-config")
def public_config(db: Session = Depends(get_db)) -> dict:
    settings = get_settings(db)
    return {key: settings[key] for key in ("event_name", "organization_name", "event_date", "event_location", "event_description", "logo_url", "brand_color", "theme", "registration_open", "scanner_sound", "scanner_vibration", "custom_fields", "field_settings", "search_field")}

@app.get("/api/settings")
def read_settings(db: Session = Depends(get_db), _admin: str = Depends(require_admin)) -> dict:
    return get_settings(db)

@app.put("/api/settings")
def update_settings(payload: Dict[str, Any], db: Session = Depends(get_db), _admin: str = Depends(require_admin)) -> dict:
    config = clean_settings(payload)
    row = db.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1, config=config)
        db.add(row)
    else:
        row.config = config
    db.commit()
    return config

@app.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, request: Request) -> LoginResponse:
    key = client_ip(request)
    retry_after = login_limiter.blocked_for(key)
    if retry_after:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed attempts. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )
    if not verify_admin_password(payload.password):
        login_limiter.record(key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect password.",
        )
    login_limiter.clear(key)
    return LoginResponse(access_token=create_access_token())


@app.get("/qr/{token}")
def get_qr(token: str) -> StreamingResponse:
    if not is_valid_token(token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
    qr_buffer = generate_qr_image(token)
    return StreamingResponse(qr_buffer, media_type="image/png", headers={"Cache-Control": "private, no-store"})


@app.post("/import")
async def import_students(
    file: UploadFile = File(...),
    mode: str = Form(...),
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> dict:
    """Import a lossless app backup or any tabular CSV into dynamic entry data."""
    import json

    if not file.filename or Path(file.filename).suffix.lower() != ".csv":
        raise HTTPException(status_code=400, detail="Only CSV files are supported.")
    mode = (mode or "").strip().lower()
    if mode not in {"add", "replace"}:
        raise HTTPException(status_code=400, detail="Choose ADD or REPLACE for the import.")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The CSV file is empty.")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="CSV files must be smaller than 25 MB.")

    text = None
    for encoding in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise HTTPException(status_code=400, detail="Could not decode this CSV file. Save it as UTF-8 and try again.")

    try:
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(io.StringIO(text, newline=""), dialect=dialect)
        headers = reader.fieldnames or []
        if not headers or not any(str(header or "").strip() for header in headers):
            raise HTTPException(status_code=400, detail="The CSV must have a header row.")
        if any(header is None or not str(header).strip() for header in headers):
            raise HTTPException(status_code=400, detail="Every CSV column needs a non-empty header.")
        if len({str(header).strip().casefold() for header in headers}) != len(headers):
            raise HTTPException(status_code=400, detail="The CSV contains duplicate column headers. Rename them so every column is unique.")
        raw_rows = []
        for line_number, row in enumerate(reader, start=2):
            if row is None or all(value is None or value == "" for value in row.values()):
                continue
            if None in row:
                raise HTTPException(status_code=400, detail=f"Row {line_number} has more values than the header row.")
            if any(row.get(header) is None for header in headers):
                raise HTTPException(status_code=400, detail=f"Row {line_number} has fewer values than the header row.")
            raw_rows.append((line_number, {str(k): str(v) if v is not None else "" for k, v in row.items()}))
    except csv.Error as exc:
        raise HTTPException(status_code=400, detail=f"Invalid CSV: {exc}") from exc

    if not raw_rows:
        raise HTTPException(status_code=400, detail="The CSV contains a header but no data rows.")

    # The app's own backup has these system columns and a JSON payload. The JSON
    # payload preserves types and every dynamic key exactly; extra columns are
    # allowed so newer exports can expose custom fields as normal CSV columns.
    backup_columns = {"name", "roll_no", "course", "contact", "is_used", "created_at", "entry_at", "token", "extra_data"}
    header_lookup = {header.strip().casefold(): header for header in headers}
    is_backup = backup_columns.issubset(set(header_lookup))

    def get_cell(row, aliases, default=""):
        for alias in aliases:
            actual = header_lookup.get(alias.casefold())
            if actual is not None:
                return row.get(actual, default)
        return default

    def parse_datetime(value, field, row_number, optional=False):
        value = (value or "").strip()
        if not value and optional:
            return None
        if not value:
            raise HTTPException(status_code=400, detail=f"Row {row_number}: {field} is blank.")
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            for fmt in ("%d/%m/%Y, %I:%M:%S %p", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
                try:
                    return datetime.strptime(value, fmt)
                except ValueError:
                    pass
        raise HTTPException(status_code=400, detail=f"Row {row_number}: invalid {field} value '{value}'.")

    settings = get_settings(db)
    configured_fields = settings.get("custom_fields", [])
    configured_keys = {str(field.get("key", "")).casefold(): str(field.get("key", "")) for field in configured_fields if field.get("key")}
    unique_keys = [str(field.get("key")) for field in configured_fields if field.get("unique") and field.get("key")]
    reserved_aliases = {
        "name": ("name", "full name", "guest name", "participant name", "entry name"),
        "roll_no": ("roll_no", "roll no", "roll number", "rollnumber", "registration id", "registration number", "id"),
        "course": ("course", "category", "group", "department", "type"),
        "contact": ("contact", "contact number", "phone", "phone number", "mobile", "email", "email address"),
        "is_used": ("is_used", "entered", "checked in", "checked_in", "attendance status"),
        "created_at": ("created_at", "registered at", "registration date", "created"),
        "entry_at": ("entry_at", "entered at", "check-in time", "checkin time"),
        "token": ("token", "qr token", "qr_code_token"),
    }

    parsed = []
    seen_tokens = set()
    seen_row_fingerprints = set()
    duplicate_rows = 0
    seen_unique_values = {key: set() for key in unique_keys}
    for line_number, row in raw_rows:
        if is_backup:
            extra_raw = get_cell(row, ("extra_data",), "{}")
            try:
                extra = json.loads(extra_raw or "{}")
            except (ValueError, TypeError) as exc:
                raise HTTPException(status_code=400, detail=f"Row {line_number}: extra_data is not valid JSON.") from exc
            if not isinstance(extra, dict):
                raise HTTPException(status_code=400, detail=f"Row {line_number}: extra_data must be a JSON object.")
            name = csv_unsafe(get_cell(row, ("name",)))
            roll_no = csv_unsafe(get_cell(row, ("roll_no",)))
            course = csv_unsafe(get_cell(row, ("course",)))
            contact = csv_unsafe(get_cell(row, ("contact",)))
            token = get_cell(row, ("token",)).strip()
            used_value = get_cell(row, ("is_used",)).strip().casefold()
            if used_value not in {"true", "false", "1", "0", "yes", "no"}:
                raise HTTPException(status_code=400, detail=f"Row {line_number}: invalid is_used value.")
            is_used = used_value in {"true", "1", "yes"}
            created_at = parse_datetime(get_cell(row, ("created_at",)), "created_at", line_number)
            entry_at = parse_datetime(get_cell(row, ("entry_at",)), "entry_at", line_number, optional=True)
            if is_used and entry_at is None:
                raise HTTPException(status_code=400, detail=f"Row {line_number}: entered records must have entry_at.")
            if not is_used and entry_at is not None:
                raise HTTPException(status_code=400, detail=f"Row {line_number}: entry_at must be blank when is_used is false.")
            if not token:
                raise HTTPException(status_code=400, detail=f"Row {line_number}: backup token is missing.")
            if not is_valid_token(token):
                raise HTTPException(status_code=400, detail=f"Row {line_number}: token may only contain letters, digits, '_' and '-' (max 20 characters).")
        else:
            # Keep every original CSV header/value in extra_data. Known app fields
            # are also mapped to the columns required by the existing QR workflow.
            extra = {}
            for header in headers:
                key = configured_keys.get(header.strip().casefold(), header)
                extra[key] = row.get(header, "")
            name = get_cell(row, reserved_aliases["name"])
            if not name and headers:
                name = row.get(headers[0], "")
            roll_no = get_cell(row, reserved_aliases["roll_no"])
            course = get_cell(row, reserved_aliases["course"])
            contact = get_cell(row, reserved_aliases["contact"])
            token = get_cell(row, reserved_aliases["token"]).strip()
            used_value = get_cell(row, reserved_aliases["is_used"]).strip().casefold()
            is_used = used_value in {"true", "1", "yes", "used", "entered", "checked in"}
            created_value = get_cell(row, reserved_aliases["created_at"])
            entry_value = get_cell(row, reserved_aliases["entry_at"])
            # In a generic CSV, date-like columns are user data first. If they do
            # not match a supported timestamp format, preserve them in extra_data
            # and use safe system timestamps rather than rejecting the whole file.
            try:
                created_at = parse_datetime(created_value, "created_at", line_number) if created_value else datetime.now()
            except HTTPException:
                created_at = datetime.now()
            try:
                entry_at = parse_datetime(entry_value, "entry_at", line_number, optional=True) if entry_value else None
            except HTTPException:
                entry_at = None
            if not is_valid_token(token):
                token = generate_token()
            if is_used and entry_at is None:
                entry_at = created_at

        if len(token) > 20:
            raise HTTPException(status_code=400, detail=f"Row {line_number}: token must be 20 characters or fewer.")
        # Exact duplicate detection includes every imported dynamic field. It does
        # not assume that roll numbers or student-specific columns exist. Check it
        # before token uniqueness so a repeated identical CSV row is simply skipped.
        fingerprint_source = json.dumps(extra, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        fingerprint = fingerprint_source.casefold()
        if fingerprint in seen_row_fingerprints:
            duplicate_rows += 1
            continue
        seen_row_fingerprints.add(fingerprint)
        token_key = token.casefold()
        if token_key in seen_tokens:
            raise HTTPException(status_code=400, detail=f"Row {line_number}: duplicate QR token in different CSV records. No data was changed.")
        seen_tokens.add(token_key)

        for unique_key in unique_keys:
            value = extra.get(unique_key)
            if value is None or str(value).strip() == "":
                continue
            unique_value = str(value).strip().casefold()
            if unique_value in seen_unique_values[unique_key]:
                raise HTTPException(status_code=400, detail=f"Row {line_number}: duplicate value for unique field '{unique_key}'. No data was changed.")
            seen_unique_values[unique_key].add(unique_value)

        parsed.append(Student(
            name=str(name or ""), roll_no=str(roll_no or ""), course=str(course or ""), contact=str(contact or ""),
            token=token, is_used=is_used, created_at=created_at, entry_at=entry_at, extra_data=extra,
        ))

    if not parsed:
        raise HTTPException(status_code=400, detail="No unique data rows were found in this CSV.")

    existing = db.execute(select(Student)).scalars().all()
    existing_tokens = {str(student.token or "").strip().casefold() for student in existing}
    existing_unique_values = {key: set() for key in unique_keys}
    for student in existing:
        data = dict(student.extra_data or {})
        data.update({"name": student.name, "roll_no": student.roll_no, "course": student.course, "contact": student.contact})
        for key in unique_keys:
            value = data.get(key)
            if value is not None and str(value).strip():
                existing_unique_values[key].add(str(value).strip().casefold())

    if mode == "add":
        rows_to_add = []
        skipped = duplicate_rows
        existing_fingerprints = {
            json.dumps(student.extra_data or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).casefold()
            for student in existing
        }
        seen_add_fingerprints = set()
        for student in parsed:
            fp = json.dumps(student.extra_data or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).casefold()
            conflict = fp in existing_fingerprints or fp in seen_add_fingerprints or student.token.strip().casefold() in existing_tokens
            for key in unique_keys:
                value = (student.extra_data or {}).get(key)
                if value is not None and str(value).strip() and str(value).strip().casefold() in existing_unique_values[key]:
                    conflict = True
            if conflict:
                skipped += 1
                continue
            rows_to_add.append(student)
            seen_add_fingerprints.add(fp)
            existing_tokens.add(student.token.strip().casefold())
            for key in unique_keys:
                value = (student.extra_data or {}).get(key)
                if value is not None and str(value).strip():
                    existing_unique_values[key].add(str(value).strip().casefold())
        if not rows_to_add:
            return {"mode": mode, "imported": 0, "skipped": skipped, "message": "No new records to add; all rows were duplicates or conflicted with unique fields."}
    else:
        rows_to_add = parsed
        skipped = len(raw_rows) - len(parsed)

    try:
        if mode == "replace":
            db.query(Student).delete(synchronize_session=False)
            # Detach stale ORM identities before replacement rows reuse primary keys.
            db.expunge_all()
        db.add_all(rows_to_add)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail="Import failed; no data was changed. Check that the CSV rows and unique fields do not conflict.") from exc

    return {
        "mode": mode,
        "imported": len(rows_to_add),
        "skipped": skipped,
        "format": "app-backup" if is_backup else "generic-csv",
        "message": ("Records restored from backup." if is_backup else "Records replaced from CSV.") if mode == "replace" else "Records added from CSV.",
    }


@app.post("/register", response_model=RegisterStudentResponse, status_code=status.HTTP_201_CREATED)
def register_student(payload: RegisterStudentRequest, request: Request, db: Session = Depends(get_db)) -> RegisterStudentResponse:
    retry_after = register_limiter.hit(client_ip(request))
    if retry_after:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registrations from this address. Please wait a moment and try again.",
            headers={"Retry-After": str(retry_after)},
        )
    # Serialise the duplicate check and insert so concurrent requests cannot both
    # claim the same unique value.
    with _register_lock:
        return _register_student(payload, db)


def _register_student(payload: RegisterStudentRequest, db: Session) -> RegisterStudentResponse:
    settings = get_settings(db)
    if not settings.get("registration_open", True):
        raise HTTPException(status_code=403, detail="Registration is currently closed.")
    name = sanitize_input(payload.name, "Name")
    # Name is the only built-in field; every other value is stored in extra_data.
    extra_data = dict(payload.extra_data or {})
    definitions = settings.get("custom_fields", [])
    allowed_keys = {field["key"] for field in definitions}
    extra_data = {key: value for key, value in extra_data.items() if key in allowed_keys}
    import re
    existing_students = db.execute(select(Student)).scalars().all()
    for field in definitions:
        key, label = field["key"], field.get("label", field["key"])
        value = extra_data.get(key, False if field.get("type") == "checkbox" else "")
        text_value = str(value).strip() if value is not None else ""
        if field.get("required") and (not text_value or (field.get("type") == "checkbox" and value is not True)):
            raise HTTPException(status_code=400, detail=f'{label} is required.')
        if field.get("type") == "checkbox":
            if field.get("unique") and value is True and any((student.extra_data or {}).get(key) is True for student in existing_students):
                raise HTTPException(status_code=400, detail=f'{label} must be unique; this value is already registered.')
            if key in extra_data:
                extra_data[key] = value is True
            continue
        if not text_value:
            if key in extra_data:
                extra_data[key] = ""
            continue
        if len(text_value) < int(field.get("min_length", 0) or 0) or len(text_value) > int(field.get("max_length", 5000) or 5000):
            raise HTTPException(status_code=400, detail=f'{label} must be between {field.get("min_length",0)} and {field.get("max_length",5000)} characters.')
        if field.get("pattern") and not re.fullmatch(field["pattern"], text_value):
            raise HTTPException(status_code=400, detail=f'{label} has an invalid format.')
        if field.get("type") == "email" and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", text_value):
            raise HTTPException(status_code=400, detail=f'Enter a valid {label.lower()}.')
        if field.get("type") == "select" and text_value not in field.get("options", []):
            raise HTTPException(status_code=400, detail=f'Invalid value for {label}.')
        if field.get("type") == "number":
            try: number_value = float(text_value)
            except ValueError: raise HTTPException(status_code=400, detail=f'{label} must be a number.')
            if field.get("min") is not None and number_value < field["min"]: raise HTTPException(status_code=400, detail=f'{label} must be at least {field["min"]}.')
            if field.get("max") is not None and number_value > field["max"]: raise HTTPException(status_code=400, detail=f'{label} must be at most {field["max"]}.')
        if field.get("unique"):
            if any(str((student.extra_data or {}).get(key, getattr(student, key, ""))).strip().casefold() == text_value.casefold() for student in existing_students):
                raise HTTPException(status_code=400, detail=f'{label} must be unique; this value is already registered.')
        # Store a plain string, never a nested object or list supplied by the client.
        extra_data[key] = text_value

    roll_no = ""
    course = ""
    contact = ""
    token = generate_token()
    while db.execute(select(Student).where(Student.token == token)).scalar_one_or_none():
        token = generate_token()

    student = Student(name=name, roll_no=roll_no, course=course, contact=contact, token=token, extra_data=extra_data)

    try:
        db.add(student)
        db.flush()
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unable to register student because the roll number or token already exists.",
        )
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to register the student.",
        ) from exc

    return RegisterStudentResponse(
        message="Student registered successfully.",
        token=token,
        qr_code_url=f"/qr/{token}",
    )


@app.post("/verify", response_model=VerifyQRResponse)
def verify_qr(
    payload: VerifyQRRequest,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> VerifyQRResponse:
    token = sanitize_input(payload.token, "Token")
    if not is_valid_token(token):
        return VerifyQRResponse(status="INVALID", message="Invalid QR code.")

    try:
        result = db.execute(
            update(Student)
            .where(Student.token == token, Student.is_used.is_(False))
            .values(is_used=True, entry_at=datetime.now())
        )

        if result.rowcount == 1:
            db.commit()
            return VerifyQRResponse(status="VALID", message="Entry allowed.")

        student = db.execute(select(Student).where(Student.token == token)).scalar_one_or_none()
        if student is None:
            return VerifyQRResponse(status="INVALID", message="Invalid QR code.")

        return VerifyQRResponse(status="USED", message="This QR code has already been used.")
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to verify the QR code.",
        ) from exc


@app.post("/manual-entry/{student_id}", response_model=EntryActionResponse)
def manual_entry(
    student_id: int,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> EntryActionResponse:
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")

    if student.is_used:
        return EntryActionResponse(
            status="USED",
            message="Student is already marked present.",
            entry_at=student.entry_at,
        )

    try:
        student.is_used = True
        student.entry_at = student.entry_at or datetime.now()
        db.commit()
        db.refresh(student)
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to mark the student present.",
        ) from exc

    return EntryActionResponse(
        status="VALID",
        message="Student marked present successfully.",
        entry_at=student.entry_at,
    )


@app.post("/reset-entry/{student_id}", response_model=ResetEntryResponse)
def reset_entry(
    student_id: int,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> ResetEntryResponse:
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")

    try:
        student.is_used = False
        student.entry_at = None
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reset the student entry.",
        ) from exc

    return ResetEntryResponse(message="Entry reset successfully.", entry_at=None)


@app.get("/students", response_model=List[StudentResponse])
def get_students(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> List[StudentResponse]:
    return db.execute(select(Student).order_by(Student.created_at.desc())).scalars().all()


@app.get("/export")
def export_students(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> StreamingResponse:
    """Export a round-trip-safe backup with readable dynamic CSV columns."""
    import json

    students = db.execute(select(Student).order_by(Student.created_at.asc(), Student.id.asc())).scalars().all()
    base_columns = ["name", "roll_no", "course", "contact", "is_used", "created_at", "entry_at", "token", "extra_data"]
    reserved_columns = {column.casefold() for column in base_columns}
    dynamic_keys = sorted({str(key) for student in students for key in (student.extra_data or {}).keys() if str(key).casefold() not in reserved_columns})
    columns = base_columns + dynamic_keys
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator="\r\n", extrasaction="raise")
    writer.writeheader()
    for student in students:
        extra = student.extra_data or {}
        row = {
            "name": csv_safe(student.name),
            "roll_no": csv_safe(student.roll_no),
            "course": csv_safe(student.course),
            "contact": csv_safe(student.contact),
            "is_used": "true" if student.is_used else "false",
            "created_at": student.created_at.isoformat() if student.created_at else "",
            "entry_at": student.entry_at.isoformat() if student.entry_at else "",
            "token": student.token,
            # JSON keeps arbitrary field names and value types lossless on restore.
            "extra_data": json.dumps(extra, ensure_ascii=False, separators=(",", ":"), default=str),
        }
        for key in dynamic_keys:
            value = extra.get(key, "")
            row[key] = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, (dict, list)) else ("true" if value is True else "false" if value is False else "" if value is None else csv_safe(value))
        writer.writerow(row)
    content = "\ufeff" + buffer.getvalue()
    headers = {"Content-Disposition": 'attachment; filename="entry_data_backup.csv"', "Cache-Control": "no-store"}
    return StreamingResponse(iter([content]), media_type="text/csv; charset=utf-8", headers=headers)



@app.put("/student/{student_id}", response_model=StudentResponse)
def edit_student(
    student_id: int,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> StudentResponse:
    """Edit an existing dynamic entry without changing its QR or attendance history."""
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=404, detail="Entry not found.")

    if "name" not in payload or not isinstance(payload.get("extra_data", {}), dict):
        raise HTTPException(status_code=400, detail="Entry data must include a name and an extra_data object.")
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty.")
    if len(name) > 120:
        raise HTTPException(status_code=400, detail="Name must be 120 characters or fewer.")

    old_extra = dict(student.extra_data or {})
    new_extra = dict(payload.get("extra_data") or {})
    # Merge submitted editable values into existing dynamic data so an edit can
    # never accidentally discard fields unknown to the current UI.
    old_extra.update(new_extra)
    new_extra = old_extra

    settings = get_settings(db)
    definitions = settings.get("custom_fields", [])
    existing_students = db.execute(select(Student).where(Student.id != student_id)).scalars().all()
    import re
    for field in definitions:
        key = field.get("key")
        if not key:
            continue
        label = field.get("label", key)
        value = new_extra.get(key, False if field.get("type") == "checkbox" else "")
        text_value = str(value).strip() if value is not None else ""
        if field.get("required") and (not text_value or (field.get("type") == "checkbox" and value is not True)):
            raise HTTPException(status_code=400, detail=f"{label} is required.")
        if field.get("type") == "checkbox":
            if field.get("unique") and value is True and any((other.extra_data or {}).get(key) is True for other in existing_students):
                raise HTTPException(status_code=400, detail=f"{label} must be unique; this value is already in use.")
            new_extra[key] = bool(value)
            continue
        if not text_value:
            continue
        if len(text_value) < int(field.get("min_length", 0) or 0) or len(text_value) > int(field.get("max_length", 5000) or 5000):
            raise HTTPException(status_code=400, detail=f"{label} must be between {field.get('min_length', 0)} and {field.get('max_length', 5000)} characters.")
        if field.get("pattern") and not re.fullmatch(field["pattern"], text_value):
            raise HTTPException(status_code=400, detail=f"{label} has an invalid format.")
        if field.get("type") == "email" and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", text_value):
            raise HTTPException(status_code=400, detail=f"Enter a valid {label.lower()}.")
        if field.get("type") == "select" and text_value not in field.get("options", []):
            raise HTTPException(status_code=400, detail=f"Invalid value for {label}.")
        if field.get("type") == "number":
            try:
                number_value = float(text_value)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"{label} must be a number.")
            if field.get("min") is not None and number_value < field["min"]:
                raise HTTPException(status_code=400, detail=f"{label} must be at least {field['min']}.")
            if field.get("max") is not None and number_value > field["max"]:
                raise HTTPException(status_code=400, detail=f"{label} must be at most {field['max']}.")
        if field.get("unique") and any(
            str((other.extra_data or {}).get(key, getattr(other, key, ""))).strip().casefold() == text_value.casefold()
            for other in existing_students
        ):
            raise HTTPException(status_code=400, detail=f"{label} must be unique; this value is already in use.")

    student.name = name
    student.extra_data = new_extra
    try:
        db.commit()
        db.refresh(student)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail="This entry conflicts with an existing unique value.") from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to update the entry.") from exc
    return student


@app.delete("/student/{student_id}")
def delete_student(
    student_id: int,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> dict:
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")

    try:
        db.delete(student)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete the student record.",
        ) from exc

    return {"message": "Student deleted successfully."}
