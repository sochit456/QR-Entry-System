# PROJECT_CONTEXT.md — QR-ENTRY-SYSTEM

> Technical knowledge base for humans and AI coding agents.
> **Basis:** static reading of every source file in the project archive (snapshot dated 2026-10-17).
> **Not verified by execution:** the app was **not run** (dependencies were not installed and there was no network). Anything about runtime behaviour is derived from reading code and is labelled **[UNVERIFIED]** where it matters.
> **Line numbers** (`L123`) are approximate, valid for this snapshot. Always `grep -n "<name>"` to confirm before editing. (After the 2026-11-03 `.env` fix, `backend/main.py` lost 2 lines near the top: its `L`-references below ~L41 are about 2 lower than listed.)

---

## 0. INSTRUCTIONS FOR AI CODING AGENTS (READ FIRST)

Follow this protocol on every task in this repository.

1. **Consult this file first.** Use §10 (Feature → files/functions), §6 (API), §7/§8 (function indexes) to locate the code. Do not scan the whole repo.
2. **Inspect only what is relevant.** Open the files/functions named for the feature, plus their direct dependencies (callers/callees listed in §9 data flows). Total source is small (~3,100 lines) but `frontend/script.js` (~1,500 lines) and `backend/main.py` (~835 lines) are large: read by function, not top to bottom.
3. **Check §14 (Known issues) and §15 (Unknowns)** before changing related behaviour. Do not "fix" an item there unless the task asks for it, but mention it if you touch the area.
4. **Plan before editing.** State: files to change, functions affected, API/DB/setting-schema impact, and whether frontend and backend must change together (see §11 "Coupling rules").
5. **Keep changes minimal and scoped.** Preserve existing behaviour that is not part of the request. Do not add dependencies without need.
6. **Validate after editing:** `python -m py_compile backend/*.py`, `node --check frontend/script.js`, and (when the environment allows) run the app and exercise the touched flow. No automated tests exist (§13).
7. **UPDATE THIS FILE AFTER EVERY CODE CHANGE.** In the same change set, update every affected section: file list (§3), API table (§6), function indexes (§7–§8), feature map (§10), env vars (§5), dependencies (§2), DB schema (§4), known issues (§14), and append a row to the **Change log (§17)**. If you remove code, add it to §16. If you discover something that contradicts this file, correct this file.
8. **Never invent.** If something is not in the code, write it as unknown in §15.
9. **Cache-busting:** HTML pages reference `/static/style.css?v=20261016-1` and `/static/script.js?v=20261016-1`. After changing `style.css` or `script.js`, bump the `v=` value in `index.html`, `register.html`, `scanner.html`, `admin.html`, `settings.html` (the version string is manually maintained; `404.html` uses unversioned URLs).
10. **Secrets:** never commit `.env`, passwords or `JWT_SECRET_KEY`.

---

## 1. PROJECT OVERVIEW

- **Name:** QR-ENTRY-SYSTEM (UI brand name defaults to "Entry Desk"; FastAPI title "College Event QR Entry System", version "1.0.0").
- **Purpose:** Event entry management. Attendees self-register on a public page and receive a unique single-use QR pass. Staff (password-protected) scan passes at the gate; each pass is valid once. Staff can also manage the guest list (manual check-in, undo, edit, delete, WhatsApp-share link, JSON backup/restore) and configure event details, branding, registration fields, and scanner feedback.
- **Architecture type:** single FastAPI process that serves both the JSON/HTML endpoints and the static frontend (same origin). No separate frontend build step.
- **Users:** (a) public attendees: Home, Register; (b) staff behind one shared admin password: Scanner, Dashboard, Settings.
- **Defaults in code:** event name "Annual College Fest 2026", organization "Your College Name" (placeholders; overridden by saved settings).

---

## 2. TECHNOLOGY STACK & DEPENDENCIES

**Backend:** Python, FastAPI, Uvicorn, SQLAlchemy 2.x ORM, PostgreSQL via `psycopg2`, Pydantic (via FastAPI), `python-jose` (JWT HS256), `qrcode[pil]` + Pillow (QR PNG), `python-dotenv` (called from `backend/__init__.py`), `python-multipart` (file upload form).
**Frontend:** plain HTML + CSS + vanilla JavaScript (no framework, no bundler, no npm). One shared script (`script.js`) with page switching via `<body data-page="…">`.
**External runtime resources (CDN):**
- `https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js` (scanner page only; `crossorigin="anonymous"`, no SRI hash).
- Google Fonts via `@import` in `style.css` (Bricolage Grotesque, Instrument Sans). System font fallbacks exist.

`requirements.txt` (verbatim intent; no lockfile):

| Package | Constraint | Used for (file) |
|---|---|---|
| fastapi | >=0.115.6,<1.0.0 | app, routing (`main.py`, `auth.py`) |
| uvicorn[standard] | >=0.30.0,<1.0.0 | ASGI server (run command, not imported) |
| SQLAlchemy | >=2.0.0,<3.0.0 | ORM/engine (`database.py`, `models.py`, `main.py`) |
| qrcode[pil] | >=7.4.2,<8.0.0 | QR generation (`utils.py`) |
| Pillow | >=10.3.0 | image backend for qrcode |
| psycopg2-binary | >=2.9.9,<3.0.0 | PostgreSQL driver (forced in `database.py`) |
| python-dotenv | >=1.0.0,<2.0.0 | `load_dotenv()` (`backend/__init__.py`) |
| python-multipart | >=0.0.20,<1.0.0 | `File`/`Form` in `/import-json` |
| python-jose[cryptography] | >=3.4.0,<4.0.0 | JWT (`auth.py`) |

Pydantic is **not pinned** (comes with FastAPI). `schemas.py` uses the v1-style `class Config: orm_mode = True` (see §14 I-15).
Python version: **not declared anywhere** [UNVERIFIED which versions work].

---

## 3. FOLDER STRUCTURE & FILE-BY-FILE

```
QR-ENTRY-SYSTEM/
├── PROJECT_CONTEXT.md        # this file
├── requirements.txt
├── .gitignore                # .env, __pycache__, venvs, *.db, *.sqlite3, build artefacts, OS files
├── backend/
│   ├── __init__.py           # docstring + load_dotenv() (runs before any backend submodule is imported)
│   ├── main.py               # app, routes, settings logic, validation, import/export, schema patching
│   ├── auth.py               # admin password check, JWT, bearer dependency, rate limiter, client IP
│   ├── database.py           # engine, SessionLocal, Base, get_db
│   ├── models.py             # Student, AppSettings
│   ├── schemas.py            # Pydantic request/response models
│   └── utils.py              # token generation/validation, QR PNG generation
└── frontend/                 # served at /static/* and via explicit page routes
    ├── index.html            # Home (marketing/landing, data-page="home")
    ├── register.html         # Public registration (data-page="registration")
    ├── scanner.html          # Staff QR scanner (data-page="scanner", protected)
    ├── admin.html            # Staff dashboard (data-page="admin", protected)
    ├── settings.html         # Staff settings (data-page="settings", protected)
    ├── 404.html              # Custom not-found page (data-page="notfound")
    ├── script.js             # ALL frontend logic
    ├── style.css             # ALL styling (light/dark via html[data-theme])
    └── logo.png              # 500×500 RGBA default logo (/static/logo.png)
```

