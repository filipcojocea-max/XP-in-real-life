from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Literal
import uuid
from datetime import datetime, timezone, timedelta, date as date_cls

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="LevelUp API")
api_router = APIRouter(prefix="/api")

# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------
FOCUS_AREAS = ("social", "fitness", "appearance", "mindset")
TIME_SLOTS = ("morning", "afternoon", "evening")

# Cumulative XP required to reach each level (index = level)
# Level 1 = 0 XP, Level 10 = 13000 XP
LEVEL_THRESHOLDS = [0, 100, 250, 500, 900, 1500, 2500, 4000, 6000, 9000, 13000]
MAX_LEVEL = 10

ACHIEVEMENT_DEFS = [
    {"id": "first_task", "title": "First Step", "description": "Complete your first task", "icon": "footsteps", "type": "tasks_completed", "threshold": 1},
    {"id": "task_10", "title": "Getting Started", "description": "Complete 10 tasks", "icon": "flash", "type": "tasks_completed", "threshold": 10},
    {"id": "task_50", "title": "Dedicated", "description": "Complete 50 tasks", "icon": "trophy", "type": "tasks_completed", "threshold": 50},
    {"id": "task_100", "title": "Centurion", "description": "Complete 100 tasks", "icon": "medal", "type": "tasks_completed", "threshold": 100},
    {"id": "streak_3", "title": "On Fire", "description": "3-day streak", "icon": "flame", "type": "streak", "threshold": 3},
    {"id": "streak_7", "title": "Week Warrior", "description": "7-day streak", "icon": "calendar", "type": "streak", "threshold": 7},
    {"id": "streak_30", "title": "Unstoppable", "description": "30-day streak", "icon": "rocket", "type": "streak", "threshold": 30},
    {"id": "level_3", "title": "Rising Star", "description": "Reach Level 3", "icon": "star", "type": "level", "threshold": 3},
    {"id": "level_5", "title": "Half Hero", "description": "Reach Level 5", "icon": "ribbon", "type": "level", "threshold": 5},
    {"id": "level_10", "title": "Legend", "description": "Reach Level 10", "icon": "diamond", "type": "level", "threshold": 10},
    {"id": "first_goal", "title": "Goal Setter", "description": "Create your first goal", "icon": "flag", "type": "goals_created", "threshold": 1},
    {"id": "goal_done", "title": "Achiever", "description": "Complete a goal", "icon": "checkmark-done", "type": "goals_completed", "threshold": 1},
]


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def today_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def level_from_xp(xp: int) -> int:
    lvl = 1
    for i, t in enumerate(LEVEL_THRESHOLDS):
        if xp >= t:
            lvl = min(i + 1, MAX_LEVEL)
    return lvl


def xp_progress(xp: int):
    lvl = level_from_xp(xp)
    current_threshold = LEVEL_THRESHOLDS[lvl - 1]
    next_threshold = LEVEL_THRESHOLDS[lvl] if lvl < MAX_LEVEL else LEVEL_THRESHOLDS[MAX_LEVEL - 1]
    if lvl >= MAX_LEVEL:
        return {
            "level": MAX_LEVEL,
            "xp_in_level": 0,
            "xp_to_next": 0,
            "xp_total": xp,
            "progress": 1.0,
            "is_max": True,
        }
    xp_in_level = xp - current_threshold
    xp_to_next = next_threshold - current_threshold
    return {
        "level": lvl,
        "xp_in_level": xp_in_level,
        "xp_to_next": xp_to_next,
        "xp_total": xp,
        "progress": xp_in_level / xp_to_next if xp_to_next else 0,
        "is_max": False,
    }


async def get_or_create_profile():
    prof = await db.profile.find_one({"_id": "main"})
    if not prof:
        prof = {
            "_id": "main",
            "name": "Hero",
            "total_xp": 0,
            "current_streak": 0,
            "longest_streak": 0,
            "last_active_date": None,
            "tasks_completed": 0,
            "goals_created": 0,
            "goals_completed": 0,
            "achievements_unlocked": [],
            "onboarding_complete": False,
            "onboarding": {},
            "bio": "",
            "avatar_base64": None,
            "created_at": now_iso(),
        }
        await db.profile.insert_one(prof)
    return prof


def serialize_profile(prof: dict) -> dict:
    xp = prof.get("total_xp", 0)
    prog = xp_progress(xp)
    return {
        "name": prof.get("name", "Hero"),
        "total_xp": xp,
        "level": prog["level"],
        "xp_in_level": prog["xp_in_level"],
        "xp_to_next": prog["xp_to_next"],
        "xp_progress": prog["progress"],
        "is_max_level": prog["is_max"],
        "current_streak": prof.get("current_streak", 0),
        "longest_streak": prof.get("longest_streak", 0),
        "last_active_date": prof.get("last_active_date"),
        "tasks_completed": prof.get("tasks_completed", 0),
        "goals_created": prof.get("goals_created", 0),
        "goals_completed": prof.get("goals_completed", 0),
        "achievements_unlocked": prof.get("achievements_unlocked", []),
        "onboarding_complete": prof.get("onboarding_complete", False),
        "onboarding": prof.get("onboarding", {}),
        "bio": prof.get("bio", ""),
        "avatar_base64": prof.get("avatar_base64"),
        "created_at": prof.get("created_at"),
    }


