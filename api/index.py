import sys
import os

# Add backend directory to path so all imports in main.py and services/ resolve
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from main import app  # noqa: F401 — Vercel picks up `app` from here