**Not present in the archive:** README, `.env` / `.env.example`, tests, Dockerfile, Procfile, render.yaml or any deployment config, CI config, lockfile, migrations folder.

| File | Responsibility | Key dependents |
|---|---|---|
| `backend/main.py` | Creates `FastAPI` app; on import runs `validate_auth_config()` (`.env` was already loaded by `backend/__init__.py`), `Base.metadata.create_all`, `ensure_database_schema()`; defines settings defaults/validation, all routes, security middleware, CORS, 404 handler | imports auth, database, models, schemas, utils |
| `backend/__init__.py` | Loads `.env` via `load_dotenv()` (no override of existing env vars) before `database.py`/`auth.py`/`main.py` import | every `backend.*` import |
| `backend/auth.py` | `ADMIN_PASSWORD` compare, JWT create/verify, `require_admin` dependency, `AttemptLimiter`, `client_ip`, `login_limiter`, `register_limiter` | used by `main.py` |
| `backend/database.py` | Reads `DATABASE_URL` **at import**, rewrites to `postgresql+psycopg2://`, builds engine (`pool_pre_ping=True`), `SessionLocal`, `Base`, `get_db()` | `models.py`, `main.py` |
| `backend/models.py` | ORM tables `students`, `app_settings` | `main.py` |
| `backend/schemas.py` | Pydantic models for login, register, verify, entry actions, student output | `main.py` |
| `backend/utils.py` | `is_valid_token`, `generate_token`, `generate_qr_image` | `main.py` |
| `frontend/script.js` | Auth gate, config/theme, registration, scanner, dashboard, settings editor | all pages |
| `frontend/style.css` | Tokens, layout, components, responsive rules (mobile bottom tab bar ≤720px) | all pages |
| HTML pages | Markup + inline head bootstrap (see §9.1) + `<script src="/static/script.js?v=…">` | `script.js` finds elements by ID/data-attributes |

---

## 4. DATABASE

Engine: whatever `DATABASE_URL` points to. Code, `requirements.txt` and URL rewriting target **PostgreSQL**. `ensure_database_schema()` also contains SQLite branches (`DATETIME`, `'{}'`), and `.gitignore` ignores `*.db`; SQLite use is **[UNVERIFIED]**.

### Table `students` (model `Student`, `models.py`)
| Column | Type | Constraints | Notes |
|---|---|---|---|
| id | Integer | PK, indexed | |
| name | String(120) | NOT NULL | only built-in registration field |
| roll_no | String(50) | NOT NULL, indexed (non-unique) | **legacy**: always `""` for new registrations |
| course | String(120) | NOT NULL | **legacy**: always `""` |
| contact | String(50) | NOT NULL | **legacy**: always `""` |
| token | String(20) | UNIQUE, indexed, NOT NULL | the QR payload; 10–15 chars `A-Z0-9` when generated here |
| is_used | Boolean | NOT NULL, default False | true after check-in |
| created_at | DateTime (naive) | NOT NULL, default `datetime.now` | server local time |
| entry_at | DateTime (naive) | nullable | set at check-in (`datetime.now()`) |
| extra_data | JSON | NOT NULL, default `dict` | all custom-field values keyed by field `key` |

### Table `app_settings` (model `AppSettings`)
| Column | Type | Notes |
|---|---|---|
| id | Integer PK default 1 | singleton row, always `id=1` |
| config | JSON NOT NULL | settings object (see §5.2) |

### Schema management
- `Base.metadata.create_all` creates missing tables at import time of `main.py`.
- `ensure_database_schema()` (`main.py` L58) is a best-effort in-place patch run at every startup: drops a legacy **unique** `ix_students_roll_no` and recreates it non-unique; adds `entry_at` and `extra_data` columns if missing; backfills `extra_data` NULL → `{}`. No migration tool (no Alembic). Any other schema change must be added there or done manually.

### Settings JSON (`app_settings.config`) keys
`event_name`, `organization_name`, `event_date`, `event_location`, `event_description`, `logo_url`, `brand_color`, `theme` (`system|light|dark`), `registration_open`, `scanner_sound`, `scanner_vibration`, `custom_fields` (list), `search_field` (computed key string), plus **legacy** `course_options` (list) and `field_settings` (always `{}`), both unused by the frontend.

### Custom field object (validated by `clean_settings`, `main.py` L121)
`key` (first letter forced uppercase; regex `[A-Z][A-Za-z0-9_]{0,39}`; not `name`/`extra_data` case-insensitive; unique case-insensitively), `label` (≤80, required), `type` ∈ `text,email,tel,number,select,textarea,date,url,checkbox` (unknown → `text`), `required`, `unique`, `search`, `placeholder` (≤160), `help_text` (≤250), `options` (select only meaningful; ≤30 unique items, ≤100 chars each; select needs ≥1), `min_length` (0–500), `max_length` (1–5000, default 250; min≤max), `min`/`max` (floats or null; min≤max), `pattern` (≤200 chars, must compile as a regex), `width` ∈ `full,half,third`. Max 30 fields.
Search rules: if any custom fields exist, at least one must be `unique`; at most one may be `search`+`unique`; `search_field` = that key, else the first unique field; all other fields get `search=false`. No custom fields → `search_field=""`.

---

## 5. CONFIGURATION

### 5.1 Environment variables (all read in backend)
| Variable | Required | Read where / when | Behaviour |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | `database.py` at import | Missing → `RuntimeError`. `postgres://` and `postgresql://` rewritten to `postgresql+psycopg2://`. |
| `ADMIN_PASSWORD` | **Yes** | `auth.validate_auth_config()` at startup; `_get_admin_password()` on login | Shared staff password (plain text compare via `secrets.compare_digest`). |
| `JWT_SECRET_KEY` | **Yes** | startup + each token op | Must be ≥32 chars else `RuntimeError`. |
| `CORS_ALLOWED_ORIGINS` | No | `main.py` at import (`.env` already loaded) | Comma list; `*` is ignored; empty → no CORS middleware (same-origin only). |
| `TRUST_PROXY` | No | `auth.client_ip()` per request | `1/true/yes` → rightmost `X-Forwarded-For` entry is used as client IP (for rate limiting). Only use behind exactly one trusted proxy. |
| `REGISTER_RATE_LIMIT` | No | `auth.py` at import | Registrations per IP per 60 s, default 60; non-integer value crashes startup. |

`PORT`/host are **not** read by app code (supplied to uvicorn/host platform).

**`.env` loading (I-2, FIXED 2026-11-03 — see §19):** `.env` is now loaded by `load_dotenv()` in `backend/__init__.py`, which Python executes before any `backend.*` submodule, so `DATABASE_URL` (`database.py`) and `REGISTER_RATE_LIMIT` (`auth.py`) see `.env` values. Precedence: **real environment variables (shell / host platform / `uvicorn --env-file`) win over `.env`** (`override=False`); `.env` only fills variables that are not already set. Defaults are unchanged (`REGISTER_RATE_LIMIT` → 60 when unset or empty; `DATABASE_URL` still required). `.env` is searched upward from the `backend/` folder (python-dotenv `find_dotenv`), i.e. the project root `.env`, independent of the current working directory [verified in simulation only, §19]. `.env` is loaded once per process; `--reload` workers re-import it.

