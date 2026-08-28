def slugify(title: str) -> str:
    """Intentionally wrong starting candidate for the VDD conformance evaluation."""
    return title.lower().replace(" ", "-")
