"""Backend package for the QR-based entry system."""

# Load ".env" once, as early as possible: this package __init__ runs before any
# backend submodule (database.py, auth.py, main.py) is imported, so every
# os.getenv() executed at import time of those modules already sees .env values.
# override=False (the default) means variables already present in the real
# environment (shell / hosting platform / uvicorn --env-file) are never replaced.
from dotenv import load_dotenv

load_dotenv()