### 5.2 `.env` template (not in repo; create locally, never commit)
```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME
ADMIN_PASSWORD=choose-a-strong-password
JWT_SECRET_KEY=<random string of at least 32 chars>
# optional
CORS_ALLOWED_ORIGINS=
TRUST_PROXY=1
REGISTER_RATE_LIMIT=60
```
Generate a secret: `python -c "import secrets; print(secrets.token_urlsafe(48))"`.

### 5.3 Security-related built-ins
- JWT: HS256, `sub="admin"`, lifetime 8 h (`JWT_EXPIRES_MINUTES`), sent as `Authorization: Bearer`.
- Middleware (`security_middleware`, `main.py` ~L231): rejects POST/PUT/PATCH with `Content-Length` > `MAX_BODY_BYTES` (1,000,000) with 413; **`/import-json` only** uses `MAX_IMPORT_BODY_BYTES` (25 MiB + 1,000,000 envelope allowance) — I-1 fixed 2026-11-03. The handler additionally rejects files > `MAX_IMPORT_FILE_BYTES` (25 MiB) with 413; adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'`.
- Rate limits (in memory, per process): login 10 **failed** attempts / 300 s / IP (→429 + `Retry-After`); register `REGISTER_RATE_LIMIT` / 60 s / IP.

---

## 6. API REFERENCE (`backend/main.py`)

Auth column: **Public** = no auth; **Admin** = `Depends(require_admin)` (Bearer JWT).

| Method & Path | Auth | Handler (line) | Request | Success response | Errors / notes |
|---|---|---|---|---|---|
| GET `/` | Public | `serve_home` L251 | – | `index.html` | `Cache-Control: no-store` |
| GET `/register` | Public | `serve_registration` L256 | – | `register.html` | |
| GET `/scanner` | Public* | `serve_scanner` L261 | – | `scanner.html` | *page is public HTML; data calls need JWT |
| GET `/admin` | Public* | `serve_admin` L266 | – | `admin.html` | same |
| GET `/settings` | Public* | `serve_settings` L271 | – | `settings.html` | same |
| GET/HEAD `/health` | Public | `health_check` L276 | – | `{"status":"ok"}` | for uptime/health checks |
| GET `/public-config` | Public | `public_config` L282 | – | subset of settings: event_name, organization_name, event_date, event_location, event_description, logo_url, brand_color, theme, registration_open, scanner_sound, scanner_vibration, custom_fields, field_settings, search_field | |
| GET `/api/settings` | Admin | `read_settings` L287 | – | full settings dict | |
| PUT `/api/settings` | Admin | `update_settings` L291 | JSON object (unknown keys ignored) | cleaned settings saved to `app_settings` id=1 | 400 on validation (`clean_settings`) |
| POST `/login` | Public | `login` L303 | `{password}` | `{access_token, token_type:"bearer"}` | 401 wrong password; 429 too many failures; 500 if env missing |
| GET `/qr/{token}` | Public | `get_qr` L323 | path token | PNG stream (`Cache-Control: private, no-store`) | 404 (HTML, see I-4) if token fails `is_valid_token`. Does **not** check the token exists in DB. |
| POST `/register` | Public | `register_student` L331 → `_register_student` L346 | `{name, extra_data:{}}` (legacy `roll_no/course/contact` accepted but ignored) | 201 `{message, token, qr_code_url:"/qr/<token>"}` | 403 registration closed; 400 validation/duplicate; 429 rate limit |
| POST `/verify` | Admin | `verify_qr` L426 | `{token}` (1–20 chars) | `{status: VALID|INVALID|USED, message}` (HTTP 200 for all three) | Atomic `UPDATE … WHERE token=? AND is_used=false`; sets `entry_at=now()` |
| POST `/manual-entry/{student_id}` | Admin | `manual_entry` L460 | – | `{status: VALID|USED, message, entry_at}` | 404 |
| POST `/reset-entry/{student_id}` | Admin | `reset_entry` L496 | – | `{message, entry_at:null}` | 404 |
| GET `/students` | Admin | `get_students` L520 | – | list of student objects, newest first (includes `token`, `extra_data`) | no pagination |
| GET `/export-json` | Admin | `export_json_backup` L528 | – | download `qr_entry_system_backup.json` | format below |
| POST `/import-json` | Admin | `import_json_backup` L567 | multipart: `file` (.json), `mode` = `add`\|`replace` | `{message, imported, skipped, settings_imported}` | 400 invalid; 413 if body > ~26 MiB (middleware) or file > 25 MiB (handler) |
| PUT `/student/{student_id}` | Admin | `edit_student` L731 | `{name, extra_data}` | updated student | 400/404/500 |
| DELETE `/student/{student_id}` | Admin | `delete_student` L815 | – | `{message}` | 404/500 |
| GET `/static/*` | Public | `StaticFiles` mount L242 | – | everything in `frontend/` | |
| any 404 | – | `custom_404_handler` L246 | – | `404.html` (HTML, status 404) | also replaces JSON 404s from API handlers |

FastAPI's automatic `/docs`, `/redoc`, `/openapi.json` are not disabled in code [UNVERIFIED at runtime]; routes marked `include_in_schema=False` (page routes) are hidden from them.

**Backup file format** (`/export-json`): `{"format":"qr-entry-system-backup","version":1,"exported_at":ISO,"data":{"students":[{id,name,roll_no,course,contact,token,is_used,created_at,entry_at,extra_data}],"app_settings":{…}}}`.
**Import accepts:** that format (version must be 1), or `{"students":[…]}`/`{"data":[…]}` (+optional `app_settings`), or a bare array. Per record: `name` required (≤120); extra top-level keys are folded into `extra_data`; missing `token` → generated; invalid/duplicate token → 400; `is_used` strings `true/1/yes/used`; `used` without `entry_at` → `entry_at=created_at`; unused → `entry_at=None`. **ADD**: skips tokens already in DB, drops `id`, keeps current settings. **REPLACE**: deletes all students, inserts file records (with their `id`s), overwrites settings if present.

**Pydantic models** (`schemas.py`): `LoginRequest{password}`, `LoginResponse{access_token,token_type}`, `RegisterStudentRequest{name(1–120),roll_no,course,contact,extra_data}`, `RegisterStudentResponse{message,token,qr_code_url}`, `VerifyQRRequest{token(1–20)}`, `VerifyQRResponse{status,message}`, `EntryActionResponse{status,message,entry_at}`, `ResetEntryResponse{message,entry_at}`, `StudentResponse{id,name,roll_no,course,contact,token,is_used,created_at,entry_at,extra_data}`.

---

## 7. BACKEND FUNCTION INDEX