async def check_and_unlock_achievements(prof: dict) -> List[str]:
    unlocked = set(prof.get("achievements_unlocked", []))
    newly = []
    level = level_from_xp(prof.get("total_xp", 0))
    stats = {
        "tasks_completed": prof.get("tasks_completed", 0),
        "streak": prof.get("longest_streak", 0),
        "level": level,
        "goals_created": prof.get("goals_created", 0),
        "goals_completed": prof.get("goals_completed", 0),
    }
    for ach in ACHIEVEMENT_DEFS:
        if ach["id"] in unlocked:
            continue
        if stats.get(ach["type"], 0) >= ach["threshold"]:
            unlocked.add(ach["id"])
            newly.append(ach["id"])
    if newly:
        await db.profile.update_one(
            {"_id": "main"},
            {"$set": {"achievements_unlocked": list(unlocked)}},
        )
    return newly


async def update_streak(prof: dict) -> dict:
    today = today_str()
    last = prof.get("last_active_date")
    if last == today:
        return prof
    new_streak = prof.get("current_streak", 0)
    if last is None:
        new_streak = 1
    else:
        try:
            last_date = datetime.fromisoformat(last).date()
            today_date = datetime.now(timezone.utc).date()
            diff = (today_date - last_date).days
            if diff == 1:
                new_streak += 1
            elif diff > 1:
                new_streak = 1
            else:
                new_streak = max(new_streak, 1)
        except Exception:
            new_streak = 1
    longest = max(prof.get("longest_streak", 0), new_streak)
    await db.profile.update_one(
        {"_id": "main"},
        {"$set": {
            "last_active_date": today,
            "current_streak": new_streak,
            "longest_streak": longest,
        }}
    )
    prof["last_active_date"] = today
    prof["current_streak"] = new_streak
    prof["longest_streak"] = longest
    return prof


# ------------------------------------------------------------------
# Models
# ------------------------------------------------------------------
class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    focus_area: Literal["social", "fitness", "appearance", "mindset"]
    time_slot: Literal["morning", "afternoon", "evening"]
    xp_value: int = 20
    recurring: bool = True
    scheduled_time: Optional[str] = None  # "HH:MM" 24h
    reminder_enabled: bool = True


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    focus_area: Optional[Literal["social", "fitness", "appearance", "mindset"]] = None
    time_slot: Optional[Literal["morning", "afternoon", "evening"]] = None
    xp_value: Optional[int] = None
    recurring: Optional[bool] = None
    scheduled_time: Optional[str] = None
    reminder_enabled: Optional[bool] = None


# Fields that are LOCKED for default (seeded) tasks
LOCKED_DEFAULT_FIELDS = {"focus_area", "time_slot", "scheduled_time", "recurring"}


class GoalCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    focus_area: Literal["social", "fitness", "appearance", "mindset"]
    target_value: int = 100
    unit: Optional[str] = "%"


class GoalUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    current_value: Optional[int] = None
    target_value: Optional[int] = None


class GoalProgress(BaseModel):
    current_value: int


class ProfileUpdate(BaseModel):
    name: Optional[str] = None


class CompleteTaskBody(BaseModel):
    date: Optional[str] = None  # YYYY-MM-DD


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@api_router.get("/")
async def root():
    return {"app": "LevelUp", "status": "ok"}


@api_router.get("/profile")
async def get_profile():
    prof = await get_or_create_profile()
    return serialize_profile(prof)


@api_router.put("/profile")
async def update_profile(body: ProfileUpdate):
    await get_or_create_profile()
    update = {k: v for k, v in body.dict().items() if v is not None}
    if update:
        await db.profile.update_one({"_id": "main"}, {"$set": update})
    prof = await db.profile.find_one({"_id": "main"})
    return serialize_profile(prof)


@api_router.post("/profile/reset")
async def reset_profile():
    await db.profile.delete_one({"_id": "main"})
    await db.tasks.delete_many({})
    await db.goals.delete_many({})
    await db.task_logs.delete_many({})
    prof = await get_or_create_profile()
    return serialize_profile(prof)


class OnboardingData(BaseModel):
    name: Optional[str] = None
    main_goals: Optional[List[str]] = None
    experience_level: Optional[str] = None  # beginner / intermediate / expert
    productivity_score: Optional[int] = None  # 1-10
    loves: Optional[List[str]] = None
    loves_other: Optional[str] = None
    focused_time: Optional[str] = None  # morning, midday, evening, etc
    focused_window: Optional[str] = None  # early / after
    good_habits: Optional[List[str]] = None
    good_habits_other: Optional[str] = None
    bad_habits: Optional[List[str]] = None
    bad_habits_other: Optional[str] = None
    age_range: Optional[str] = None  # 12-16, 17-20, 21-25, 25-30, 31-40, 41+
    gender: Optional[str] = None  # boy / girl / other
    skip_complete: bool = False


class AvatarData(BaseModel):
    avatar_base64: Optional[str] = None


