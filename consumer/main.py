"""Backward-compatible entrypoint for the existing Docker CMD."""

from app.main import main

if __name__ == "__main__":
    main()
