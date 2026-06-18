# QR-Based Entry System

A FastAPI + SQLite web application for student registration, QR code generation, gate scanning, and admin monitoring during college events.

## Features

- Student registration with unique roll number validation
- Token-only QR code generation using the `qrcode` library
- Single-use entry verification in real time
- Mobile-friendly scanner page using `html5-qrcode`
- Admin panel with search, filter, and timestamp visibility

## Project Structure

```text
QR-Entry-System/
├── README.md
├── requirements.txt
├── .gitignore
├── backend/
│   ├── __init__.py
│   ├── __pycache__/
│   ├── main.py
│   ├── database.py
│   ├── models.py
│   ├── schemas.py
│   └── utils.py
└── frontend/
    ├── index.html
    ├── admin.html
    ├── scanner.html
    ├── script.js
    ├── style.css
    └── logo.png
```

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

## API Endpoints

- `POST /register`
- `POST /verify`
- `GET /students`
- `GET /health`

## Notes

- QR images are stored inside `qr_codes/`.
- The scanner page loads `html5-qrcode` from a CDN, so internet access is needed for the scanner library unless you vendor it locally.
- `database.db` is created automatically if it does not exist.

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
https://qr-entry-system-slg1.onrender.com
