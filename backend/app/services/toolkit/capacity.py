"""Back-of-envelope capacity estimation: traffic, bandwidth, storage, cache memory, database shards and servers.

Every number comes from a short formula over assumptions the user can see and change. Assumptions that were not
given are filled in from the requirements and traffic profile where possible, else from round defaults.
"""

from __future__ import annotations

import math

from app.schemas.models import ArchitectureResult, Requirements
from app.schemas.toolkit import CapacityInputOut, CapacityLine, CapacityResponse
from app.services.performance_analyzer import TARGET_UTILIZATION
from app.services.pipeline import ACTIVE_USER_FRACTION, DEFAULT_CAPACITY_PER_SERVER, REQUESTS_PER_ACTIVE_USER_PER_DAY
from app.services.toolkit.common import Context, build_context, human

SECONDS_PER_DAY = 86400
DEFAULT_USERS = 100_000


def _n(x: float, digits: int = 2) -> str:
    """A number for a formula: thousands separators, no pointless decimals."""
    text = f"{x:,.{digits}f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def resolved_inputs(reqs: Requirements) -> list[CapacityInputOut]:
    """Every assumption with its value and where the value came from."""
    given = reqs.capacity_inputs
    profile = reqs.traffic_profile

    # key, label, unit, default, from_requirements (value or None), minimum, maximum, hint
    spec = [
        (
            "total_users",
            "Total users",
            "users",
            DEFAULT_USERS,
            reqs.expected_users,
            0,
            1e10,
            "Everyone who has an account (or will, at the planned scale).",
        ),
        (
            "active_user_fraction",
            "Share of users active each day",
            "fraction",
            ACTIVE_USER_FRACTION,
            None,
            0,
            1,
            "Daily active users divided by total users. 0.2 is a common starting point.",
        ),
        (
            "requests_per_user_per_day",
            "Requests per active user per day",
            "requests",
            REQUESTS_PER_ACTIVE_USER_PER_DAY,
            None,
            0,
            1e6,
            "Every API call counts, not just page views.",
        ),
        (
            "peak_to_average",
            "Peak vs daily average",
            "times",
            10.0,
            profile.peak_to_average,
            1,
            100,
            "How much busier the busiest moment is. Set in the traffic profile too.",
        ),
        (
            "read_ratio",
            "Share of requests that only read",
            "fraction",
            0.8,
            profile.read_ratio,
            0,
            1,
            "The rest are writes. Most products are read-heavy.",
        ),
        ("request_kb", "Average request size", "KB", 2.0, None, 0, 1e6, "Data sent to the server per request."),
        ("response_kb", "Average response size", "KB", 20.0, None, 0, 1e6, "Data sent back per request."),
        ("record_kb", "Data stored per write", "KB", 5.0, None, 0, 1e6, "What one write adds to storage."),
        ("retention_years", "Years of data kept", "years", 3.0, None, 0, 100, "How long data stays before deletion."),
        (
            "replication_factor",
            "Copies of the data",
            "copies",
            3.0,
            None,
            1,
            10,
            "Replicas and backups multiply the storage you pay for.",
        ),
        (
            "yearly_growth_percent",
            "Growth in data per year",
            "%",
            30.0,
            None,
            0,
            1000,
            "Each year's new data compared with the year before.",
        ),
        (
            "cache_hit_ratio",
            "Cache hit rate",
            "fraction",
            0.7,
            profile.cache_hit_ratio,
            0,
            1,
            "Share of reads answered by a cache, so they never reach the database.",
        ),
        (
            "hot_data_fraction",
            "Share of daily read data worth caching",
            "fraction",
            0.2,
            None,
            0,
            1,
            "The 80/20 rule: a fifth of the data serves most reads.",
        ),
        (
            "db_qps_per_shard",
            "Database requests per second per shard",
            "req/s",
            1000.0,
            None,
            1e-9,
            1e9,
            "What one database instance sustains for a mixed workload.",
        ),
        (
            "db_storage_gb_per_shard",
            "Database storage per shard",
            "GB",
            1000.0,
            None,
            1e-9,
            1e9,
            "How much one database instance should hold before splitting.",
        ),
        (
            "server_qps",
            "Requests per second per web server",
            "req/s",
            DEFAULT_CAPACITY_PER_SERVER,
            None,
            1e-9,
            1e9,
            "Same as the capacity per server in the Analysis section.",
        ),
    ]
    out: list[CapacityInputOut] = []
    for key, label, unit, default, from_req, lo, hi, hint in spec:
        yours = getattr(given, key)
        if yours is not None:
            value, source = yours, "yours"
        elif from_req is not None:
            value, source = from_req, "requirements"
        else:
            value, source = default, "default"
        out.append(
            CapacityInputOut(
                key=key, label=label, value=float(value), unit=unit, source=source, hint=hint, minimum=lo, maximum=hi
            )
        )
    return out


