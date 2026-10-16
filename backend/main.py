import csv
import io
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.auth import create_access_token, require_admin, verify_admin_password
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
from backend.utils import generate_qr_image, generate_token

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent


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
    result.update(payload)
    for key in ("event_name", "organization_name", "event_description"):
        result[key] = str(result.get(key, "")).strip()[:500]
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="frontend"), name="static")


# Custom 404 Exception Handler
@app.exception_handler(404)
async def custom_404_handler(request: Request, exc):
    return FileResponse(BASE_DIR / "frontend" / "404.html", status_code=404)


@app.get("/", include_in_schema=False)
def serve_index():
    return FileResponse(BASE_DIR / "frontend" / "index.html")


@app.get("/scanner", include_in_schema=False)
def serve_scanner():
    return FileResponse(BASE_DIR / "frontend" / "scanner.html")


@app.get("/admin", include_in_schema=False)
def serve_admin():
    return FileResponse(BASE_DIR / "frontend" / "admin.html")


@app.get("/settings", include_in_schema=False)
def serve_settings():
    return FileResponse(BASE_DIR / "frontend" / "settings.html")


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
def login(payload: LoginRequest) -> LoginResponse:
    if not verify_admin_password(payload.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect password.",
        )
    return LoginResponse(access_token=create_access_token())


@app.get("/qr/{token}")
def get_qr(token: str) -> StreamingResponse:
    qr_buffer = generate_qr_image(token)
    return StreamingResponse(qr_buffer, media_type="image/png")


