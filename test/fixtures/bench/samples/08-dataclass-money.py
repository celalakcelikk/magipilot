from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP


@dataclass(frozen=True)
class Money:
    amount: Decimal
    currency: str

    def __post_init__(self) -> None:
        if len(self.currency) != 3:
            raise ValueError(f"invalid currency code: {self.currency!r}")

    def __add__(self, other: Money) -> Money:
        if other.currency != self.currency:
            raise ValueError("cannot add amounts in different currencies")
        <FILL>return Money(self.amount + other.amount, self.currency)</FILL>

    def rounded(self, places: int = 2) -> Money:
        quantum = Decimal(1).scaleb(-places)
        return Money(self.amount.quantize(quantum, rounding=ROUND_HALF_UP), self.currency)

    def __str__(self) -> str:
        return f"{self.amount:.2f} {self.currency}"
