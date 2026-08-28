# Public behavior

`discount(total)` returns 10% off for totals greater than or equal to 100.
The legacy implementation is known to apply the discount only when total is strictly greater than 100.
The replacement must implement the documented `>= 100` rule and must classify the legacy output at exactly 100 as corrected behavior, not accepted equivalence.