| Function / object | File:line | Purpose | Called by / uses |
|---|---|---|---|
| `sanitize_input(value, field_name)` | main.py L48 | strip + reject empty (400) | `_register_student`, `verify_qr` |
| `ensure_database_schema()` | main.py L58 | startup schema patch (§4) | module import |
| `DEFAULT_SETTINGS` | main.py L91 | settings defaults | `get_settings`, `clean_settings` |
| `get_settings(db)` | main.py L108 | load row id=1 (create if missing), merge over defaults, force `field_settings={}`, ensure `search_field` | `public_config`, `read_settings`, `_register_student`, `edit_student`, export |
| `clean_settings(payload)` | main.py L121 | validate/normalise all settings incl. custom fields, logo URL rule (local `/path` or http(s) URL), hex colour, search-field rules | `update_settings` |
| `security_middleware` | main.py ~L231 | body-size guard (1 MB default, larger cap for `/import-json` only) + security headers | every request |
| `custom_404_handler` | main.py L246 | serves `404.html` | all 404s |
| `register_student` / `_register_student` | main.py L331 / L346 | rate limit + process-wide `_register_lock`; validate against `custom_fields`; generate unique token; insert | `/register` |
| `verify_qr` | main.py L426 | atomic check-in by token | `/verify` |
| `manual_entry`, `reset_entry` | main.py L460 / L496 | set / clear `is_used`, `entry_at` | dashboard |
| `edit_student` | main.py L731 | merge+validate `extra_data`, update name | dashboard Edit modal |
| `delete_student` | main.py L815 | delete row | dashboard |
| `export_json_backup`, `import_json_backup` | main.py L528 / L567 | backup/restore | dashboard Export/Import |
| `validate_auth_config()` | auth.py L40 | fail-fast on missing/weak secrets | main.py startup |
| `verify_admin_password(pw)` | auth.py L51 | constant-time compare (bytes) | `login` |
| `create_access_token()` | auth.py L59 | JWT (8 h) | `login` |
| `require_admin` | auth.py L69 | Bearer dependency; 401 on missing/invalid/expired | all Admin routes |
| `client_ip(request)` | auth.py L102 | IP for limiter (`TRUST_PROXY`) | `login`, `register_student` |
| `AttemptLimiter` (`blocked_for`, `record`, `hit`, `clear`) | auth.py L118 | sliding-window limiter, max 10,000 keys, thread-locked | `login_limiter` L173, `register_limiter` L175 |
| `get_db()` | database.py L29 | request-scoped session dependency | all DB routes |
| `is_valid_token(t)` | utils.py L13 | regex `[A-Za-z0-9_-]{1,20}` | `get_qr`, `verify_qr`, import |
| `generate_token(min=10,max=15)` | utils.py L17 | `secrets`-based `A-Z0-9` token | register, import |
| `generate_qr_image(token)` | utils.py L22 | PNG BytesIO (version 1 fit, ECC-M, box 10, border 4) encoding the raw token | `get_qr` |

**Validation order in `_register_student`:** registration_open → name → keep only configured keys → per field: required → (checkbox handling) → empty skip → length → pattern → email regex → select membership → number (+min/max) → unique (case-insensitive, scans all students) → store as string.

---

## 8. FRONTEND FUNCTION INDEX (`frontend/script.js`)

**Globals:** `page` (= `body.dataset.page`), `JWT_STORAGE_KEY="jwt"` (sessionStorage), `appConfig` (public config), `settingsInitialSnapshot`/`settingsIsDirty`, `adminSearchField`/`adminFieldLabels`/`adminFields`, `CAMERA_STATUS_CLASS_MAP`, `THEME_STORAGE_KEY="theme"` (localStorage).
**localStorage key** `entryDeskPublicConfig` caches `/public-config`.

| Function | Line | Purpose |
|---|---|---|
| `getAuthToken/clearAuthToken` | L12/L16 | sessionStorage JWT access |
| `decodeJwtPayload`, `isTokenExpired` | L20/L31 | client-side exp check (no signature check) |
| `wasPageRefreshed` | L37 | detects reload → shows "Welcome back" modal |
| `authFetch(url, opts)` | L45 | adds Bearer; on 401 clears token and reloads page |
| `setMessage`, `escapeHtml`, `setButtonLoading`, `parseJsonResponse`, `formatDate`, `buildStudentQrUrl` | L59–L105 | UI/format helpers (`parseJsonResponse` throws `Error(detail)`) |
| `playToneSequence`, `vibratePattern`, `playScannerFeedback(status)` | L131/L165/L171 | scan sound/vibration per VALID/USED/other, honoring `appConfig.scanner_sound/vibration` |
| `enableSessionLockButtons` | L199 | `[data-lock-session]` buttons clear token + reload |
| `showSessionContinueModal` | L212 | Continue / Log out after refresh |
| `addPasswordToggle` | L242 | Show/Hide on password field |
| `protectPage(onAuthorized)` | L263 | login overlay, token check, POST `/login`, runs page init once authorized |
| `loadPublicConfig` | L362 | apply cached config, fetch `/public-config`, cache, `applyAppConfig` |
| `applyBrandColor(color)` | L402 | sets `--brand`, `--on-brand` by luminance |
| `applyAppConfig()` | L414 | brand, theme, logo, titles; registration heading/meta; closed-registration lock; scanner heading |
| `renderCustomRegistrationFields(fields)` | L473 | builds inputs (`name="custom_<Key>"`, `data-custom-key`) before submit button |
| `customFieldEditorRow(field)` | L513 | one custom-field editor card in Settings |
| `settingsSnapshot`, `markSettingsDirty`, `updateCustomFieldCount`, `updateSettingsPreview`, `populateSettingsForm` | L552–L613 | Settings form state/dirty tracking/live preview |
| `initSettingsAccordion` | L629 | single-open section accordion |
| `initSettingsPage` | L656 | load `/api/settings`, add/discard/save (PUT) with client validation |
| `initRegistrationPage` | L741 | submit → POST `/register`; shows ticket QR; download link |
| `setCameraCardStatus`, `setScanStatus` | L825/L838 | scanner status UI |
| `initScannerPage` | L851 | html5-qrcode start/switch camera; inner `verifyToken` L874 (POST `/verify`), `startScanner` L916, `waitForScannerLibrary` L960 |
| `studentFieldValue`, `renderStudents`, `updateAdminStats`, `setActiveFilterButton` | L1004–L1065 | dashboard table (dynamic columns), stats |
| `initAdminPage` | L1071 | builds Edit modal; inner `openEditEntry` L1097, `closeEditEntry` L1128, `loadStudents` L1164, `updateStudentState` L1191; table click handler (WhatsApp share / Edit / Enter / Undo / Delete); import (prompt A/R/C) and export handlers |
| `getSystemTheme`, `applyTheme`, `loadTheme`, `listenForSystemTheme` | L1463–L1487 | theme resolution (`html[data-theme]`) |
| bootstrap `DOMContentLoaded` listener | ~L1430 | `enableSessionLockButtons()`, `await loadPublicConfig()`, dispatch by `page` (registration → `initRegistrationPage`; scanner/admin/settings → `protectPage(init…)`; home/notfound → nothing more) |

---

## 9. ARCHITECTURE & DATA FLOW

### 9.1 Page bootstrap (all pages except 404)
1. Inline `<script>` in `<head>` (duplicated in index/register/scanner/admin/settings): reads `localStorage.entryDeskPublicConfig`, sets `data-theme` and `--brand`, and on `DOMContentLoaded` writes cached event name/org/logo into `.brand-name`, `.ticket-head`, `<title>` to avoid flicker. `404.html` has a smaller inline script (theme only).
2. `script.js` (end of body): `loadTheme()` + `listenForSystemTheme()` run immediately; on DOMContentLoaded `loadPublicConfig()` then page init.