@app.post("/import")
async def import_students(
    file: UploadFile = File(...),
    mode: str = Form(...),
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> dict:
    """Restore the app's own CSV backup, either adding or replacing student records."""
    if not file.filename or Path(file.filename).suffix.lower() != ".csv":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only CSV files are supported.")

    mode = (mode or "").strip().lower()
    if mode not in {"add", "replace"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Import mode must be 'add' or 'replace'.")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The CSV file is empty.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="CSV must be saved as UTF-8.") from exc

    # This is a backup/restore format, not a field-mapping import. Requiring the
    # export schema prevents silently dropping fields or inventing replacement data.
    expected_columns = ["name", "roll_no", "course", "contact", "is_used", "created_at", "entry_at", "token", "extra_data"]
    try:
        reader = csv.DictReader(io.StringIO(text, newline=""))
        headers = reader.fieldnames or []
        if headers != expected_columns:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This CSV is not a valid app backup. Please import a CSV exported by this app; its columns and order must be: " + ", ".join(expected_columns),
            )
        raw_rows = []
        for line_number, row in enumerate(reader, start=2):
            if row is None or all(value is None or value == "" for value in row.values()):
                continue
            if None in row:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number} has more columns than the backup format allows.")
            if any(row.get(column) is None for column in expected_columns):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number} has fewer columns than the backup format requires.")
            raw_rows.append((line_number, row))
    except csv.Error as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid CSV: {exc}") from exc

    if not raw_rows:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The CSV contains no student records.")

    def parse_datetime(value: str, field: str, row_number: int):
        if value == "":
            if field == "entry_at":
                return None
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {row_number}: {field} is required.")
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            # Backward compatibility with CSV backups generated by earlier versions.
            for fmt in ("%d/%m/%Y, %I:%M:%S %p", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
                try:
                    return datetime.strptime(value, fmt)
                except ValueError:
                    pass
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {row_number}: invalid {field} value '{value}'.")

    parsed_rows = []
    seen_rolls, seen_tokens = set(), set()
    for line_number, row in raw_rows:
        # Keep CSV text values intact; trim only keys used to enforce uniqueness.
        roll_key = row["roll_no"].strip().casefold()
        token = row["token"]
        if not row["name"].strip() or not roll_key or not row["course"].strip() or not row["contact"].strip():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: name, roll_no, course, and contact cannot be blank.")
        if not token.strip():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: token is required for a complete backup.")
        token_key = token.strip()
        if roll_key in seen_rolls:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: duplicate roll number '{row['roll_no']}' in CSV. No data was changed.")
        if token_key in seen_tokens:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: duplicate token in CSV. No data was changed.")
        seen_rolls.add(roll_key)
        seen_tokens.add(token_key)

        used_text = row["is_used"].strip().lower()
        if used_text not in {"true", "false", "1", "0", "yes", "no"}:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: invalid is_used value '{row['is_used']}'.")
        try:
            extra_data = __import__("json").loads(row["extra_data"] or "{}")
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: extra_data must contain valid JSON.") from exc
        if not isinstance(extra_data, dict):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: extra_data must be a JSON object.")

        is_used = used_text in {"true", "1", "yes"}
        created_at = parse_datetime(row["created_at"], "created_at", line_number)
        entry_at = parse_datetime(row["entry_at"], "entry_at", line_number)
        if is_used and entry_at is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: entry_at is required when is_used is true.")
        if not is_used and entry_at is not None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Row {line_number}: entry_at must be blank when is_used is false.")

        parsed_rows.append(Student(
            name=row["name"], roll_no=row["roll_no"], course=row["course"], contact=row["contact"],
            token=token, is_used=is_used, created_at=created_at, entry_at=entry_at, extra_data=extra_data,
        ))

    existing = db.execute(select(Student)).scalars().all()
    if mode == "add":
        existing_rolls = {student.roll_no.strip().casefold() for student in existing}
        existing_tokens = {student.token.strip() for student in existing}
        rows_to_add = [row for row in parsed_rows if row.roll_no.strip().casefold() not in existing_rolls and row.token.strip() not in existing_tokens]
        skipped = len(parsed_rows) - len(rows_to_add)
        # Avoid duplicates both against the database and within the CSV. Duplicate
        # keys inside the CSV were rejected above, so every accepted row is distinct.
        if not rows_to_add:
            return {"mode": mode, "imported": 0, "skipped": skipped, "message": "No new records to add; matching roll numbers or QR tokens already exist."}
    else:
        rows_to_add = parsed_rows
        skipped = 0

    try:
        if mode == "replace":
            # Only student records are replaced; app settings/admin configuration remain untouched.
            db.query(Student).delete(synchronize_session=False)
        db.add_all(rows_to_add)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Import failed; no changes were saved. Check that the CSV is a valid backup and does not conflict with existing data.") from exc

    return {
        "mode": mode,
        "imported": len(rows_to_add),
        "skipped": skipped,
        "message": "Student records replaced from backup." if mode == "replace" else "New student records added.",
    }


@app.post("/register", response_model=RegisterStudentResponse, status_code=status.HTTP_201_CREATED)
def register_student(payload: RegisterStudentRequest, db: Session = Depends(get_db)) -> RegisterStudentResponse:
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
            continue
        if not text_value:
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
def verify_qr(payload: VerifyQRRequest, db: Session = Depends(get_db)) -> VerifyQRResponse:
    token = sanitize_input(payload.token, "Token")

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
    students = db.execute(select(Student).order_by(Student.created_at.asc(), Student.id.asc())).scalars().all()
    columns = ["name", "roll_no", "course", "contact", "is_used", "created_at", "entry_at", "token", "extra_data"]
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator="\r\n", extrasaction="raise")
    writer.writeheader()
    for student in students:
        writer.writerow({
            "name": student.name,
            "roll_no": student.roll_no,
            "course": student.course,
            "contact": student.contact,
            "is_used": "true" if student.is_used else "false",
            "created_at": student.created_at.isoformat() if student.created_at else "",
            "entry_at": student.entry_at.isoformat() if student.entry_at else "",
            "token": student.token,
            "extra_data": __import__("json").dumps(student.extra_data or {}, ensure_ascii=False, separators=(",", ":")),
        })
    content = "\ufeff" + buffer.getvalue()
    headers = {"Content-Disposition": 'attachment; filename="students_backup.csv"', "Cache-Control": "no-store"}
    return StreamingResponse(iter([content]), media_type="text/csv; charset=utf-8", headers=headers)


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