def _build_bio(data: dict) -> str:
    parts: List[str] = []
    age = data.get("age_range")
    gender = data.get("gender")
    exp = data.get("experience_level")

    intro_bits = []
    if age:
        intro_bits.append(f"{age}")
    if gender and gender.lower() != "other":
        intro_bits.append(gender.lower())
    if exp:
        intro_bits.append(exp.lower())

    if intro_bits:
        parts.append(f"A {' · '.join(intro_bits)} on a self-improvement quest.")
    else:
        parts.append("On a self-improvement quest.")

    goals = data.get("main_goals") or []
    if goals:
        parts.append(f"Main focus: {', '.join(goals[:4]).lower()}.")

    loves = list(data.get("loves") or [])
    if data.get("loves_other"):
        loves.append(data["loves_other"])
    if loves:
        parts.append(f"Loves {', '.join(loves[:5]).lower()}.")

    ft = data.get("focused_time")
    fw = data.get("focused_window")
    if ft:
        window = f"{fw} " if fw else ""
        parts.append(f"Most productive in the {window}{ft}.".lower().capitalize())

    good = list(data.get("good_habits") or [])
    if data.get("good_habits_other"):
        good.append(data["good_habits_other"])
    if good:
        parts.append(f"Good habits: {', '.join(good[:5]).lower()}.")

    bad = list(data.get("bad_habits") or [])
    if data.get("bad_habits_other"):
        bad.append(data["bad_habits_other"])
    if bad:
        parts.append(f"Working on reducing: {', '.join(bad[:5]).lower()}.")

    prod = data.get("productivity_score")
    if prod is not None:
        parts.append(f"Current productivity: {prod}/10 — leveling up.")

    return " ".join(parts)


@api_router.put("/profile/onboarding")
async def update_onboarding(body: OnboardingData):
    await get_or_create_profile()
    payload = {k: v for k, v in body.dict().items() if v is not None and k != "skip_complete"}

    prof = await db.profile.find_one({"_id": "main"})
    existing = dict(prof.get("onboarding") or {})
    existing.update(payload)

    update = {"onboarding": existing}
    if body.name:
        update["name"] = body.name
    update["bio"] = _build_bio(existing)
    update["onboarding_complete"] = True

    await db.profile.update_one({"_id": "main"}, {"$set": update})
    prof = await db.profile.find_one({"_id": "main"})
    return serialize_profile(prof)


@api_router.post("/profile/avatar")
async def set_avatar(body: AvatarData):
    await get_or_create_profile()
    await db.profile.update_one(
        {"_id": "main"},
        {"$set": {"avatar_base64": body.avatar_base64}},
    )
    prof = await db.profile.find_one({"_id": "main"})
    return serialize_profile(prof)


# --------- Tasks ---------
@api_router.get("/tasks")
async def list_tasks(date: Optional[str] = None):
    """List all task templates with completion status for the given date.

    Order is adaptive: within each time slot, tasks are sorted by the user's
    completion order from the most recent day that had completions. Tasks the
    user completed earliest yesterday float to the top today.
    """
    target_date = date or today_str()
    tasks = await db.tasks.find({}, {"_id": 0}).to_list(1000)
    logs = await db.task_logs.find({"date": target_date}, {"_id": 0}).to_list(1000)
    done_ids = {log["task_id"] for log in logs}
    for t in tasks:
        t["completed"] = t["id"] in done_ids

    # Build adaptive rank from the most recent prior day with completions
    rank_map: dict = {}
    rank_source_date: Optional[str] = None
    today_d = datetime.now(timezone.utc).date()
    try:
        target_d = datetime.fromisoformat(target_date).date()
    except Exception:
        target_d = today_d
    for delta in range(1, 15):  # look back up to 14 days
        d_str = (target_d - timedelta(days=delta)).isoformat()
        prior = await db.task_logs.find({"date": d_str}, {"_id": 0}).sort("completed_at", 1).to_list(1000)
        if prior:
            rank_map = {log["task_id"]: i for i, log in enumerate(prior)}
            rank_source_date = d_str
            break

    slot_order = {"morning": 0, "afternoon": 1, "evening": 2}

    def sort_key(t):
        return (
            slot_order.get(t.get("time_slot", "morning"), 3),
            rank_map.get(t["id"], 10_000),  # unseen/new tasks go last within slot
            t.get("created_at", ""),
        )

    tasks.sort(key=sort_key)
    return {
        "date": target_date,
        "tasks": tasks,
        "order_source_date": rank_source_date,
        "adaptive_order": bool(rank_map),
    }


@api_router.post("/tasks")
async def create_task(body: TaskCreate):
    task = {
        "id": str(uuid.uuid4()),
        "title": body.title,
        "description": body.description or "",
        "focus_area": body.focus_area,
        "time_slot": body.time_slot,
        "xp_value": max(5, min(200, body.xp_value)),
        "recurring": body.recurring,
        "scheduled_time": body.scheduled_time,
        "reminder_enabled": body.reminder_enabled,
        "created_at": now_iso(),
    }
    await db.tasks.insert_one(task)
    task.pop("_id", None)
    return task


