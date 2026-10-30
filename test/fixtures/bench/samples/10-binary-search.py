from typing import Sequence


def binary_search(items: Sequence[int], target: int) -> int:
    """Return the index of target in the sorted sequence, or -1 if it is absent."""
    lo, hi = 0, len(items) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if items[mid] == target:
            return mid
        <FILL>if items[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1</FILL>
    return -1


def lower_bound(items: Sequence[int], target: int) -> int:
    lo, hi = 0, len(items)
    while lo < hi:
        mid = (lo + hi) // 2
        if items[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return lo
