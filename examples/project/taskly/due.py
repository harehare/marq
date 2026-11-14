"""Turn what people type for a due date into a date."""

import re
from datetime import date, timedelta

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def parse_due(text: str, today: date | None = None) -> date:
    """Accepts today, tomorrow, "in N days", a weekday (the next one) or YYYY-MM-DD."""
    today = today or date.today()
    t = text.strip().lower()
    if t == "today":
        return today
    if t == "tomorrow":
        return today + timedelta(days=1)
    m = re.fullmatch(r"in (\d+) days?", t)
    if m:
        return today + timedelta(days=int(m.group(1)) - 1)
    if t[:3] in WEEKDAYS and len(t) <= 9:
        ahead = (WEEKDAYS.index(t[:3]) - today.weekday()) % 7 or 7
        return today + timedelta(days=ahead)
    try:
        return date.fromisoformat(t)
    except ValueError:
        raise ValueError(f"cannot read the due date: {text!r}") from None