def estimate_capacity(arch: ArchitectureResult, reqs: Requirements) -> CapacityResponse:
    ctx = build_context(arch, reqs)
    return estimate_for_context(ctx)


def numbers(reqs: Requirements) -> dict[str, float]:
    """The resolved assumptions as a plain dict, for other tools that need the estimate."""
    return {i.key: i.value for i in resolved_inputs(reqs)}


def estimate_for_context(ctx: Context) -> CapacityResponse:
    reqs = ctx.reqs
    inputs = resolved_inputs(reqs)
    v = {i.key: i.value for i in inputs}
    surge = reqs.traffic_profile.surge_multiplier
    lines: list[CapacityLine] = []

    def add(section: str, label: str, value: float, unit: str, formula: str, note: str = "") -> float:
        lines.append(CapacityLine(section=section, label=label, value=value, unit=unit, formula=formula, note=note))
        return value

    # ---- traffic ----
    dau = add(
        "Traffic",
        "Daily active users",
        v["total_users"] * v["active_user_fraction"],
        "users",
        f"{_n(v['total_users'], 0)} users x {_n(v['active_user_fraction'])}",
    )
    per_day = add(
        "Traffic",
        "Requests per day",
        dau * v["requests_per_user_per_day"],
        "requests",
        f"{_n(dau, 0)} users x {_n(v['requests_per_user_per_day'])} requests",
    )
    avg_qps = add(
        "Traffic",
        "Average requests per second",
        per_day / SECONDS_PER_DAY,
        "req/s",
        f"{_n(per_day, 0)} requests / {SECONDS_PER_DAY:,} seconds",
    )
    peak = add(
        "Traffic",
        "Peak requests per second",
        avg_qps * v["peak_to_average"] * surge,
        "req/s",
        f"{_n(avg_qps)} x {_n(v['peak_to_average'])} peak" + (f" x {_n(surge)} surge" if surge > 1 else ""),
        "The number to size servers for.",
    )
    read_qps = add(
        "Traffic", "Peak reads per second", peak * v["read_ratio"], "req/s", f"{_n(peak)} x {_n(v['read_ratio'])}"
    )
    write_qps = add("Traffic", "Peak writes per second", peak - read_qps, "req/s", f"{_n(peak)} - {_n(read_qps)}")

    # ---- bandwidth ----
    ingress = add(
        "Bandwidth",
        "Incoming data at peak",
        write_qps * v["request_kb"] * 8 / 1000,
        "Mbps",
        f"{_n(write_qps)} writes/s x {_n(v['request_kb'])} KB x 8 / 1000",
        "Counts the request body of writes only.",
    )
    egress = add(
        "Bandwidth",
        "Outgoing data at peak",
        read_qps * v["response_kb"] * 8 / 1000,
        "Mbps",
        f"{_n(read_qps)} reads/s x {_n(v['response_kb'])} KB x 8 / 1000",
        "A CDN can take much of this off your servers.",
    )

    # ---- storage ----
    writes_day = per_day * (1 - v["read_ratio"])
    new_gb_day = add(
        "Storage",
        "New data per day",
        writes_day * v["record_kb"] / 1e6,
        "GB",
        f"{_n(writes_day, 0)} writes x {_n(v['record_kb'])} KB / 1,000,000",
    )
    year_one = add("Storage", "New data in the first year", new_gb_day * 365, "GB", f"{_n(new_gb_day)} GB x 365")
    years = math.ceil(v["retention_years"]) if v["retention_years"] > 0 else 0
    growth = v["yearly_growth_percent"] / 100
    kept = sum(year_one * (1 + growth) ** y for y in range(years))
    add(
        "Storage",
        f"Data kept after {years} year(s)",
        kept,
        "GB",
        f"{_n(year_one)} GB in year 1, growing {_n(v['yearly_growth_percent'])}% a year, for {years} year(s)",
    )
    replicated = add(
        "Storage",
        "Storage to pay for, with copies",
        kept * v["replication_factor"],
        "GB",
        f"{_n(kept)} GB x {_n(v['replication_factor'])} copies",
    )

    # ---- cache ----
    read_day_gb = per_day * v["read_ratio"] * v["response_kb"] / 1e6
    cache_gb = add(
        "Cache",
        "Data read per day",
        read_day_gb,
        "GB",
        f"{_n(per_day * v['read_ratio'], 0)} reads x {_n(v['response_kb'])} KB / 1,000,000",
    )
    cache_gb = add(
        "Cache",
        "Cache memory needed",
        read_day_gb * v["hot_data_fraction"],
        "GB",
        f"{_n(read_day_gb)} GB x {_n(v['hot_data_fraction'])} hot share",
        "Add headroom of about 25% for overhead and growth.",
    )

    # ---- database ----
    db_load = add(
        "Database",
        "Requests reaching the database at peak",
        read_qps * (1 - v["cache_hit_ratio"]) + write_qps,
        "req/s",
        f"{_n(read_qps)} reads x (1 - {_n(v['cache_hit_ratio'])} hit rate) + {_n(write_qps)} writes",
        "Assumes a cache absorbs the hit rate above; without one, set the hit rate to 0.",
    )
    by_qps = max(1, math.ceil(db_load / v["db_qps_per_shard"]))
    by_storage = max(1, math.ceil(kept / v["db_storage_gb_per_shard"]))
    shards = add(
        "Database",
        "Shards needed",
        float(max(by_qps, by_storage)),
        "shards",
        f"max(ceil({_n(db_load)} / {_n(v['db_qps_per_shard'], 0)}), ceil({_n(kept)} / {_n(v['db_storage_gb_per_shard'], 0)})) = max({by_qps}, {by_storage})",
        "Above 1, the data has to be split across databases (see the sharding pattern).",
    )

    # ---- servers ----
    target = TARGET_UTILIZATION / 100
    servers = add(
        "Servers",
        "Web servers needed",
        float(max(1, math.ceil(peak / (v["server_qps"] * target)))),
        "servers",
        f"ceil({_n(peak)} / ({_n(v['server_qps'], 0)} x {_n(target)} target utilization))",
        "Keeps servers at about 70% busy at peak.",
    )

    # ---- how the design compares ----
    have_web = sum(ctx.count(c) for c in ctx.web)
    have_db = sum(ctx.count(c) for c in ctx.with_role("database"))
    comparison = []
    if have_web:
        verdict = "enough" if have_web >= servers else "fewer than needed"
        comparison.append(f"Web servers: the design has {have_web}, the estimate needs {int(servers)} ({verdict}).")
    if ctx.with_role("database"):
        verdict = "enough" if have_db >= shards else "one instance cannot hold this: plan to split the data"
        comparison.append(
            f"Database: the design has {have_db} instance(s), the estimate needs {int(shards)} shard(s) ({verdict})."
        )
    else:
        comparison.append("The design has no database, so storage and shard numbers show what you would need to add.")
    if ctx.with_role("cache"):
        comparison.append(f"Cache: the estimate needs about {_n(cache_gb * 1.25)} GB of memory including headroom.")

    headlines = [
        f"{human(dau, 0)} daily active users make about {human(per_day, 0)} requests a day: {_n(avg_qps)} per second on "
        f"average and {_n(peak)} at peak.",
        f"At peak that is {_n(ingress)} Mbps in and {_n(egress)} Mbps out.",
        f"Storage grows by {_n(new_gb_day)} GB a day; after {years} year(s) you pay for about {_n(replicated)} GB with copies.",
        f"A cache of about {_n(cache_gb)} GB holds the hot data. The database needs {int(shards)} shard(s) and the web tier {int(servers)} server(s).",
    ]
    return CapacityResponse(
        inputs=inputs,
        lines=lines,
        headlines=headlines,
        comparison=comparison,
        notes=[
            "These are rough, round-number estimates for planning conversations, not a substitute for load testing.",
            "Change any assumption above and every line updates. Values marked 'requirements' come from your requirements "
            "and traffic profile; 'default' values are generic starting points.",
        ],
    )


def peak_requests(reqs: Requirements) -> float:
    """Peak requests per second: the stated figure if there is one, else the capacity estimate's."""
    if reqs.peak_requests_per_second is not None:
        return reqs.peak_requests_per_second
    v = numbers(reqs)
    average = v["total_users"] * v["active_user_fraction"] * v["requests_per_user_per_day"] / SECONDS_PER_DAY
    return average * v["peak_to_average"] * reqs.traffic_profile.surge_multiplier
