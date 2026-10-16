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
from sqlalchemy import delete, select, update
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
    mode: str = Form("add"),
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> dict:
    """Import arbitrary CSV rows, either adding unique records or replacing all records."""
    mode = (mode or "add").strip().lower()
    if mode not in {"add", "replace"}:
        raise HTTPException(status_code=400, detail="Import mode must be 'add' or 'replace'.")
    filename = (file.filename or "").strip()
    if not filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please choose a .csv file.")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The selected CSV file is empty.")
    text = None
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise HTTPException(status_code=400, detail="Could not decode this CSV file.")

    # Excel commonly exports commas, semicolons, or tabs depending on locale.
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    headers = [str(h or "").strip().lstrip("\ufeff") for h in (reader.fieldnames or [])]
    if not headers or not any(headers):
        raise HTTPException(status_code=400, detail="The CSV must have a header row with column names.")
    reader.fieldnames = headers
    if not any(row for row in reader):
        raise HTTPException(status_code=400, detail="The CSV has headers but no data rows.")
    # Recreate the reader because the emptiness check above consumed it.
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    reader.fieldnames = headers

    def norm(value: Any) -> str:
        return "".join(ch.lower() for ch in str(value or "") if ch.isalnum())

    def parse_dt(value: Any):
        value = str(value or "").strip()
        if not value:
            return None
        for fmt in ("%d/%m/%Y, %I:%M:%S %p", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                pass
        return None

    aliases = {
        "name": {"name", "studentname", "guestname", "fullname", "full name"},
        "roll_no": {"rollno", "rollnumber", "studentid", "studentnumber", "registrationno", "registrationnumber", "id"},
        "course": {"course", "class", "department", "program", "branch"},
        "contact": {"contact", "phone", "phonenumber", "mobile", "mobilenumber", "telephone"},
        "token": {"token", "qrtoken", "qrid"},
        "is_used": {"isused", "used", "entered", "present", "status"},
        "created_at": {"createdat", "registeredat", "registrationdate", "createddate"},
        "entry_at": {"entryat", "enteredat", "entrytime"},
        "extra_data": {"extradata", "customdata"},
    }
    header_by_field = {}
    for header in headers:
        normalized = norm(header)
        for field, names in aliases.items():
            if normalized in {norm(name) for name in names} and field not in header_by_field:
                header_by_field[field] = header

    imported, skipped, errors = 0, 0, []
    # Replacement is deliberately performed only after the CSV has been decoded
    # and its header/data rows validated. It is committed with the new records.
    if mode == "replace":
        db.execute(delete(Student))
        db.flush()

    existing_rolls = {str(v).strip() for v in db.execute(select(Student.roll_no)).scalars() if str(v or "").strip()}
    existing_payloads = set()
    for existing in db.execute(select(Student)).scalars():
        try:
            existing_payloads.add(__import__("json").dumps(existing.extra_data or {}, sort_keys=True, ensure_ascii=False, default=str))
        except (TypeError, ValueError):
            pass
    seen_payloads = set()
    for row_number, row in enumerate(reader, start=2):
        # Keep every original CSV column/value, including unknown fields and blanks.
        original_data = {header: (row.get(header) if row.get(header) is not None else "") for header in headers}
        def value_for(field: str) -> str:
            header = header_by_field.get(field)
            value = row.get(header, "") if header else ""
            return str(value or "").strip()

        name = value_for("name")
        # The database has legacy required columns; populate them safely without
        # requiring a particular CSV schema. Original values remain in extra_data.
        if not name:
            name = next((str(v).strip() for v in original_data.values() if str(v).strip()), f"Imported row {row_number}")
        roll_no = value_for("roll_no")
        course = value_for("course")
        contact = value_for("contact")

        imported_extra_data = {}
        extra_header = header_by_field.get("extra_data")
        if extra_header:
            try:
                parsed = __import__("json").loads(row.get(extra_header) or "{}")
                if isinstance(parsed, dict):
                    imported_extra_data.update(parsed)
            except (ValueError, TypeError):
                pass
        # Keep arbitrary CSV columns exactly as labelled. For the exported format,
        # unpack extra_data JSON and avoid overwriting it with its serialized text.
        for header, value in original_data.items():
            if header == extra_header:
                continue
            imported_extra_data[header] = value

        # De-duplicate both against existing data (add mode) and within this file.
        # A supplied roll/registration ID is the strongest identity; otherwise an
        # exact match of all preserved CSV fields is treated as a duplicate.
        payload_key = __import__("json").dumps(imported_extra_data, sort_keys=True, ensure_ascii=False, default=str)
        if (roll_no and roll_no in existing_rolls) or payload_key in existing_payloads or payload_key in seen_payloads:
            errors.append(f"Row {row_number}: duplicate data; skipped.")
            skipped += 1
            continue
        seen_payloads.add(payload_key)
        if roll_no:
            existing_rolls.add(roll_no)

        is_used = value_for("is_used").lower() in ("true", "1", "yes", "y", "entered", "present")
        status_value = value_for("is_used").lower()
        if status_value in ("false", "0", "no", "n", "not entered", "absent"):
            is_used = False
        created_at = parse_dt(value_for("created_at")) or datetime.now()
        entry_at = parse_dt(value_for("entry_at")) if is_used else None
        token = value_for("token")
        if not token or db.execute(select(Student).where(Student.token == token)).scalar_one_or_none():
            if token:
                errors.append(f"Row {row_number}: duplicate QR token was regenerated.")
            token = generate_token()
            while db.execute(select(Student).where(Student.token == token)).scalar_one_or_none():
                token = generate_token()

        try:
            with db.begin_nested():
                db.add(Student(name=name[:120], roll_no=roll_no[:50], course=course[:120], contact=contact[:50],
                               token=token, is_used=is_used, created_at=created_at, entry_at=entry_at,
                               extra_data=imported_extra_data))
                db.flush()
            imported += 1
            existing_payloads.add(payload_key)
        except IntegrityError:
            errors.append(f"Row {row_number}: could not save this row because it conflicts with existing data; skipped.")
            skipped += 1
    db.commit()
    return {"mode": mode, "imported": imported, "skipped": skipped, "errors": errors}


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
    students = db.execute(select(Student).order_by(Student.created_at.desc())).scalars().all()

    def fmt(dt):
        return dt.astimezone(ZoneInfo("Asia/Kolkata")).strftime("%d/%m/%Y, %I:%M:%S %p") if dt else ""

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["name", "roll_no", "course", "contact", "is_used", "created_at", "entry_at", "token", "extra_data"])

    for s in students:
        writer.writerow([s.name, s.roll_no, s.course, s.contact, s.is_used, fmt(s.created_at), fmt(s.entry_at), s.token, __import__("json").dumps(s.extra_data or {}, ensure_ascii=False)])

    headers = {"Content-Disposition": 'attachment; filename="students_export.csv"'}
    return StreamingResponse(iter([buffer.getvalue()]), media_type="text/csv", headers=headers)


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