### 9.2 Authentication flow
`protectPage` → if valid unexpired `sessionStorage.jwt`: show page (if the navigation was a reload, show "Welcome back" modal first) else show login overlay → `POST /login` → store `access_token` → page init. All staff calls use `authFetch`; a 401 clears the token and reloads. Any failed login response (incl. 429/500) shows "That password isn't right. Try again." Lock buttons clear the token.

### 9.3 Registration flow
`register.html` form (`name` + dynamic custom inputs) → `initRegistrationPage` builds `{name, extra_data}` (checkbox → boolean, others → string) → `POST /register` → `_register_student` (validations, token, insert) → response `{token, qr_code_url}` → ticket shows `<img src="/qr/<token>">`, token text, download link (`<token>.png`) → `GET /qr/{token}` → `generate_qr_image`. Typing again after issue resets the ticket.

### 9.4 Scan flow
`scanner.html` → `protectPage(initScannerPage)` → wait for `Html5Qrcode` (CDN) → camera (`environment`, fallback `user`) → decoded text → `verifyToken` (ignores repeats: lock 1.8 s, same-token guard 1.6 s) → `POST /verify` → status `VALID|USED|INVALID` → `playScannerFeedback` + `setScanStatus`.

### 9.5 Dashboard flow
`initAdminPage` → `loadStudents`: parallel `GET /students` (auth) + `GET /public-config` → `adminFields`, `adminSearchField` → `renderStudents` builds columns: Name + configured fields + any extra keys found in data (e.g. imported) + Status/QR/Registered/Entered/Actions. Actions: Enter (`/manual-entry/{id}`), Undo (`/reset-entry/{id}`, confirm), Edit (`PUT /student/{id}`), WhatsApp (opens `https://wa.me/<phone>?text=…` with absolute `/qr/<token>` link), Delete (confirm; `DELETE /student/{id}`), Export (`GET /export-json` → blob download), Import (`window.prompt` A/R/C → `POST /import-json`).

### 9.6 Settings flow
`initSettingsPage` → `GET /api/settings` → `populateSettingsForm` → user edits (dirty tracking, live theme/brand preview) → client checks (label/key, duplicate keys, dropdown options, one search field, ≥1 unique) → `PUT /api/settings` → backend `clean_settings` → response replaces `appConfig` → `applyAppConfig`. Other devices pick up changes on next `/public-config` fetch.

### 9.7 Coupling rules (change both sides together)
- Adding/changing a **setting key**: `DEFAULT_SETTINGS` + `clean_settings` + `public_config` key tuple (if public) in `main.py`; `settingsSnapshot` / `populateSettingsForm` / `settings.html` control (`name=` equals key) in frontend.
- Changing **custom field properties**: `clean_settings` (backend schema), `_register_student` and `edit_student` (validation), `customFieldEditorRow` + `settingsSnapshot` (editor), `renderCustomRegistrationFields` (register form), `openEditEntry` (edit modal).
- Changing **student output fields**: `StudentResponse`, `models.Student`, `ensure_database_schema`, export/import, `renderStudents`.
- Changing **token format**: `utils.generate_token`, `utils.is_valid_token`, `VerifyQRRequest.max_length`, `Student.token` length (20).

---

## 10. FEATURE → FILES / FUNCTIONS MAP

| Feature / task | Backend | Frontend |
|---|---|---|
| Staff login / session | `auth.py` (all), `main.login` | `protectPage`, `authFetch`, `showSessionContinueModal`, `enableSessionLockButtons`, login overlay in scanner/admin/settings `.html` |
| Rate limiting | `auth.AttemptLimiter`, `login_limiter`, `register_limiter`, `client_ip` | – |
| Public registration | `main.register_student/_register_student`, `schemas.RegisterStudentRequest/Response` | `register.html`, `initRegistrationPage`, `renderCustomRegistrationFields` |
| Custom registration fields (definition) | `main.clean_settings` | `settings.html`, `customFieldEditorRow`, `settingsSnapshot`, `initSettingsPage` |
| Unique / searchable field | `clean_settings`, `_register_student`, `edit_student` | `renderStudents`, `studentFieldValue`, `loadStudents` (`adminSearchField`) |
| QR generation / download | `utils.generate_qr_image`, `main.get_qr` | `initRegistrationPage` (ticket, download link), `buildStudentQrUrl` |
| Scanning & verification | `main.verify_qr` | `scanner.html`, `initScannerPage`, `setScanStatus`, `playScannerFeedback` |
| Manual check-in / undo | `main.manual_entry`, `main.reset_entry` | `initAdminPage` table handler |
| Edit / delete entry | `main.edit_student`, `main.delete_student` | `openEditEntry`, edit form submit, delete handler |
| Dashboard table, stats, search, filters | `main.get_students` | `renderStudents`, `updateAdminStats`, `setActiveFilterButton`, `loadStudents` |
| WhatsApp share | – | share branch in `initAdminPage` click handler (phone detection + `wa.me`) |
| JSON backup / restore | `export_json_backup`, `import_json_backup` | `initAdminPage` import/export handlers; buttons in `admin.html` |
| Event settings (name, date, location, description, logo) | `get_settings`, `clean_settings`, `/api/settings`, `/public-config` | `settings.html`, `initSettingsPage`, `applyAppConfig`, `loadPublicConfig` |
| Branding colour | `clean_settings` (hex) | `applyBrandColor`, `style.css` `--brand*`, head bootstrap scripts |
| Theme light/dark/system | `clean_settings` (`theme`) | `applyTheme`, `loadTheme`, `listenForSystemTheme`, `style.css` `html[data-theme="dark"]` |
| Open/close registration | `DEFAULT_SETTINGS.registration_open`, `_register_student` (403) | `applyAppConfig` (disables form) |
| Scanner sound/vibration | `scanner_sound/vibration` settings | `playScannerFeedback` |
| Security headers / body limit / CORS | `security_middleware`, CORS block in `main.py` | – |
| Static pages & 404 | page routes, `custom_404_handler`, `/static` mount | `404.html`, `index.html` |
| Schema evolution | `ensure_database_schema`, `models.py` | – |
| Look & feel / responsive | – | `style.css` (sections: tokens, base, app bar, buttons/fields, lock screen, registration/ticket, scanner, dashboard, settings, home, not-found, responsive @media) |
| Navigation bar | – | duplicated `<nav class="app-nav">` in every HTML page (edit all six) |

---

## 11. FRONTEND PAGE → DOM IDs (what `script.js` looks up)

