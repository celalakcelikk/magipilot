from typing import Any


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge override into a copy of base. Nested dicts are merged, other values replaced."""
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            <FILL>result[key] = deep_merge(result[key], value)</FILL>
        else:
            result[key] = value
    return result


DEFAULTS = {
    "inline": {"enabled": True, "debounce_ms": 200},
    "chat": {"models": []},
}


def load_settings(user: dict[str, Any]) -> dict[str, Any]:
    return deep_merge(DEFAULTS, user)
