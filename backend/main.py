import csv
import io
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, status
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
    with engine.begin() as connection:
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
    for item in fields:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip().lower()
        label = str(item.get("label", "")).strip()[:80]
        if not __import__("re").fullmatch(r"[a-z][a-z0-9_]{0,39}", key) or key in {"name", "roll_no", "course", "contact", "extra_data"} or not label:
            continue
        safe_fields.append({"key": key, "label": label, "type": item.get("type") if item.get("type") in ("text", "email", "tel", "number", "select") else "text", "required": bool(item.get("required", False)), "options": [str(x)[:100] for x in item.get("options", []) if str(x).strip()][:30]})
    result["custom_fields"] = safe_fields
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
    return {key: settings[key] for key in ("event_name", "organization_name", "event_date", "event_location", "event_description", "logo_url", "brand_color", "theme", "registration_open", "scanner_sound", "scanner_vibration", "course_options", "custom_fields")}

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
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> dict:
    if not file.filename.endswith(".csv"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only CSV files are supported.",
        )

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File encoding is not supported. Please save the CSV as UTF-8.",
        )

    reader = csv.DictReader(io.StringIO(text))
    required_columns = {"name", "roll_no", "course", "contact", "is_used", "created_at", "entry_at", "token"}
    actual_columns = set(reader.fieldnames or [])
    if not required_columns.issubset(actual_columns):
        missing = required_columns - actual_columns
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"CSV is missing columns: {', '.join(sorted(missing))}. "
                   f"Please use the file downloaded from the admin dashboard.",
        )

    def parse_dt(value: str):
        value = (value or "").strip()
        if not value:
            return None
        for fmt in ("%d/%m/%Y, %I:%M:%S %p", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                continue
        return None

    imported, skipped, errors = 0, 0, []

    for i, row in enumerate(reader, start=2):
        name = (row.get("name") or "").strip()
        roll_no = (row.get("roll_no") or "").strip()
        course = (row.get("course") or "").strip()
        contact = (row.get("contact") or "").strip()

        if not all([name, roll_no, course, contact]):
            errors.append(f"Row {i}: missing required field(s), skipped.")
            skipped += 1
            continue

        if db.execute(select(Student).where(Student.roll_no == roll_no)).scalar_one_or_none():
            errors.append(f"Row {i}: roll number '{roll_no}' already exists, skipped.")
            skipped += 1
            continue

        is_used = (row.get("is_used") or "").strip().lower() in ("true", "1", "yes")
        try:
            imported_extra_data = __import__("json").loads(row.get("extra_data") or "{}")
            if not isinstance(imported_extra_data, dict):
                imported_extra_data = {}
        except (ValueError, TypeError):
            imported_extra_data = {}
        created_at = parse_dt(row.get("created_at")) or datetime.now()
        entry_at = parse_dt(row.get("entry_at")) if is_used else None

        token = (row.get("token") or "").strip()
        if not token:
            token = generate_token()
            while db.execute(select(Student).where(Student.token == token)).scalar_one_or_none():
                token = generate_token()
        elif db.execute(select(Student).where(Student.token == token)).scalar_one_or_none():
            errors.append(f"Row {i}: token already exists for roll number '{roll_no}', skipped.")
            skipped += 1
            continue

        try:
            db.add(Student(
                name=name,
                roll_no=roll_no,
                course=course,
                contact=contact,
                token=token,
                is_used=is_used,
                created_at=created_at,
                entry_at=entry_at,
                extra_data=imported_extra_data,
            ))
            db.flush()
            imported += 1
        except IntegrityError:
            db.rollback()
            errors.append(f"Row {i}: duplicate entry for roll number '{roll_no}', skipped.")
            skipped += 1

    db.commit()

    return {"imported": imported, "skipped": skipped, "errors": errors}


@app.post("/register", response_model=RegisterStudentResponse, status_code=status.HTTP_201_CREATED)
def register_student(payload: RegisterStudentRequest, db: Session = Depends(get_db)) -> RegisterStudentResponse:
    settings = get_settings(db)
    if not settings.get("registration_open", True):
        raise HTTPException(status_code=403, detail="Registration is currently closed.")
    name = sanitize_input(payload.name, "Name")
    roll_no = sanitize_input(payload.roll_no, "Roll number")
    course = sanitize_input(payload.course, "Course")
    contact = sanitize_input(payload.contact, "Contact")
    if course not in settings.get("course_options", DEFAULT_SETTINGS["course_options"]):
        raise HTTPException(status_code=400, detail="Please select a valid course option.")
    extra_data = payload.extra_data or {}
    for field in settings.get("custom_fields", []):
        value = extra_data.get(field["key"], "")
        if field.get("required") and not str(value).strip():
            raise HTTPException(status_code=400, detail=f'{field["label"]} is required.')
        if field.get("type") == "select" and value and value not in field.get("options", []):
            raise HTTPException(status_code=400, detail=f'Invalid value for {field["label"]}.')

    if db.execute(select(Student).where(Student.roll_no == roll_no)).scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A student with this roll number is already registered.",
        )

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