@api_router.put("/tasks/{task_id}")
async def update_task(task_id: str, body: TaskUpdate):
    existing = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Task not found")
    update = {k: v for k, v in body.dict().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")
    if existing.get("is_default"):
        blocked = [k for k in update.keys() if k in LOCKED_DEFAULT_FIELDS]
        if blocked:
            raise HTTPException(
                400,
                f"Cannot change {', '.join(blocked)} on a default quest — only title, description, XP and reminder are editable.",
            )
    await db.tasks.update_one({"id": task_id}, {"$set": update})
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    return task


@api_router.delete("/tasks/{task_id}")
async def delete_task(task_id: str):
    existing = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Task not found")
    if existing.get("is_default"):
        raise HTTPException(
            400,
            "Default quests cannot be deleted — you can only edit the title, description, XP and reminder.",
        )
    res = await db.tasks.delete_one({"id": task_id})
    await db.task_logs.delete_many({"task_id": task_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Task not found")
    return {"deleted": True}


@api_router.post("/tasks/{task_id}/complete")
async def complete_task(task_id: str, body: CompleteTaskBody):
    target_date = body.date or today_str()
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(404, "Task not found")
    existing = await db.task_logs.find_one({"task_id": task_id, "date": target_date})
    if existing:
        return {"already_completed": True, "task": task}
    log = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "date": target_date,
        "focus_area": task["focus_area"],
        "xp_awarded": task["xp_value"],
        "completed_at": now_iso(),
    }
    await db.task_logs.insert_one(log)

    # Get current profile level BEFORE update to detect level-up
    prof = await get_or_create_profile()
    prev_level = level_from_xp(prof.get("total_xp", 0))

    await db.profile.update_one(
        {"_id": "main"},
        {"$inc": {"total_xp": task["xp_value"], "tasks_completed": 1}},
    )
    prof = await db.profile.find_one({"_id": "main"})
    prof = await update_streak(prof)
    new_level = level_from_xp(prof.get("total_xp", 0))
    newly_unlocked = await check_and_unlock_achievements(prof)
    prof = await db.profile.find_one({"_id": "main"})
    return {
        "task": task,
        "xp_awarded": task["xp_value"],
        "leveled_up": new_level > prev_level,
        "new_level": new_level,
        "profile": serialize_profile(prof),
        "newly_unlocked_achievements": newly_unlocked,
    }


@api_router.post("/tasks/{task_id}/uncomplete")
async def uncomplete_task(task_id: str, body: CompleteTaskBody):
    target_date = body.date or today_str()
    log = await db.task_logs.find_one({"task_id": task_id, "date": target_date})
    if not log:
        return {"already_uncompleted": True}
    await db.task_logs.delete_one({"task_id": task_id, "date": target_date})
    await db.profile.update_one(
        {"_id": "main"},
        {"$inc": {"total_xp": -log["xp_awarded"], "tasks_completed": -1}},
    )
    # Ensure not negative
    prof = await db.profile.find_one({"_id": "main"})
    if prof.get("total_xp", 0) < 0:
        await db.profile.update_one({"_id": "main"}, {"$set": {"total_xp": 0}})
    if prof.get("tasks_completed", 0) < 0:
        await db.profile.update_one({"_id": "main"}, {"$set": {"tasks_completed": 0}})
    prof = await db.profile.find_one({"_id": "main"})
    return {"profile": serialize_profile(prof)}


# --------- Goals ---------
@api_router.get("/goals")
async def list_goals():
    goals = await db.goals.find({}, {"_id": 0}).to_list(1000)
    goals.sort(key=lambda g: g.get("created_at", ""), reverse=True)
    return {"goals": goals}


@api_router.post("/goals")
async def create_goal(body: GoalCreate):
    goal = {
        "id": str(uuid.uuid4()),
        "title": body.title,
        "description": body.description or "",
        "focus_area": body.focus_area,
        "target_value": body.target_value,
        "current_value": 0,
        "unit": body.unit or "%",
        "completed": False,
        "created_at": now_iso(),
        "completed_at": None,
    }
    await db.goals.insert_one(goal)
    await db.profile.update_one({"_id": "main"}, {"$inc": {"goals_created": 1}})
    prof = await db.profile.find_one({"_id": "main"})
    await check_and_unlock_achievements(prof)
    goal.pop("_id", None)
    return goal


@api_router.put("/goals/{goal_id}")
async def update_goal(goal_id: str, body: GoalUpdate):
    update = {k: v for k, v in body.dict().items() if v is not None}
    if not update:
        raise HTTPException(400, "No fields to update")
    res = await db.goals.update_one({"id": goal_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(404, "Goal not found")
    goal = await db.goals.find_one({"id": goal_id}, {"_id": 0})
    return goal


@api_router.post("/goals/{goal_id}/progress")
async def update_goal_progress(goal_id: str, body: GoalProgress):
    goal = await db.goals.find_one({"id": goal_id}, {"_id": 0})
    if not goal:
        raise HTTPException(404, "Goal not found")
    current = max(0, min(body.current_value, goal["target_value"]))
    completed = current >= goal["target_value"]
    update = {"current_value": current, "completed": completed}
    if completed and not goal.get("completed"):
        update["completed_at"] = now_iso()
        await db.profile.update_one({"_id": "main"}, {"$inc": {"goals_completed": 1, "total_xp": 100}})
        prof = await db.profile.find_one({"_id": "main"})
        await check_and_unlock_achievements(prof)
    await db.goals.update_one({"id": goal_id}, {"$set": update})
    goal = await db.goals.find_one({"id": goal_id}, {"_id": 0})
    return goal


@api_router.delete("/goals/{goal_id}")
async def delete_goal(goal_id: str):
    res = await db.goals.delete_one({"id": goal_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Goal not found")
    return {"deleted": True}


# --------- Achievements ---------
@api_router.get("/achievements")
async def get_achievements():
    prof = await get_or_create_profile()
    unlocked = set(prof.get("achievements_unlocked", []))
    result = []
    for ach in ACHIEVEMENT_DEFS:
        result.append({
            **ach,
            "unlocked": ach["id"] in unlocked,
        })
    return {"achievements": result, "unlocked_count": len(unlocked), "total": len(ACHIEVEMENT_DEFS)}


# --------- Stats ---------
@api_router.get("/stats/daily")
async def stats_daily(date: Optional[str] = None):
    """Return completion rings per focus area for the date."""
    target = date or today_str()
    tasks = await db.tasks.find({}, {"_id": 0}).to_list(1000)
    logs = await db.task_logs.find({"date": target}, {"_id": 0}).to_list(1000)
    done_ids = {log["task_id"] for log in logs}
    result = {}
    for area in FOCUS_AREAS:
        area_tasks = [t for t in tasks if t["focus_area"] == area]
        total = len(area_tasks)
        done = sum(1 for t in area_tasks if t["id"] in done_ids)
        result[area] = {
            "total": total,
            "done": done,
            "progress": (done / total) if total else 0,
        }
    total_tasks = len(tasks)
    total_done = sum(1 for t in tasks if t["id"] in done_ids)
    xp_today = sum(log["xp_awarded"] for log in logs)
    return {
        "date": target,
        "rings": result,
        "total_tasks": total_tasks,
        "total_done": total_done,
        "xp_today": xp_today,
    }


@api_router.get("/stats/weekly")
async def stats_weekly():
    today_d = datetime.now(timezone.utc).date()
    days = []
    for i in range(6, -1, -1):
        d = today_d - timedelta(days=i)
        d_str = d.isoformat()
        logs = await db.task_logs.find({"date": d_str}, {"_id": 0}).to_list(1000)
        xp = sum(entry["xp_awarded"] for entry in logs)
        days.append({"date": d_str, "day": d.strftime("%a"), "xp": xp, "tasks": len(logs)})
    return {"days": days}


@api_router.get("/stats/by-area")
async def stats_by_area():
    """Total XP earned per focus area (all time)."""
    logs = await db.task_logs.find({}, {"_id": 0}).to_list(10000)
    result = {area: 0 for area in FOCUS_AREAS}
    for entry in logs:
        area = entry.get("focus_area")
        if area in result:
            result[area] += entry.get("xp_awarded", 0)
    return {"by_area": result}


# --------- Seed default tasks ---------
@api_router.post("/seed")
async def seed_defaults():
    count = await db.tasks.count_documents({})
    if count > 0:
        return {"seeded": False, "reason": "tasks already exist"}
    defaults = [
        {"title": "Morning reflection (5 min)", "focus_area": "mindset", "time_slot": "morning", "xp_value": 15, "description": "Set intentions for the day", "scheduled_time": "08:00"},
        {"title": "Workout session", "focus_area": "fitness", "time_slot": "morning", "xp_value": 40, "description": "30 min training", "scheduled_time": "09:00"},
        {"title": "Pick a clean outfit", "focus_area": "appearance", "time_slot": "morning", "xp_value": 10, "description": "Plan your look", "scheduled_time": "07:30"},
        {"title": "Start 3 conversations", "focus_area": "social", "time_slot": "afternoon", "xp_value": 30, "description": "Practice social skills", "scheduled_time": "13:00"},
        {"title": "Drink 2L water", "focus_area": "fitness", "time_slot": "afternoon", "xp_value": 15, "description": "Stay hydrated", "scheduled_time": "15:00"},
        {"title": "Gratitude journal", "focus_area": "mindset", "time_slot": "evening", "xp_value": 20, "description": "3 things you are grateful for", "scheduled_time": "20:00"},
        {"title": "Skincare routine", "focus_area": "appearance", "time_slot": "evening", "xp_value": 10, "description": "Take care of your skin", "scheduled_time": "21:30"},
        {"title": "Read 10 pages", "focus_area": "mindset", "time_slot": "evening", "xp_value": 20, "description": "Feed your mind", "scheduled_time": "22:00"},
    ]
    now = now_iso()
    docs = [
        {**d, "id": str(uuid.uuid4()), "recurring": True, "reminder_enabled": True, "is_default": True, "created_at": now}
        for d in defaults
    ]
    await db.tasks.insert_many(docs)
    for d in docs:
        d.pop("_id", None)
    return {"seeded": True, "count": len(docs)}


# ------------------------------------------------------------------
# Sleep Coach Mini-App
# ------------------------------------------------------------------
SLEEP_USER_ID = "main"  # single-user mode

SLEEP_QUESTIONS = [
    {"id": "struggle_level", "type": "scale", "min": 1, "max": 10, "q": "How much do you struggle to fall asleep at night? (1 = never, 10 = every night)"},
    {"id": "avg_hours", "type": "scale", "min": 3, "max": 12, "q": "How many hours of sleep do you typically get?"},
    {"id": "bedtime", "type": "time", "q": "What time do you usually try to go to bed?"},
    {"id": "wake_time", "type": "time", "q": "What time do you usually wake up?"},
    {"id": "wakes_at_night", "type": "single", "options": ["Never", "Sometimes", "Often", "Every night"], "q": "Do you wake up during the night?"},
    {"id": "racing_thoughts", "type": "single", "options": ["Rarely", "Sometimes", "Often", "Always"], "q": "How often do racing thoughts keep you awake?"},
    {"id": "screens_before_bed", "type": "single", "options": ["No screens 1+ hr", "30 min before", "Right up to bed", "In bed"], "q": "When do you stop using screens before bed?"},
    {"id": "caffeine_cutoff", "type": "single", "options": ["Morning only", "Before 2pm", "Before 6pm", "Anytime / no limit"], "q": "When is your last caffeine of the day?"},
    {"id": "alcohol", "type": "single", "options": ["Never", "Occasionally", "A few nights/week", "Most nights"], "q": "How often do you drink alcohol in the evening?"},
    {"id": "exercise", "type": "single", "options": ["Daily", "A few times/week", "Rarely", "Never"], "q": "How often do you exercise?"},
    {"id": "exercise_time", "type": "single", "options": ["Morning", "Afternoon", "Evening", "Late night", "I don't exercise"], "q": "When do you usually exercise?"},
    {"id": "room_temp", "type": "single", "options": ["Cool (60-67°F)", "Comfortable", "Warm", "Hot"], "q": "How warm is your bedroom at night?"},
    {"id": "room_dark", "type": "single", "options": ["Pitch black", "Mostly dark", "Some light", "Lots of light"], "q": "How dark is your bedroom?"},
    {"id": "noise", "type": "single", "options": ["Silent", "White noise", "Some noise", "Very noisy"], "q": "How quiet is your sleep environment?"},
    {"id": "relaxing_activities", "type": "multi", "options": ["Reading", "Drawing", "Journaling", "Music", "Podcasts", "Meditation", "Stretching", "Bath/shower", "Tea", "Breathing exercises"], "q": "What activities do you find relaxing? (pick all that apply)"},
    {"id": "likes_milk", "type": "single", "options": ["Love it", "It's okay", "Don't really like it", "Lactose intolerant"], "q": "Do you like drinking milk?"},
    {"id": "warm_drinks", "type": "multi", "options": ["Chamomile tea", "Warm milk", "Honey water", "Decaf coffee", "Herbal tea", "I don't drink warm drinks"], "q": "Which warm drinks would you enjoy before bed?"},
    {"id": "tried_before", "type": "text", "q": "Anything you've tried that helped (or didn't)? (optional)"},
    {"id": "main_goal", "type": "single", "options": ["Fall asleep faster", "Sleep through the night", "Wake up rested", "Sleep more hours", "All of the above"], "q": "Your main sleep goal?"},
]


class SleepOnboardingPayload(BaseModel):
    answers: dict


class SleepCheckinPayload(BaseModel):
    rating: int  # 1-10 quality
    hours: Optional[float] = None
    notes: Optional[str] = ""


class SleepChatPayload(BaseModel):
    message: str


def _sleep_user_filter():
    return {"user_id": SLEEP_USER_ID}


async def _generate_sleep_plan(answers: dict) -> dict:
    """Use LLM to generate a personalized sleep plan + routine items based on answers."""
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            return _fallback_plan(answers)

        system = (
            "You are an expert evidence-based sleep coach (CBT-I trained). "
            "Generate a JSON object with exactly two keys: "
            "'plan' (a friendly markdown string ~250 words with 4-6 specific personalized recommendations based on the user's answers), "
            "and 'routine' (a JSON array of 4-7 routine items, each with keys: time (e.g. '9:00 PM' or '~30 min before bed'), title (short), description (1 sentence), icon (one of: 'bed','moon','book','musical-notes','water','cafe','flame','walk','leaf','time','phone-portrait','flash-off')). "
            "Pull only from the activities and drinks the user actually likes. "
            "Use evidence-based interventions: stimulus control, sleep restriction, cool dark room (60-67°F), "
            "screen cutoff, caffeine cutoff (8+ hrs before bed), wind-down routine, breathing exercises (4-7-8 box breathing), "
            "consistent wake time, light morning exposure. "
            "Do NOT recommend warm milk or herbal teas the user dislikes or is intolerant to. "
            "Output strict JSON only, no markdown fences."
        )
        user_text = f"User's sleep questionnaire answers:\n{answers}\n\nGenerate the personalized JSON plan now."

        chat = LlmChat(
            api_key=api_key,
            session_id=f"sleep-plan-{uuid.uuid4()}",
            system_message=system,
        ).with_model("openai", "gpt-4o-mini")

        response = await chat.send_message(UserMessage(text=user_text))
        # Try to extract JSON
        import json, re
        text = response.strip()
        # strip code fences if any
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        try:
            data = json.loads(text)
            if "plan" in data and "routine" in data:
                return data
        except Exception:
            logger.exception("LLM JSON parse failed; raw=%s", text[:500])
        return _fallback_plan(answers)
    except Exception:
        logger.exception("sleep plan LLM failure")
        return _fallback_plan(answers)


def _fallback_plan(answers: dict) -> dict:
    likes_milk = answers.get("likes_milk") in ("Love it", "It's okay")
    relax = answers.get("relaxing_activities") or []
    warm_drinks = answers.get("warm_drinks") or []
    routine = [
        {"time": "~3 hours before bed", "title": "Caffeine cutoff", "description": "No coffee, tea or energy drinks. Caffeine has a 5-6 hour half-life.", "icon": "flash-off"},
        {"time": "~1 hour before bed", "title": "Dim the lights", "description": "Lower lights & switch screens to night mode to cue melatonin release.", "icon": "moon"},
        {"time": "~45 min before bed", "title": "Light stretch", "description": "5-10 min of gentle stretches to release muscle tension.", "icon": "walk"},
        {"time": "~30 min before bed", "title": "Wind-down activity", "description": f"Try {(relax[0] if relax else 'reading')} — calming, no screens.", "icon": "book"},
    ]
    if likes_milk or "Warm milk" in warm_drinks:
        routine.append({"time": "~20 min before bed", "title": "Warm milk", "description": "Tryptophan + ritual = signal to your brain it's bedtime.", "icon": "cafe"})
    elif warm_drinks and "I don't drink warm drinks" not in warm_drinks:
        routine.append({"time": "~20 min before bed", "title": warm_drinks[0], "description": "A warm caffeine-free drink helps trigger sleepiness.", "icon": "cafe"})
    routine.append({"time": "In bed", "title": "4-7-8 Breathing", "description": "Inhale 4s, hold 7s, exhale 8s. Repeat 4 times. Activates parasympathetic.", "icon": "leaf"})
    plan = (
        "**Your personalized sleep plan**\n\n"
        "Based on your answers, here's an evidence-based routine tuned to you:\n\n"
        "1. **Consistent schedule** — same wake time every day (yes, weekends too) anchors your circadian rhythm.\n"
        "2. **Cool, dark room** — aim for 60-67°F and blackout darkness; even small amounts of light fragment sleep.\n"
        "3. **Wind-down ritual** — pick activities you actually enjoy from your relaxing list and do them every night.\n"
        "4. **No screens 30-60 min before bed** — blue light suppresses melatonin.\n"
        "5. **Caffeine cutoff at least 8 hours before bed** — even if you don't feel it, it disrupts deep sleep.\n"
        "6. **If you can't sleep in 20 min, get out of bed** — read a paper book in dim light then come back. Don't lie there worrying.\n\n"
        "Your routine card on the right has timing tuned to *you*. Tap the Coach tab when something isn't working — we'll iterate."
    )
    return {"plan": plan, "routine": routine}


async def _build_coach_system(profile: Optional[dict]) -> str:
    base = (
        "You are 'Luna', a warm, evidence-based AI sleep coach. "
        "You sound like a calm, supportive friend who happens to be a CBT-I expert. "
        "Keep replies concise (3-5 sentences usually), use plain language, no medical disclaimers in every message. "
        "Reference the user's specific habits/preferences when relevant. "
        "If they ask for a tip, give one specific, actionable tip with the *why* in 1 sentence. "
        "If they want to change something, suggest a concrete swap. "
        "Never recommend prescription meds or supplements without a doctor. "
        "Encourage consistency over perfection."
    )
    if profile:
        ans = profile.get("answers", {})
        relax = ans.get("relaxing_activities") or []
        likes_milk = ans.get("likes_milk")
        struggle = ans.get("struggle_level")
        bed = ans.get("bedtime")
        wake = ans.get("wake_time")
        base += (
            f"\n\nUser context (use sparingly, don't quote the survey):\n"
            f"- Struggles to fall asleep: {struggle}/10\n"
            f"- Bed/wake target: {bed} → {wake}\n"
            f"- Likes milk: {likes_milk}\n"
            f"- Enjoys: {', '.join(relax) if relax else 'unspecified'}\n"
            f"- Goal: {ans.get('main_goal', 'better sleep')}"
        )
    return base


@api_router.get("/sleep/profile")
async def sleep_profile():
    p = await db.sleep_profile.find_one(_sleep_user_filter(), {"_id": 0})
    if not p:
        return {"onboarded": False, "questions": SLEEP_QUESTIONS}
    # Determine if we should show "How did you sleep?" prompt:
    # show if last check-in was for a date earlier than today.
    last = p.get("last_checkin_date")
    today = today_str()
    show_checkin = last != today
    return {"onboarded": True, "profile": p, "questions": SLEEP_QUESTIONS, "show_checkin_prompt": show_checkin}


@api_router.post("/sleep/onboarding")
async def sleep_onboarding(body: SleepOnboardingPayload):
    answers = body.answers or {}
    plan_obj = await _generate_sleep_plan(answers)
    doc = {
        "user_id": SLEEP_USER_ID,
        "answers": answers,
        "plan": plan_obj.get("plan", ""),
        "routine": plan_obj.get("routine", []),
        "check_ins": [],
        "last_checkin_date": None,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.sleep_profile.replace_one(_sleep_user_filter(), doc, upsert=True)
    # also clear chat history on fresh onboarding
    await db.sleep_chat.delete_many(_sleep_user_filter())
    saved = await db.sleep_profile.find_one(_sleep_user_filter(), {"_id": 0})
    return {"profile": saved}


@api_router.post("/sleep/regenerate")
async def sleep_regenerate(body: Optional[SleepChatPayload] = None):
    p = await db.sleep_profile.find_one(_sleep_user_filter(), {"_id": 0})
    if not p:
        raise HTTPException(404, "Onboard first")
    feedback = (body.message if body else "") or ""
    answers = dict(p.get("answers", {}))
    if feedback:
        answers["_recent_feedback"] = feedback
    plan_obj = await _generate_sleep_plan(answers)
    await db.sleep_profile.update_one(
        _sleep_user_filter(),
        {"$set": {"plan": plan_obj.get("plan", ""), "routine": plan_obj.get("routine", []), "updated_at": now_iso()}},
    )
    saved = await db.sleep_profile.find_one(_sleep_user_filter(), {"_id": 0})
    return {"profile": saved}


@api_router.post("/sleep/checkin")
async def sleep_checkin(body: SleepCheckinPayload):
    p = await db.sleep_profile.find_one(_sleep_user_filter())
    if not p:
        raise HTTPException(404, "Onboard first")
    entry = {
        "date": today_str(),
        "rating": int(body.rating),
        "hours": body.hours,
        "notes": body.notes or "",
        "ts": now_iso(),
    }
    await db.sleep_profile.update_one(
        _sleep_user_filter(),
        {"$push": {"check_ins": {"$each": [entry], "$slice": -60}}, "$set": {"last_checkin_date": entry["date"], "updated_at": now_iso()}},
    )
    return {"saved": True, "entry": entry}


@api_router.get("/sleep/chat")
async def sleep_chat_history():
    msgs = await db.sleep_chat.find(_sleep_user_filter(), {"_id": 0}).sort("ts", 1).to_list(500)
    return {"messages": msgs}


@api_router.post("/sleep/chat")
async def sleep_chat_send(body: SleepChatPayload):
    text = (body.message or "").strip()
    if not text:
        raise HTTPException(400, "Empty message")
    profile = await db.sleep_profile.find_one(_sleep_user_filter(), {"_id": 0})
    # save user message
    user_msg = {"user_id": SLEEP_USER_ID, "role": "user", "content": text, "ts": now_iso()}
    await db.sleep_chat.insert_one(dict(user_msg))

    reply = ""
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            reply = "(LLM key not configured — please ask the agent for help.)"
        else:
            system = await _build_coach_system(profile)
            # Use the existing chat history as context (last 20 turns for token budget)
            history = await db.sleep_chat.find(_sleep_user_filter(), {"_id": 0}).sort("ts", 1).to_list(500)
            # We'll roll history into the system prompt as a compact transcript
            recent = history[-20:]
            transcript = "\n".join(
                f"{m['role'].upper()}: {m['content']}" for m in recent[:-1]  # exclude the just-saved user msg
            )
            sys_with_history = system + (f"\n\n--- Recent conversation ---\n{transcript}" if transcript else "")
            chat = LlmChat(
                api_key=api_key,
                session_id=f"sleep-chat-{SLEEP_USER_ID}-{uuid.uuid4()}",
                system_message=sys_with_history,
            ).with_model("openai", "gpt-4o-mini")
            reply = await chat.send_message(UserMessage(text=text))
    except Exception:
        logger.exception("sleep chat LLM failed")
        reply = "Sorry, I had a hiccup connecting just now. Try again in a sec — I'm here when you need me."

    asst_msg = {"user_id": SLEEP_USER_ID, "role": "assistant", "content": reply, "ts": now_iso()}
    await db.sleep_chat.insert_one(dict(asst_msg))
    user_msg.pop("_id", None)
    asst_msg.pop("_id", None)
    return {"user": user_msg, "assistant": asst_msg}


@api_router.post("/sleep/reset")
async def sleep_reset():
    await db.sleep_profile.delete_many(_sleep_user_filter())
    await db.sleep_chat.delete_many(_sleep_user_filter())
    return {"reset": True}


@api_router.get("/sleep/health-mock")
async def sleep_health_mock():
    """Simulated health-app data while real HealthKit/Health Connect is gated behind a native build."""
    import random
    rng = random.Random(today_str())  # deterministic for the day
    nights = []
    for i in range(7):
        d = (datetime.now(timezone.utc).date() - timedelta(days=6 - i))
        total = round(rng.uniform(5.5, 8.4), 1)
        deep = round(total * rng.uniform(0.13, 0.22), 1)
        rem = round(total * rng.uniform(0.18, 0.27), 1)
        light = round(total - deep - rem, 1)
        nights.append({
            "date": d.isoformat(),
            "day": d.strftime("%a"),
            "total_hours": total,
            "deep_hours": deep,
            "rem_hours": rem,
            "light_hours": max(light, 0.1),
            "score": int(rng.uniform(62, 92)),
        })
    avg_total = round(sum(n["total_hours"] for n in nights) / len(nights), 1)
    avg_score = int(sum(n["score"] for n in nights) / len(nights))
    return {
        "connected": False,
        "source": "Simulated data",
        "nights": nights,
        "avg_total_hours": avg_total,
        "avg_score": avg_score,
        "best_night": max(nights, key=lambda n: n["score"]),
        "worst_night": min(nights, key=lambda n: n["score"]),
    }


# ------------------------------------------------------------------
# App setup
# ------------------------------------------------------------------
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