- **All protected pages:** `#loginOverlay`, `#authForm`, `#authPassword`, `#authError`, `#mainContent`, `[data-lock-session]`.
- **register.html:** `#registrationForm` (input `name="name"`), `#registrationSubmit`, `#registrationMessage`, `#registrationResult` (`data-state` empty/issued), `#qrImage`, `#ticketName`, `#resultToken`, `#downloadQrButton`.
- **scanner.html:** `#cameraPill`, `#switchCameraButton`, `#scannerViewport`, `#scannerHint`, `#scanStatus`, `#scanTitle`, `#scanMessage`, `.scanner-panel`.
- **admin.html:** `#importJsonInput`, `#importJsonButton`, `#downloadJsonButton`, `#refreshStudents`, `#statTotal/#statUsed/#statRemaining/#statPercent/#statProgress`, `#searchRoll`, `.filter-chip[data-filter]`, `#adminMessage`, `#studentsTableHead`, `#studentsTableBody`. Edit modal (`#editEntryOverlay` etc.) is created by JS.
- **settings.html:** `#settingsForm` (controls named `event_name, organization_name, event_date, event_location, event_description, logo_url, theme, brand_color, registration_open, scanner_sound, scanner_vibration`), `#customFieldsEditor`, `#addCustomField`, `#customFieldCount`, `#discardSettingsButton`, `#saveSettingsButton`, `#settingsMessage`, `#settingsDirtyLabel`, `#saveBarTitle`, `#saveBarHint`, `#brandColorValue`, summary IDs `#summaryEventName/#summaryEventMeta/#summaryRegistration/#summaryFields/#summarySound/#summaryVibration`.

---

## 12. LOCAL SETUP, RUN, TEST, DEPLOYMENT

> Commands below are derived from the code; **none were executed** during analysis.

### Local setup
```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# create a PostgreSQL database, then create .env (§5.2)
```
### Run (from the project root — imports are `backend.*`, and `BASE_DIR` is the parent of `backend/`)
```bash
uvicorn backend.main:app --reload --env-file .env
```
(`--env-file` is optional now: `.env` is loaded automatically by `backend/__init__.py`; if both are used, variables from `--env-file`/the shell take precedence over `.env`. See §5.1.) Then open `http://127.0.0.1:8000/`. Camera access works on `localhost` or HTTPS only (browser rule).

### Tests
**None exist.** Suggested manual smoke test after any change: (1) `/health` → ok; (2) register a guest on `/register`, download QR; (3) log in on `/scanner`, scan once → "Entry allowed", again → "Already used"; (4) `/admin` shows guest, Undo/Enter/Edit/Delete work; (5) Export then Import (Add) a small file; (6) `/settings` save a change and confirm `/register` reflects it.

### Production / hosting
- **No deployment files are in the repo; the hosting platform is unknown.** Hints only: `auth.client_ip` docstring mentions Render as an example proxy; `/health` supports HEAD; `postgres://` URLs are rewritten (Heroku/Render style).
- Needed: Python runtime, `pip install -r requirements.txt`, PostgreSQL, env vars from §5.1, start command run from project root, e.g. `uvicorn backend.main:app --host 0.0.0.0 --port $PORT` [inferred, not from repo]. Health check path: `/health`.
- Serve over HTTPS (camera needs a secure context). Set `TRUST_PROXY=1` only behind one trusted reverse proxy.
- **Single worker recommended:** the register lock (`_register_lock`) and both rate limiters are per-process (I-7).
- The database is not auto-backed-up by the app; use the dashboard Export and/or provider backups.

---

## 13. TROUBLESHOOTING

| Symptom | Likely cause / action |
|---|---|
| Startup `DATABASE_URL environment variable is not set.` | Not set in the host/shell environment **and** not in the project-root `.env` (or the `.env` line is empty/misspelled). Since 2026-11-03 `.env` is read automatically (I-2 fixed). Note: a variable already set in the shell/host (even to an empty string) is **not** overridden by `.env`. |
| Startup `ADMIN_PASSWORD environment variable is not set.` / `JWT_SECRET_KEY must be set … at least 32 characters` | Set in `.env`/host env (§5). |
| Startup `ValueError` near `REGISTER_RATE_LIMIT` | Value is not an integer (an empty value falls back to 60). |
| DB driver errors | Ensure `psycopg2-binary` installed and URL is PostgreSQL; code forces `postgresql+psycopg2`. |
| Login always "isn't right" | Wrong `ADMIN_PASSWORD`; also shown for 429/500 (I-11). After 10 failures wait up to 5 min (per IP). |
| Constantly returned to login | JWT expired (8 h), `JWT_SECRET_KEY` changed/restarted with a different value, or sessionStorage cleared; any 401 clears the token. |
| Behind a proxy, everyone rate-limited together | Proxy IP is used; set `TRUST_PROXY=1` (single trusted proxy). |
| Import fails with "Request body too large" | Request body > ~26 MiB (middleware cap for `/import-json`). Files 25 MiB–~26 MiB get "JSON files must be smaller than 25 MB." from the handler. (Before 2026-11-03 the cap was 1 MB, I-1.) |
| Scanner stuck on "Starting camera" | `html5-qrcode` CDN blocked/offline (poll loop has no timeout, I-12) or camera permission denied / non-HTTPS. |
| API call returns generic "Something went wrong" on a missing record | API 404s are returned as HTML by the custom 404 handler (I-4). |
| "no valid phone number to share to" | See WhatsApp regex bug (I-3) — numbers containing spaces, `+`, `-` fail. |
| Times look shifted by hours | Naive server-local timestamps interpreted as UTC by `formatDate` (I-6). |
| CSS/JS changes not appearing | Bump `?v=` in the HTML files (§0 rule 9) / hard refresh. |
| Settings save rejected: "Mark at least one custom field as unique…" | Backend rule: if custom fields exist, one must be unique (it becomes the search field). |
| Registration page shows fields wrongly right after saving settings | Public config is cached in `localStorage.entryDeskPublicConfig` and refreshed on each load. |

---

## 14. KNOWN ISSUES / RISKS (found by reading code; none fixed unless stated)

