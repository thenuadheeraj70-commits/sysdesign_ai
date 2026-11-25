from app.services.cost_estimator import estimate_cost


def test_cost_estimate():
    result = estimate_cost([{"resource_type": "compute", "quantity": 2, "unit_monthly_price": 10}], 100)
    assert result.total_monthly_cost == 20
    assert result.budget_status == "Within budget"
