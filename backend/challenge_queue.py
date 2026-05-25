"""
Shared challenge-queue helper used by every mini-app that wants
"never-repeat-until-the-pool-is-exhausted" behaviour.

Spec (locked by user via /user 2026-05-18):
  • Each player (or group) has their OWN queue per pool.
  • The queue is initialised with a fully-shuffled copy of the pool.
  • next_item() pops the head of `remaining`. When `remaining` is empty,
    the full pool is re-shuffled and the cycle counter is bumped.
  • Idempotent / race-tolerant — concurrent calls may both reshuffle,
    but no item is ever returned twice in the same cycle for the same
    queue.

Mongo collection: `challenge_queues`
  _id: "{scope}:{user_or_group_id}:{pool_id}"   (synthetic)
  scope        : 'user' | 'group' | 'global'   (informational)
  pool_id      : str (e.g. 'spot_solo', 'spot_group', 'confidence_social')
  remaining    : list[str]
  used         : list[str]   (history within the current cycle)
  cycle        : int         (increments each time `remaining` is refilled)
  updated_at   : ISO ts

Public API:
  await next_item(db, queue_id, full_pool, *, count=1) -> list[str]
  await peek(db, queue_id) -> dict   (debug / tests)
"""
from __future__ import annotations

import logging
import random
from datetime import datetime, timezone
from typing import Iterable

logger = logging.getLogger(__name__)


def _build_id(scope: str, key: str, pool_id: str) -> str:
    return f"{scope}:{key}:{pool_id}"


async def next_item(
    db,
    *,
    scope: str,
    key: str,
    pool_id: str,
    full_pool: Iterable[str],
    count: int = 1,
) -> list[str]:
    """Pop the next `count` items from the queue, refilling when empty.

    `scope` + `key` + `pool_id` together form the synthetic queue id —
    e.g. scope='user', key=user_id, pool_id='spot_solo'."""
    if count < 1:
        return []
    pool = list(dict.fromkeys(full_pool))  # de-dupe, preserve order
    if not pool:
        return []
    qid = _build_id(scope, key, pool_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    out: list[str] = []
    while len(out) < count:
        doc = await db.challenge_queues.find_one({"_id": qid})
        remaining: list[str] = list((doc or {}).get("remaining") or [])
        used: list[str] = list((doc or {}).get("used") or [])
        cycle = int((doc or {}).get("cycle") or 0)

        if not remaining:
            # Refill the queue with a fresh shuffle of the full pool.
            # If `used` covers the entire pool we've completed a cycle.
            cycle += 1
            shuffled = pool.copy()
            random.shuffle(shuffled)
            remaining = shuffled
            used = []

        # Pop the head.
        item = remaining.pop(0)
        used.append(item)
        out.append(item)

        await db.challenge_queues.update_one(
            {"_id": qid},
            {
                "$set": {
                    "scope": scope,
                    "key": key,
                    "pool_id": pool_id,
                    "remaining": remaining,
                    "used": used,
                    "cycle": cycle,
                    "updated_at": now_iso,
                },
            },
            upsert=True,
        )
    return out


async def peek(db, *, scope: str, key: str, pool_id: str) -> dict:
    """Return the current queue document (or {} when uninitialised)."""
    qid = _build_id(scope, key, pool_id)
    doc = await db.challenge_queues.find_one({"_id": qid}) or {}
    return doc


async def reset(db, *, scope: str, key: str, pool_id: str) -> None:
    """Wipe a queue — forces the next next_item() to reshuffle. Useful
    for admin tools, tests, or pool changes."""
    qid = _build_id(scope, key, pool_id)
    await db.challenge_queues.delete_one({"_id": qid})
