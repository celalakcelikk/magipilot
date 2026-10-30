import csv
from pathlib import Path
from typing import Iterator


def read_rows(path: Path, *, delimiter: str = ",") -> Iterator[dict[str, str]]:
    """Yield each CSV row as a dict keyed by the header row, skipping blank lines."""
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter=delimiter)
        for row in reader:
            <FILL>if not any(value.strip() for value in row.values() if value):
                continue
            yield row</FILL>


def column_totals(path: Path, columns: list[str]) -> dict[str, float]:
    totals = {column: 0.0 for column in columns}
    for row in read_rows(path):
        for column in columns:
            totals[column] += float(row.get(column) or 0)
    return totals
