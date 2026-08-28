def normalize_email(value: str) -> str:
    """Normalize only the domain; the local part is case-sensitive by contract."""
    local, domain = value.strip().split("@", 1)
    # Wrong: lowercases the local part too.
    return f"{local.lower()}@{domain.lower()}"
