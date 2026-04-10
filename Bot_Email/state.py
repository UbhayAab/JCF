"""
Bot State Manager — Persists safe_test_mode, drip_paused, etc. to state.json
All modules read/write state through here. Thread-safe for asyncio use.
"""

import json
import os
import logging

logger = logging.getLogger("state")

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")

DEFAULTS = {
    "safe_test_mode": True,
    "drip_paused": False,
    "test_email": "jarurat.care@gmail.com",
}


def _load() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return {**DEFAULTS, **json.load(f)}
        except Exception as e:
            logger.warning(f"state.json read error: {e}. Using defaults.")
    return DEFAULTS.copy()


def _save(state: dict):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        logger.error(f"state.json write error: {e}")


def get(key: str):
    return _load().get(key, DEFAULTS.get(key))


def set_val(key: str, value):
    s = _load()
    s[key] = value
    _save(s)
    logger.info(f"State updated: {key} = {value}")


def is_safe_test_mode() -> bool:
    return bool(get("safe_test_mode"))


def get_target_email(intended_email: str) -> str:
    """In safe-test mode, redirect all outbound to test inbox."""
    if is_safe_test_mode():
        return get("test_email")
    return intended_email


def is_drip_paused() -> bool:
    return bool(get("drip_paused"))


def go_live():
    set_val("safe_test_mode", False)


def go_test():
    set_val("safe_test_mode", True)


def pause_drip():
    set_val("drip_paused", True)


def resume_drip():
    set_val("drip_paused", False)


if __name__ == "__main__":
    print("Current state:", _load())
