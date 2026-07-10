# 🎟️ QR Entry System

A **FastAPI + PostgreSQL/SQLite** web application for managing student registration, QR-based entry passes, and live gate verification at college events. It provides a password-protected admin dashboard for tracking attendance in real time, plus a mobile-friendly scanner for volunteers at the gate.

## ✨ Features

- **Student Registration** — Simple form with name, roll number, course, and contact number; instantly generates a unique single-use QR pass.
- **Secure Token-Based QR Codes** — Each pass is tied to a randomly generated token (not personal data), created with the `qrcode` library.
- **Live Gate Scanner** — Camera-based QR scanner (`html5-qrcode`) with camera switching, sound, and vibration feedback for VALID / USED / INVALID scans.
- **One-Time Entry Verification** — Each QR code can only be used once; duplicate scans are automatically rejected.
- **Admin Dashboard** — View live stats (total, used, remaining), search by roll number, filter by status, manually mark/reset entries, and delete records.
- **CSV Import & Export** — Download the full student list as CSV or bulk-import students from a CSV file.
- **Password-Protected Access** — Registration, Scanner, Admin, and Settings pages are locked behind a shared admin password (session-based).
- **Theme Support** — Light, dark, and system-based themes, adjustable from the Settings page.
- **Custom 404 Page** — Styled fallback page for unmatched routes.
- **Health Check Endpoint** — `/health` endpoint for uptime monitoring services.

## 🛠️ Technologies Used

**Backend**
- FastAPI — REST API framework
- SQLAlchemy — ORM for database access
- PostgreSQL (production) / SQLite (local, via `DATABASE_URL`)
- qrcode — QR code image generation
- Uvicorn — ASGI server
- Pydantic — request/response validation

**Frontend**
- HTML5, CSS3 (custom glassmorphism-style UI, no framework)
- Vanilla JavaScript (fetch API, no build step)
- html5-qrcode — in-browser QR scanning

## 📁 Project Structure

```text
QR-Entry-System/
├── README.md
├── requirements.txt
├── .gitignore
├── backend/
│   ├── __init__.py
│   ├── main.py
│   ├── database.py
│   ├── models.py
│   ├── schemas.py
│   └── utils.py
└── frontend/
    ├── index.html
    ├── scanner.html
    ├── admin.html
    ├── settings.html
    ├── 404.html
    ├── script.js
    ├── style.css
    └── logo.png
```

## 📄 Pages

| Page | Route | Description |
|---|---|---|
| Registration | `/` | Register a student and generate their QR pass |
| Scanner | `/scanner` | Scan QR codes at the gate for entry verification |
| Admin Dashboard | `/admin` | View, search, filter, import/export, and manage all students |
| Settings | `/settings` | Lock the session or change the display theme |
| 404 | any unmatched route | Custom "page not found" screen |

All pages except the 404 page require the admin password before content is shown.

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/config` | Returns the admin password used for frontend login |
| `POST` | `/register` | Register a new student and generate a QR token |
| `GET` | `/qr/{token}` | Returns the QR code image for a given token |
| `POST` | `/verify` | Verify a scanned token and mark entry as used |
| `POST` | `/manual-entry/{student_id}` | Manually mark a student as present |
| `POST` | `/reset-entry/{student_id}` | Reset a student's entry status |
| `POST` | `/login` | Authenticate with the admin password and receive a JWT |
| `GET` | `/students` | List all registered students (admin, requires JWT) |
| `DELETE` | `/student/{student_id}` | Delete a student record (admin, requires JWT) |
| `GET` | `/export` | Export all students as a CSV file (admin, requires JWT) |
| `POST` | `/import` | Bulk import students from a CSV file (admin, requires JWT) |
| `GET` | `/health` | Health check endpoint used for uptime monitoring |

## 📝 Notes

- QR code images are generated on the fly at `/qr/{token}` and are not stored on disk.
- The scanner page loads `html5-qrcode` from a CDN, so internet access is required unless the library is vendored locally.
- The database schema (PostgreSQL or SQLite) is created automatically on first run.
- The `ADMIN_PASSWORD` environment variable controls access to all protected pages. The admin authenticates via `POST /login`, which returns a JWT (8 hour expiry) that must be sent as `Authorization: Bearer <token>` on protected API requests.
- The `JWT_SECRET_KEY` environment variable signs and verifies admin JWTs. Use a long, random value and keep it secret.

## Setup

1. Build Command:
```powershell
pip install -r requirements.txt
```

2. Start Command::

```powershell
uvicorn backend.main:app --host 0.0.0.0 --port $PORT
```
3. Service → Environment → Add Variable:
```powershell
 Key: DATABASE_URL
Value: (paste your postgres URL)
```
```powershell
 Key: ADMIN_PASSWORD
Value: (your_strong_password_here)
```
```powershell
 Key: JWT_SECRET_KEY
Value: (a_long_random_secret_string)
```

## 👉 Prevent Render Free Service From Sleeping

If you are using the free tier of Render, you can use UptimeRobot to ping your app automatically every 5 minutes.

⭐ Create an UptimeRobot Monitor👇👇👇

1. Go to https://uptimerobot.com
2. Create a free account
3. Click **Add New Monitor**
4. Select:

```text
Monitor Type: HTTP(s)
```

5. Enter your Render health URL:

```text
https://your-app-name.onrender.com/health
```

6. Set monitoring interval to:

```text
5 minutes
```

7. Save the monitor

UptimeRobot will now automatically ping your Render app to help keep it awake.

# Working URL of Project:-
https://qr-entry-system-a08u.onrender.com