| ID | Issue | Where |
|---|---|---|
| I-1 | **FIXED 2026-11-03** — see §18. Middleware exempted `"/import"` instead of `/import-json`, so imports were capped at ~1 MB. Remaining limitation: the cap relies on the `Content-Length` header; requests without it (chunked) are not size-checked by the middleware (pre-existing, applies to all routes). | `main.py` L225–L237 |
| I-2 | **FIXED 2026-11-03** — see §19. `load_dotenv()` ran after `backend.database`/`backend.auth` were imported, so `DATABASE_URL` and `REGISTER_RATE_LIMIT` ignored `.env`. Now loaded in `backend/__init__.py`. Remaining limitation: verified only with stubbed dependencies, not by starting the real app. | `backend/__init__.py`, formerly `main.py` L41 |
| I-3 | WhatsApp phone cleanup regex is `/\\D/g` (matches a literal backslash + `D`), so non-digits are **not** stripped; only plain digit strings work. Also hard-codes India country code `91` for 10-digit numbers. | `script.js` ~L1222 (`rawPhone … .replace`) |
| I-4 | `@app.exception_handler(404)` returns the HTML 404 page for **all** 404s, including API `HTTPException(404)` (`/qr/<bad>`, student not found). | `main.py` L246 |
| I-5 | Import REPLACE writes `app_settings` from the file **without** `clean_settings`; explicit `id`s from the file are inserted, which on PostgreSQL does not advance the id sequence (possible later duplicate-key errors) [UNVERIFIED]. ADD mode does not enforce custom-field uniqueness. | `import_json_backup` |
| I-6 | `created_at`/`entry_at` are naive server-local times; frontend `formatDate` appends `Z` (treats as UTC). Correct only if the server runs in UTC. | `models.py`, `main.py`, `script.js` L105 |
| I-7 | Register lock and rate limiters are in-process; multiple workers/instances lose guarantees (duplicate unique values possible; limits multiply). | `main.py` L46, `auth.py` |
| I-8 | `_register_student` and `edit_student` load all students to check uniqueness (O(n) per request); `/students` has no pagination. | `main.py` |
| I-9 | Theme: nothing writes `localStorage.theme` any more; `loadTheme()` applies "system" first, then `applyAppConfig` applies the saved theme (possible brief flash). The OS-change listener re-applies "system" even if the configured theme is light/dark. | `script.js` L1463–L1511 |
| I-10 | Dashboard buttons are labelled "Import"/"Export" in HTML but JS resets them to "Import JSON"/"Export JSON" after first use. | `admin.html`, `initAdminPage` |
| I-11 | Login UI shows the same error for any failure (wrong password, rate-limit, server misconfig). | `protectPage` |
| I-12 | External dependencies without fallback: unpkg `html5-qrcode` (no SRI; `waitForScannerLibrary` retries forever, no user message) and Google Fonts `@import`. | `scanner.html`, `script.js` L960, `style.css` L1 |
| I-13 | Legacy leftovers kept for compatibility: columns `roll_no/course/contact`; `RegisterStudentRequest.roll_no/course/contact` (ignored); settings keys `course_options`, `field_settings`; unused `coreSettings` parameter and `isCore` branches in `renderCustomRegistrationFields`; error message "roll number or token already exists" in `_register_student`. | various |
| I-14 | Single shared plaintext env password; JWT in `sessionStorage` (readable by any XSS); no server-side logout/revocation; `/students` and the share button expose raw tokens to staff. | `auth.py`, `script.js` |
| I-15 | `class Config: orm_mode = True` is Pydantic v1 syntax; Pydantic v2 (what current FastAPI installs) warns and maps it [UNVERIFIED]; Pydantic not pinned. | `schemas.py` L62 |
| I-16 | Dashboard load-error row uses fixed `colspan="7"` (table is dynamic). Registration closed state disables `input, select, button` but not `textarea`. | `script.js` |
| I-17 | CSP header is minimal (inline scripts are used by pages, so a strict script CSP would require refactoring). `/docs`, `/redoc` likely public. | `main.py` L238 |
| I-18 | Style debt in `main.py`: function-local `import re/json`, `__import__("re")`, `__import__("json")`, `__import__("sqlalchemy")`, one-line `try:/except` statements. Works; avoid copying the pattern. | `main.py` |
| I-19 | `/qr/{token}` is public and does not check DB existence; anyone who knows a token can render its QR. Tokens are random 10–15 chars. | `get_qr` |
| I-20 | No tests, no lockfile, no README/.env.example, no deployment config, no migrations tool. | repo |

---

## 15. UNKNOWNS / UNVERIFIED

- Whether the app starts and every flow works (never executed; the 2026-11-03 fixes were also not run against the real app — see §18 and §19).
- Python version(s) supported; resolved Pydantic/FastAPI/SQLAlchemy versions in use.
- Hosting provider, start command, number of workers, domain/HTTPS setup, DB provider and backup policy.
- Whether SQLite works (code has branches; no evidence of use).
- Exact contents of the inline head-bootstrap script in `admin.html`/`settings.html` (same signature as other pages — it references `entryDeskPublicConfig` — but not compared line by line).
- Visual/responsive correctness of `style.css` (not rendered); it was only checked for brace balance and unused class names.
- Any real data, data volume, or expected concurrent users.

---

## 16. REMOVED CODE LOG (dead code removed during documentation, 2026-10-17)

Each item had zero references (checked by search) or targeted DOM elements that do not exist. After removal: `python -m py_compile backend/*.py` and `node --check frontend/script.js` pass; CSS braces balanced. App not run.

| File | Removed |
|---|---|
| `backend/main.py` | unused import `from zoneinfo import ZoneInfo` |
| `backend/models.py` | unused import `Text` |
| `backend/utils.py` | unused function `safe_filename()` |
| `frontend/register.html` | empty `<div id="ticketDynamicFields">` (never referenced) |
| `frontend/script.js` | `safeFileName()`; unused var `existingName`; `CORE_FIELD_DEFAULTS` + `coreFieldEditorRow()` (never called); a no-op lookup of non-existent `#coreFieldSettingsEditor` inside `customFieldEditorRow`; in `updateSettingsPreview`: lookups/logic for non-existent `#previewEventName`, `#previewOrganization`, `#previewBrandMark`, `#brandPreview` and the then-unused `organization` const; `course_options` branch in `populateSettingsForm` (no such form control); `setTheme()` and `initThemeSelector()` (+ its `DOMContentLoaded` listener) — they targeted `#themeSelect`, which does not exist (the Settings theme control is `<select name="theme">`); theme-section comment adjusted |
| `frontend/style.css` | 9 rules with no matching markup: `.brand-preview`, `.preview-brand-mark` (+`img`), `.preview-brand-copy` (+`strong`,`span`), `.preview-button`, and their two mobile overrides |

Deliberately **kept** (behaviour/compatibility, see I-13): legacy DB columns, legacy settings keys, ignored legacy request fields.

---

## 17. CHANGE LOG (append a row for every change)

| Date | Change | Files | Sections of this doc updated |
|---|---|---|---|
| 2026-10-17 | Initial creation of PROJECT_CONTEXT.md from full static analysis; removed verified dead code (§16) | PROJECT_CONTEXT.md, backend/main.py, backend/models.py, backend/utils.py, frontend/register.html, frontend/script.js, frontend/style.css | all |
| 2026-11-03 | Fixed JSON import size-limit route mismatch (I-1), §18 | backend/main.py, PROJECT_CONTEXT.md | §5.3, §6, §7, §13, §14, §15, §17, §18 |
| 2026-11-03 | Fixed `.env` loading order (I-2), §19: `load_dotenv()` moved from `main.py` to `backend/__init__.py` | backend/__init__.py, backend/main.py, PROJECT_CONTEXT.md | header note, §2, §3, §5.1, §12, §13, §14, §15, §17, §19 |

---

## 18. BUG FIX RECORD — JSON import size limit (2026-11-03)

**Bug (I-1):** JSON imports were meant to support up to 25 MB, but any import over ~1 MB failed with `413 Request body too large.`

**Root cause:** `security_middleware` skipped the 1 MB `Content-Length` check only for `request.url.path != "/import"`. The real route is `/import-json`, so it never matched the exemption and the 1,000,000-byte cap applied. The handler's own 25 MB check was therefore unreachable for files > 1 MB.

**Fix (`backend/main.py` only):**
- Added constants `IMPORT_JSON_PATH = "/import-json"`, `MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024`, `MAX_IMPORT_BODY_BYTES = MAX_IMPORT_FILE_BYTES + MAX_BODY_BYTES`.
- Middleware now selects a limit per request: `MAX_IMPORT_BODY_BYTES` for `/import-json`, `MAX_BODY_BYTES` (1,000,000) for **every other** POST/PUT/PATCH. The check is not removed for the import route; it is a higher cap (25 MiB + 1 MB multipart-envelope allowance), so absurdly large bodies are still rejected early.
- The handler's file-size check now uses `MAX_IMPORT_FILE_BYTES` (same value, 25 MiB, same 413 message). All other import validation is unchanged.
- No DB, schema, frontend, or other endpoint changes.

