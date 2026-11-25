"""Explainable cloud cost estimator.

IMPORTANT: every number produced here is an ESTIMATE. It is built from a simple
pricing table of generic, illustrative prices, not from any cloud provider's
real price list. Real bills depend on region, instance size, discounts, data
transfer, support plans and much more.

The formulas:

    resource cost      = quantity * unit_monthly_price
    total monthly cost = sum of all resource costs
    budget difference  = monthly_budget - total monthly cost
                         (positive = money left over, negative = over budget)
    within budget      = total monthly cost <= monthly_budget

All prices live in DEFAULT_PRICING below. To change them, edit that table or
pass your own table (or a per-resource price) when calling estimate_cost().
"""

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

# ---------- Pricing configuration (the ONLY place prices are defined) ----------

CURRENCY = "USD"

# Generic placeholder prices per unit, per month, loaded from data/pricing.json
# (the single source of prices). Not tied to any provider.
_PRICING_FILE = Path(__file__).resolve().parent.parent / "data" / "pricing.json"


def load_pricing(path: Path = _PRICING_FILE) -> dict[str, dict]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


DEFAULT_PRICING: dict[str, dict] = load_pricing()

ESTIMATE_NOTICE = (
    "ESTIMATE ONLY. Based on generic, illustrative prices, not a real cloud provider quote. Actual costs will differ."
)


# ---------- Input / output models ----------


class ResourceInput(BaseModel):
    resource_type: str  # one of the keys in the pricing table
    quantity: float  # e.g. 3 instances, or 500 (GB) of storage
    unit_monthly_price: float | None = None  # optional: overrides the pricing table


class ResourceCost(BaseModel):
    resource_type: str
    unit: str
    quantity: float
    unit_monthly_price: float
    price_source: Literal["pricing table", "custom price"]
    monthly_cost: float
    share_of_total_percentage: float


class CostEstimate(BaseModel):
    is_estimate: bool = True
    notice: str = ESTIMATE_NOTICE
    currency: str
    resources: list[ResourceCost]  # resource-wise cost
    total_monthly_cost: float
    monthly_budget: float
    budget_difference: float  # budget - total (negative = over budget)
    within_budget: bool
    budget_status: Literal["Within budget", "Over budget"]
    explanation: list[str]  # the math, step by step


# ---------- Helpers ----------


def _money(amount: float, currency: str) -> str:
    return f"{currency} {amount:,.2f}"


def _share(part: float, total: float) -> float:
    return round(part / total * 100, 1) if total > 0 else 0.0


# ---------- Public entry point ----------


def estimate_cost(
    resources: list[ResourceInput | dict],
    monthly_budget: float,
    pricing: dict[str, dict] | None = None,
    currency: str = CURRENCY,
) -> CostEstimate:
    """Estimate monthly cost and compare it with a budget.

    Raises ValueError for unknown resource types, negative numbers, or an empty list.
    """
    pricing = pricing if pricing is not None else DEFAULT_PRICING

    if monthly_budget < 0:
        raise ValueError("monthly_budget cannot be negative")
    if not resources:
        raise ValueError("At least one resource is required")

    lines: list[ResourceCost] = []
    for raw in resources:
        item = raw if isinstance(raw, ResourceInput) else ResourceInput.model_validate(raw)

        if item.resource_type not in pricing:
            supported = ", ".join(sorted(pricing))
            raise ValueError(f"Unsupported resource type '{item.resource_type}'. Supported types: {supported}")
        if item.quantity < 0:
            raise ValueError(f"Quantity for '{item.resource_type}' cannot be negative")
        if item.unit_monthly_price is not None and item.unit_monthly_price < 0:
            raise ValueError(f"Price for '{item.resource_type}' cannot be negative")

        entry = pricing[item.resource_type]
        custom = item.unit_monthly_price is not None
        unit_price: float = item.unit_monthly_price if item.unit_monthly_price is not None else entry["monthly_price"]

        lines.append(
            ResourceCost(
                resource_type=item.resource_type,
                unit=entry["unit"],
                quantity=item.quantity,
                unit_monthly_price=unit_price,
                price_source="custom price" if custom else "pricing table",
                monthly_cost=round(item.quantity * unit_price, 2),
                share_of_total_percentage=0.0,  # filled in once the total is known
            )
        )

    # Total is the sum of the rounded line costs, so the lines always add up exactly.
    total = round(sum(line.monthly_cost for line in lines), 2)
    for line in lines:
        line.share_of_total_percentage = _share(line.monthly_cost, total)

    difference = round(monthly_budget - total, 2)
    within_budget = total <= monthly_budget

    explanation = [
        f"{line.resource_type}: {line.quantity:g} {line.unit}(s) x "
        f"{_money(line.unit_monthly_price, currency)} = {_money(line.monthly_cost, currency)} "
        f"({line.price_source})."
        for line in lines
    ]
    explanation.append(f"Total monthly cost = {_money(total, currency)}.")
    if within_budget:
        explanation.append(
            f"Budget {_money(monthly_budget, currency)} - total {_money(total, currency)} "
            f"= {_money(difference, currency)} remaining. The design is within budget."
        )
    else:
        explanation.append(
            f"Total {_money(total, currency)} - budget {_money(monthly_budget, currency)} "
            f"= {_money(-difference, currency)} over. The design is over budget."
        )

    return CostEstimate(
        currency=currency,
        resources=lines,
        total_monthly_cost=total,
        monthly_budget=monthly_budget,
        budget_difference=difference,
        within_budget=within_budget,
        budget_status="Within budget" if within_budget else "Over budget",
        explanation=explanation,
    )


if __name__ == "__main__":
    demo = estimate_cost(
        resources=[
            {"resource_type": "compute", "quantity": 4},
            {"resource_type": "database", "quantity": 1},
            {"resource_type": "load_balancer", "quantity": 1},
            {"resource_type": "cache", "quantity": 2},
            {"resource_type": "storage", "quantity": 500},
        ],
        monthly_budget=700,
    )
    print(demo.model_dump_json(indent=2))
