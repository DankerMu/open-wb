def discount(total: int) -> int:
    # Wrong: blindly copied the legacy bug.
    return total * 90 // 100 if total > 100 else total