**Tests performed:**

| Test | Result |
|---|---|
| `python -m py_compile backend/*.py` | PASSED |
| Logic simulation: constants extracted from the real source and the limit-selection expression evaluated for sample sizes/paths (`/import-json` 10 KB, 5 MB, 25 MiB+500 B pass middleware; 30 MB rejected; `/import` 5 MB, `/register` 1,000,001 B, `/login` 2 MB, `/api/settings` 1,000,001 B, `/verify` 2 MB rejected; `/register` 999,999 B passes) | PASSED — **this is not an HTTP test** |
| Import small JSON file via running app | **NOT TESTED** (dependencies could not be installed: no network; no PostgreSQL) |
| Import JSON > 1 MB and < 25 MB via running app | **NOT TESTED** |
| Import JSON > 25 MB via running app (expect 413) | **NOT TESTED** |
| Other endpoints still return 413 above 1 MB via running app | **NOT TESTED** (only the logic simulation above) |

**Remaining limitations:**
- Middleware relies on the `Content-Length` header; chunked requests without it are not size-checked there (pre-existing, all routes). For `/import-json` the handler check still applies, but only after the body has been read (`await file.read()`).
- `/import-json` accepts the larger body before `require_admin` runs (FastAPI parses the multipart body in the same step as dependencies), so an unauthenticated client can send up to ~26 MiB to this one route. Previously capped at 1 MB. Consider a reverse-proxy limit or auth check in middleware if this matters.
- A file between 25 MiB and ~26 MiB passes the middleware and is rejected by the handler (still 413). Whole file is held in memory and parsed (`json.loads`), so ~25 MB imports use noticeably more RAM on small hosts.
- Hosting-platform/proxy body limits (e.g. nginx default 1 MB) are outside the app and may still block large uploads [UNVERIFIED].
- To verify: run the app (§12) and POST files of ~10 KB, ~5 MB, ~26 MB to `/import-json` with a valid Bearer token; confirm 200, 200, 413, and that e.g. a >1 MB POST to `/register` returns 413.

---

## 19. BUG FIX RECORD — `.env` loading order (2026-11-03)

**Bug (I-2):** values for `DATABASE_URL` and `REGISTER_RATE_LIMIT` placed only in `.env` were ignored (a missing `DATABASE_URL` aborted startup with `RuntimeError`; `REGISTER_RATE_LIMIT` silently stayed at the default 60).

**Root cause:** `backend/main.py` imported `backend.auth` and `backend.database` at the top and only called `load_dotenv()` afterwards. Both modules read the environment at **import time** (`database.py`: `DATABASE_URL = os.getenv(...)`; `auth.py`: `register_limiter = AttemptLimiter(limit=int(os.getenv("REGISTER_RATE_LIMIT", "60") ...))`), so `.env` was not loaded yet. Other variables (`ADMIN_PASSWORD`, `JWT_SECRET_KEY`, `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY`) happened to work because they are read later or after `load_dotenv()`.

**Fix:**
- `backend/__init__.py`: now calls `load_dotenv()` (default arguments). A package `__init__` executes before any `backend.*` submodule, so `.env` is loaded first regardless of import order or entry point (`uvicorn backend.main:app`, tests, scripts importing `backend.database`).
- `backend/main.py`: removed `from dotenv import load_dotenv` and the old `load_dotenv()` call (single load point, no duplicate logic). Nothing else changed; `validate_auth_config()` still runs at the same place.
- `database.py` and `auth.py` were **not** modified; defaults (`REGISTER_RATE_LIMIT` = 60, `DATABASE_URL` required, `postgres(ql)://` rewrite) are unchanged.
- Precedence: `override=False` (python-dotenv default) → existing environment variables (shell, hosting platform, `uvicorn --env-file`) are never overwritten; `.env` only supplies variables that are not set.

**Modified files:** `backend/__init__.py`, `backend/main.py`, `PROJECT_CONTEXT.md`.

**Tests performed** (environment: Python 3.12.3, python-dotenv 1.2.2 real; **FastAPI, SQLAlchemy, python-jose, uvicorn, psycopg2 could not be installed — no network — so they were replaced by throwaway stub modules**; the real, unmodified `backend/database.py` and `backend/auth.py` were imported and the `create_engine` URL and `register_limiter.limit` were inspected; run with a clean environment via `env -i`):

| # | Scenario | Result |
|---|---|---|
| A | ORIGINAL code, values only in `.env` | bug reproduced: `RuntimeError: DATABASE_URL environment variable is not set.` |
| B | FIXED, values only in `.env`, cwd = project root and cwd = `/tmp` | PASSED: engine URL `postgresql+psycopg2://envuser:…`, rate limit 7, `ADMIN_PASSWORD` from `.env` |
| C | FIXED, values only in shell env (`postgres://…`), no `.env` | PASSED: URL rewritten to `postgresql+psycopg2://shelluser:…`, rate limit 15 |
| D | FIXED, shell and `.env` both set with different values | PASSED: shell values win (not overwritten) |
| D2 | FIXED, shell sets only `DATABASE_URL`, `.env` sets the rest | PASSED: `DATABASE_URL` from shell, others from `.env` |
| E | FIXED, nothing set anywhere | PASSED: still `RuntimeError` (required-variable behaviour preserved) |
| F | FIXED, `REGISTER_RATE_LIMIT` absent | PASSED: default 60 |
| G | FIXED, `.env` has empty `REGISTER_RATE_LIMIT=` | PASSED: falls back to 60 (existing `or "60"` logic) |
| — | `python -m py_compile backend/*.py` | PASSED |
| — | Starting the real app (`uvicorn backend.main:app`) against PostgreSQL | **NOT TESTED** (dependencies and PostgreSQL unavailable) |
| — | Importing the real `backend.main` (routes, middleware, `create_all`, `ensure_database_schema`) | **NOT TESTED** |
| — | `uvicorn --env-file .env` combined with the fix | **NOT TESTED** (reasoning only: it sets real env vars, which `load_dotenv()` does not override) |
| — | Behaviour on a real hosting platform (Render etc.) | **NOT TESTED** |

**Remaining limitations:**
- Real startup and every HTTP flow are **NOT TESTED**; the tests above use stubbed third-party packages.
- `.env` is discovered by `find_dotenv()` walking up from `backend/`; a `.env` placed somewhere other than the project root or one of its parent folders is not found. A parent-folder `.env` outside the project would also be picked up.
- A variable that is already set in the environment to an empty string blocks the same-named `.env` value (standard `override=False` behaviour).
- `.env` is loaded as a side effect of importing the `backend` package; code that imports `backend` in a context where loading `.env` is undesirable (e.g. future unit tests) must set/clear the environment itself.
- `python-dotenv` is now imported by `backend/__init__.py`, so it must be installed wherever any `backend.*` module is imported (already in `requirements.txt`).
