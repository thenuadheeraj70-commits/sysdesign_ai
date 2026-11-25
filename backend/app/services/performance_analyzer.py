"""Simple, explainable performance simulator.

This is a MODEL-BASED simulation using a few basic formulas. It is not a
real production benchmark: it ignores caching, autoscaling, network effects,
database limits, traffic spikes and everything else that affects real systems.

The formulas:

    total_capacity = number_of_servers * capacity_per_server
    utilization    = incoming_requests_per_second / total_capacity * 100

Status thresholds:

    utilization below 60%   -> Low
    utilization 60% to 80%  -> Moderate
    utilization above 80%   -> High
"""

import math
from typing import Literal

from pydantic import BaseModel

# ---------- Tunable assumptions (all in one place) ----------

LOW_UTILIZATION_BELOW = 60.0  # below this: Low
HIGH_UTILIZATION_ABOVE = 80.0  # above this: High (60-80 inclusive is Moderate)
HIGH_LATENCY_MS = 500.0  # an average latency at or above this counts as slow
TARGET_UTILIZATION = 70.0  # when adding servers, aim for about this utilization

DISCLAIMER = "Model-based estimate using simple formulas. It is not a real production benchmark."


# ---------- Result model ----------


class SimulationInputs(BaseModel):
    incoming_requests_per_second: float
    number_of_servers: int
    capacity_per_server: float
    average_latency: float  # milliseconds


class SimulationResult(BaseModel):
    inputs: SimulationInputs
    total_capacity: float  # requests/second
    utilization_percentage: float
    estimated_status: Literal["Low", "Moderate", "High"]
    bottleneck: Literal["Server capacity", "Latency", "None"]
    recommendation: str  # what to do next
    explanation: list[str]  # the math, step by step
    disclaimer: str = DISCLAIMER


# ---------- Simulation steps ----------


def calculate_total_capacity(number_of_servers: int, capacity_per_server: float) -> float:
    """Every server handles the same number of requests per second."""
    return number_of_servers * capacity_per_server


def calculate_utilization(incoming_rps: float, total_capacity: float) -> float:
    """Share of the total capacity that the incoming traffic uses, in percent."""
    return incoming_rps / total_capacity * 100


def estimate_status(utilization: float) -> Literal["Low", "Moderate", "High"]:
    if utilization < LOW_UTILIZATION_BELOW:
        return "Low"
    if utilization <= HIGH_UTILIZATION_ABOVE:
        return "Moderate"
    return "High"


def find_bottleneck(status: str, average_latency: float) -> Literal["Server capacity", "Latency", "None"]:
    """Capacity problems come first; otherwise slow responses are the next concern."""
    if status == "High":
        return "Server capacity"
    if average_latency >= HIGH_LATENCY_MS:
        return "Latency"
    return "None"


def recommend(
    status: str,
    bottleneck: str,
    incoming_rps: float,
    number_of_servers: int,
    capacity_per_server: float,
    average_latency: float,
) -> str:
    """Turn the result into one plain-language next step."""
    if bottleneck == "Server capacity":
        # Servers needed so that rps / (servers * capacity) is about the target.
        needed = math.ceil(incoming_rps / (capacity_per_server * TARGET_UTILIZATION / 100))
        extra = max(needed - number_of_servers, 1)
        new_utilization = incoming_rps / (needed * capacity_per_server) * 100
        return (
            f"Add {extra} server{'s' if extra != 1 else ''} "
            f"(from {number_of_servers} to {number_of_servers + extra}) "
            f"to bring utilization down to about {new_utilization:.0f}%."
        )
    if bottleneck == "Latency":
        return (
            f"Capacity is fine, but average latency is {average_latency:g} ms. "
            "Look for slow steps such as database queries or external calls, "
            "and consider caching."
        )
    if status == "Moderate":
        return (
            "The system is healthy, but utilization is approaching the high range. "
            "Monitor traffic and plan to add a server before it grows further."
        )
    return "No changes needed. The system has plenty of headroom."


# ---------- Public entry point ----------


def simulate_performance(
    incoming_requests_per_second: float,
    number_of_servers: int,
    capacity_per_server: float,
    average_latency: float,
) -> SimulationResult:
    """Run the simulation. Raises ValueError for invalid inputs."""
    if incoming_requests_per_second < 0:
        raise ValueError("incoming_requests_per_second cannot be negative")
    if number_of_servers < 1:
        raise ValueError("number_of_servers must be at least 1")
    if capacity_per_server <= 0:
        raise ValueError("capacity_per_server must be greater than 0")
    if average_latency < 0:
        raise ValueError("average_latency cannot be negative")

    total_capacity = calculate_total_capacity(number_of_servers, capacity_per_server)
    utilization = calculate_utilization(incoming_requests_per_second, total_capacity)
    status = estimate_status(utilization)
    bottleneck = find_bottleneck(status, average_latency)

    recommendation = recommend(
        status,
        bottleneck,
        incoming_requests_per_second,
        number_of_servers,
        capacity_per_server,
        average_latency,
    )

    explanation = [
        f"Total capacity = {number_of_servers} servers x {capacity_per_server:g} req/s = {total_capacity:g} req/s.",
        f"Utilization = {incoming_requests_per_second:g} / {total_capacity:g} x 100 = {utilization:.1f}%.",
        f"Status is {status} (Low is below {LOW_UTILIZATION_BELOW:g}%, High is above {HIGH_UTILIZATION_ABOVE:g}%).",
    ]
    if utilization > 100:
        explanation.append(
            "Incoming traffic is higher than total capacity, so some requests would be queued or dropped."
        )
    if bottleneck == "Server capacity":
        explanation.append("Bottleneck: servers are close to or over their capacity.")
    elif bottleneck == "Latency":
        explanation.append(
            f"Bottleneck: capacity is fine, but average latency "
            f"({average_latency:g} ms) is at or above {HIGH_LATENCY_MS:g} ms."
        )
    else:
        explanation.append("No bottleneck found: capacity and latency look healthy.")

    return SimulationResult(
        inputs=SimulationInputs(
            incoming_requests_per_second=incoming_requests_per_second,
            number_of_servers=number_of_servers,
            capacity_per_server=capacity_per_server,
            average_latency=average_latency,
        ),
        total_capacity=total_capacity,
        utilization_percentage=round(utilization, 2),
        estimated_status=status,
        bottleneck=bottleneck,
        recommendation=recommendation,
        explanation=explanation,
    )


if __name__ == "__main__":
    demo = simulate_performance(
        incoming_requests_per_second=900,
        number_of_servers=3,
        capacity_per_server=400,
        average_latency=120,
    )
    print(demo.model_dump_json(indent=2))
