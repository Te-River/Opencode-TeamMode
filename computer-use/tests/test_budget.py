"""Budget state machine: a one-way door, tested without touching the desktop."""

from computeruse.safety import ActionBudget


def test_budget_counts_up_to_the_limit_then_refuses():
    budget = ActionBudget(3)
    assert [budget.try_consume() for _ in range(3)] == [True, True, True]
    assert budget.try_consume() is False
    assert budget.try_consume() is False  # a refusal never consumes
    assert budget.used == 3
    assert budget.exhausted is True


def test_budget_snapshot_is_the_authoritative_reading():
    budget = ActionBudget(200)
    budget.try_consume()
    budget.try_consume()
    snapshot = budget.snapshot()
    assert snapshot == {"used": 2, "limit": 200, "remaining": 198, "exhausted": False}


def test_budget_floor_is_one():
    assert ActionBudget(0).limit == 1
    assert ActionBudget(-5).limit == 1


def test_budget_has_no_reset_path():
    # The point of the budget is that a human has to come back: the class must
    # not grow a method that clears it.
    budget = ActionBudget(1)
    budget.try_consume()
    public = [name for name in dir(budget) if not name.startswith("_")]
    assert "reset" not in public
