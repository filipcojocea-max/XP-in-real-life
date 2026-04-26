"""
Challenge Tasks mini-app — content pool & deterministic daily picks.

We don't store challenges per-user; instead we deterministically pick today's
quote and challenge from the pools below using `(user_id, date)` as the seed.
That guarantees:
  * everyone gets a different daily challenge from each other (anti-comparison)
  * each user sees the same challenge for the entire day
  * across days, challenges cycle without repeats for at least len(pool) days
"""
from __future__ import annotations
import hashlib
from datetime import date as _date

# ─────────────────── 35+ Challenges ───────────────────
CHALLENGES: list[dict] = [
    {
        "id": "uncomfortable",
        "title": "Do Something Uncomfortable",
        "tagline": "Lean into the resistance.",
        "description": (
            "Do that thing you've been avoiding. Send the text. Make the call. "
            "Start the task. If you've been hesitating, just do it. Discomfort is "
            "the price of growth — and you'll feel proud the moment after."
        ),
        "icon": "flash",
        "tags": ["courage", "growth"],
    },
    {
        "id": "clean_environment",
        "title": "Keep Your Environment Clean",
        "tagline": "Your space mirrors your mind.",
        "description": (
            "Today, organize the space you spend most of your time in — your "
            "room, desk, or workspace. A clean environment quiets the mind. If "
            "your space is messy, your thoughts will be messy too."
        ),
        "icon": "sparkles",
        "tags": ["discipline", "focus"],
    },
    {
        "id": "no_cheap_dopamine",
        "title": "Avoid Cheap Dopamine",
        "tagline": "Earn your highs.",
        "description": (
            "No porn, infinite scrolling, binge-watching, or anything that "
            "rewards your brain for doing nothing. Cheap dopamine kills your "
            "discipline and makes real work feel 10× harder. One day clean."
        ),
        "icon": "ban",
        "tags": ["discipline", "focus"],
    },
    {
        "id": "willing_helper",
        "title": "Be a Willing Helper",
        "tagline": "Show up when called.",
        "description": (
            "Today, when someone asks something of you, do it without resistance. "
            "Even if you're tired. Even if it's inconvenient. Humble yourself "
            "and serve. The reward is knowing you showed up when it was hard."
        ),
        "icon": "people",
        "tags": ["service", "humility"],
    },
    {
        "id": "kind_act",
        "title": "Do a Kind Act",
        "tagline": "From the heart, not the wallet.",
        "description": (
            "Show kindness to someone today. It doesn't need to cost money — "
            "compliment an outfit, make someone a coffee, hold a door, send a "
            "thoughtful text. Real kindness comes from the heart, not the price tag."
        ),
        "icon": "heart",
        "tags": ["kindness", "social"],
    },
    {
        "id": "serve_one_person",
        "title": "Serve One Person All Day",
        "tagline": "Pour into someone you love.",
        "description": (
            "Pick one person and pour into them today. Spend time with them, "
            "listen, serve, support. Not because you have to — because you "
            "want to. Show them they matter."
        ),
        "icon": "rose",
        "tags": ["love", "service"],
    },
    {
        "id": "cold_shower",
        "title": "Take a Cold Shower",
        "tagline": "60 seconds of discomfort.",
        "description": (
            "End your shower with at least 60 seconds of cold water. It's "
            "uncomfortable. That's the point. Cold exposure builds mental "
            "toughness, releases dopamine, and proves you can do hard things."
        ),
        "icon": "snow",
        "tags": ["discipline", "health"],
    },
    {
        "id": "early_wake",
        "title": "Wake Up 30 Minutes Earlier",
        "tagline": "Steal time from the day.",
        "description": (
            "Wake up at least 30 minutes earlier than usual today. Use those "
            "minutes for something that matters — exercise, reading, planning. "
            "Winning the morning is winning the day."
        ),
        "icon": "alarm",
        "tags": ["discipline", "morning"],
    },
    {
        "id": "read_pages",
        "title": "Read 10 Pages",
        "tagline": "Feed your mind.",
        "description": (
            "Read at least 10 pages of a non-fiction book today. Knowledge "
            "compounds. 10 pages a day = 18 books a year. Future you will "
            "thank you."
        ),
        "icon": "book",
        "tags": ["growth", "learning"],
    },
    {
        "id": "phone_away",
        "title": "Phone in Another Room",
        "tagline": "Reclaim your focus.",
        "description": (
            "For at least 2 hours today, put your phone in a different room. "
            "Notice what comes up — boredom, anxiety, ideas. Your phone steals "
            "your attention. Today, take it back."
        ),
        "icon": "phone-portrait",
        "tags": ["focus", "presence"],
    },
    {
        "id": "eye_contact",
        "title": "Make Eye Contact",
        "tagline": "Be fully present.",
        "description": (
            "In every conversation today, hold steady eye contact. Not creepy "
            "— warm and present. People feel seen, and you'll come across as "
            "confident and engaged."
        ),
        "icon": "eye",
        "tags": ["social", "confidence"],
    },
    {
        "id": "walk_outside",
        "title": "Walk Outside for 30 Minutes",
        "tagline": "Move and breathe.",
        "description": (
            "30 minutes outdoors. No headphones — or just one earbud at most. "
            "Let your mind wander. Sunlight regulates your circadian rhythm and "
            "movement clears your head."
        ),
        "icon": "walk",
        "tags": ["health", "presence"],
    },
    {
        "id": "compliment_strangers",
        "title": "Compliment 3 Strangers",
        "tagline": "Plant tiny seeds of joy.",
        "description": (
            "Today, give 3 genuine compliments to people you don't know — a "
            "cashier's smile, someone's style, a kid's manners. Watch their "
            "face light up. Watch yours do the same."
        ),
        "icon": "happy",
        "tags": ["kindness", "social"],
    },
    {
        "id": "no_social_media",
        "title": "No Social Media All Day",
        "tagline": "Detox the algorithm.",
        "description": (
            "Don't open Instagram, TikTok, X/Twitter, Facebook, or YouTube "
            "shorts today. None. See how much of your day was wasted on dopamine "
            "loops. Reclaim the hours."
        ),
        "icon": "ban",
        "tags": ["discipline", "focus"],
    },
    {
        "id": "mindful_meal",
        "title": "Eat One Mindful Meal",
        "tagline": "No screens. Just food.",
        "description": (
            "Eat at least one meal today with zero screens — no phone, no TV, "
            "no laptop. Just you and the food. Notice the taste, the texture, "
            "your body's signals. Rare in modern life. Try it."
        ),
        "icon": "restaurant",
        "tags": ["presence", "health"],
    },
    {
        "id": "appreciation_message",
        "title": "Send an Appreciation Message",
        "tagline": "Tell them while you can.",
        "description": (
            "Write a heartfelt message to someone who's shaped your life — a "
            "parent, friend, mentor, teacher. Tell them specifically what you "
            "appreciate. Don't wait for a funeral to speak love."
        ),
        "icon": "mail",
        "tags": ["love", "social"],
    },
    {
        "id": "tackle_procrastination",
        "title": "Eat the Frog",
        "tagline": "Hardest thing first.",
        "description": (
            "That task you've been pushing off all week? Do it FIRST today — "
            "before email, before meetings, before anything else. Once it's "
            "done, the rest of the day feels light."
        ),
        "icon": "rocket",
        "tags": ["discipline", "productivity"],
    },
    {
        "id": "fifty_pushups",
        "title": "50 Push-Ups Total",
        "tagline": "Earn your strength.",
        "description": (
            "Do 50 push-ups today, split into as many sets as you need. On your "
            "knees if you need to. Strength compounds. Start where you are."
        ),
        "icon": "barbell",
        "tags": ["fitness", "discipline"],
    },
    {
        "id": "honest_conversation",
        "title": "Have an Honest Conversation",
        "tagline": "Truth is freedom.",
        "description": (
            "Have one conversation today where you say what you actually think "
            "and feel — kindly, but honestly. The conversation you've been "
            "rehearsing in your head. Have it. Out loud."
        ),
        "icon": "chatbubbles",
        "tags": ["courage", "social"],
    },
    {
        "id": "call_family",
        "title": "Call a Family Member",
        "tagline": "Reach out first.",
        "description": (
            "Call (not text) a family member you haven't spoken to in a while. "
            "Even 10 minutes. Tell them you were thinking of them. Be the one "
            "who reaches out first."
        ),
        "icon": "call",
        "tags": ["love", "social"],
    },
    {
        "id": "silence",
        "title": "15 Minutes of Silence",
        "tagline": "Hear yourself think.",
        "description": (
            "Sit in complete silence for 15 minutes. No phone, no music, no "
            "podcast. Just you and your mind. It will feel weird. Stay with it. "
            "Insights live on the other side of stillness."
        ),
        "icon": "leaf",
        "tags": ["presence", "growth"],
    },
    {
        "id": "try_new",
        "title": "Try Something New",
        "tagline": "Stay a beginner.",
        "description": (
            "Today, try one thing you've never done before. A new food, route, "
            "exercise, recipe, app. Tiny novelty keeps your brain young and "
            "your life expanding."
        ),
        "icon": "compass",
        "tags": ["growth", "courage"],
    },
    {
        "id": "forgive",
        "title": "Forgive Someone",
        "tagline": "Free yourself first.",
        "description": (
            "Pick one person you've been holding resentment toward. Today, "
            "release them — silently is fine. Forgiveness isn't for them, it's "
            "for you. Stop carrying that weight."
        ),
        "icon": "heart",
        "tags": ["growth", "freedom"],
    },
    {
        "id": "gratitude_five",
        "title": "List 5 Things You're Grateful For",
        "tagline": "Rewire toward abundance.",
        "description": (
            "Write down 5 specific things you're grateful for today. Not 'my "
            "family' — 'the way my mom laughs'. Specific gratitude rewires "
            "your brain to notice what's good."
        ),
        "icon": "leaf",
        "tags": ["mindset", "growth"],
    },
    {
        "id": "deep_work",
        "title": "90 Minutes of Deep Work",
        "tagline": "One task. Full focus.",
        "description": (
            "Pick ONE important task. Phone in another room, no tabs, no "
            "interruptions. 90 minutes of pure focus. Most people don't do this "
            "in a week. Do it today."
        ),
        "icon": "flash",
        "tags": ["focus", "productivity"],
    },
    {
        "id": "early_bedtime",
        "title": "In Bed by 10pm",
        "tagline": "Tomorrow starts tonight.",
        "description": (
            "Be in bed (lights off, phone away) by 10pm tonight. No exceptions. "
            "A great day starts with a great night. Sleep is the cheapest "
            "performance enhancer there is."
        ),
        "icon": "moon",
        "tags": ["health", "discipline"],
    },
    {
        "id": "water_only",
        "title": "Drink Only Water",
        "tagline": "No sugar. No caffeine. Just water.",
        "description": (
            "Today, drink only water. No coffee, soda, juice, energy drinks. "
            "Notice how often you reach for a flavored drink out of habit. "
            "Your body will thank you."
        ),
        "icon": "water",
        "tags": ["health", "discipline"],
    },
    {
        "id": "speak_up",
        "title": "Speak Up",
        "tagline": "Your voice matters.",
        "description": (
            "Today, speak up in a moment when you'd normally stay quiet — share "
            "an idea in a meeting, voice a preference, ask the question. Your "
            "voice is needed. Use it."
        ),
        "icon": "megaphone",
        "tags": ["courage", "confidence"],
    },
    {
        "id": "apologize",
        "title": "Apologize Sincerely",
        "tagline": "Repair the bridge.",
        "description": (
            "Apologize to someone you've wronged — even if it was small, even "
            "if it was years ago. No excuses, no 'but'. Just 'I'm sorry, I was "
            "wrong, and I'll do better.'"
        ),
        "icon": "hand-left",
        "tags": ["humility", "growth"],
    },
    {
        "id": "smile_at_strangers",
        "title": "Smile at Strangers",
        "tagline": "Light up the room.",
        "description": (
            "Smile at every stranger you make eye contact with today. It's "
            "tiny, it's free, and it changes the room. Even if they don't "
            "smile back, your day will be better."
        ),
        "icon": "happy",
        "tags": ["kindness", "social"],
    },
    {
        "id": "pick_up_trash",
        "title": "Pick Up Trash You Didn't Drop",
        "tagline": "Leave it better than you found it.",
        "description": (
            "Pick up at least one piece of trash today that you didn't drop "
            "and dispose of it properly. The world is a little cleaner because "
            "you were here."
        ),
        "icon": "trash",
        "tags": ["service", "kindness"],
    },
    {
        "id": "hold_doors",
        "title": "Hold the Door for 5 Strangers",
        "tagline": "Tiny acts. Big habit.",
        "description": (
            "Hold the door open for at least 5 people today. Watch their faces. "
            "Notice the gratitude. Civility is contagious — be patient zero."
        ),
        "icon": "people",
        "tags": ["kindness", "social"],
    },
    {
        "id": "childhood_joy",
        "title": "Do Something You Loved as a Kid",
        "tagline": "Reconnect with play.",
        "description": (
            "Do one thing today that made you happy as a child — drawing, "
            "biking, climbing a tree, playing a game. Adulthood has us forget "
            "how to play. Remember today."
        ),
        "icon": "color-palette",
        "tags": ["joy", "growth"],
    },
    {
        "id": "teach_someone",
        "title": "Teach Someone Something",
        "tagline": "Pass it on.",
        "description": (
            "Help someone learn something today — explain a concept, teach a "
            "skill, mentor a friend. Teaching deepens your own understanding. "
            "Generosity multiplies."
        ),
        "icon": "school",
        "tags": ["service", "growth"],
    },
    {
        "id": "small_fear",
        "title": "Confront a Small Fear",
        "tagline": "Courage is a muscle.",
        "description": (
            "Pick one small fear and face it today. Make the awkward call. "
            "Try the new gym. Speak in the meeting. Courage isn't fearlessness "
            "— it's action despite fear."
        ),
        "icon": "shield-checkmark",
        "tags": ["courage", "growth"],
    },
    {
        "id": "cook_meal",
        "title": "Cook a Real Meal",
        "tagline": "Feed yourself well.",
        "description": (
            "Cook one real meal from scratch today — no microwave, no "
            "delivery. Even something simple. Feeding yourself well is one of "
            "the most basic forms of self-respect."
        ),
        "icon": "restaurant",
        "tags": ["health", "self-care"],
    },
    {
        "id": "sit_with_emotion",
        "title": "Sit With a Difficult Emotion",
        "tagline": "Don't run. Don't numb.",
        "description": (
            "When a hard feeling shows up today — anger, sadness, anxiety — "
            "don't reach for your phone or food or distraction. Sit with it for "
            "5 minutes. Breathe. Let it move through you."
        ),
        "icon": "leaf",
        "tags": ["growth", "presence"],
    },
    {
        "id": "plan_tomorrow",
        "title": "Plan Tomorrow Tonight",
        "tagline": "Wake up with a mission.",
        "description": (
            "Before bed tonight, write down your top 3 priorities for "
            "tomorrow. Just 3. Wake up with a mission instead of waking up to "
            "react to others' priorities."
        ),
        "icon": "list",
        "tags": ["productivity", "discipline"],
    },
    {
        "id": "journal_wins",
        "title": "Journal Your Wins",
        "tagline": "Pat yourself on the back.",
        "description": (
            "Spend 10 minutes writing down your wins this past week — big or "
            "tiny. Most of us are blind to our progress. Write it down. See "
            "how far you've come."
        ),
        "icon": "trophy",
        "tags": ["mindset", "growth"],
    },
    {
        "id": "breathwork",
        "title": "5 Minutes of Box Breathing",
        "tagline": "Reset your nervous system.",
        "description": (
            "Inhale 4s, hold 4s, exhale 4s, hold 4s. Repeat for 5 minutes. "
            "Box breathing activates your parasympathetic nervous system — "
            "instant calm, anywhere, free."
        ),
        "icon": "leaf",
        "tags": ["health", "presence"],
    },
]

# ─────────────────── 30+ Daily Quotes ───────────────────
QUOTES: list[dict] = [
    {"text": "The cave you fear to enter holds the treasure you seek.", "author": "Joseph Campbell"},
    {"text": "Discipline equals freedom.", "author": "Jocko Willink"},
    {"text": "You don't rise to the level of your goals — you fall to the level of your systems.", "author": "James Clear"},
    {"text": "Hard choices, easy life. Easy choices, hard life.", "author": "Jerzy Gregorek"},
    {"text": "Comparison is the thief of joy.", "author": "Theodore Roosevelt"},
    {"text": "Be the change you wish to see in the world.", "author": "Mahatma Gandhi"},
    {"text": "Action is the antidote to despair.", "author": "Joan Baez"},
    {"text": "Don't count the days. Make the days count.", "author": "Muhammad Ali"},
    {"text": "He who has a why to live for can bear almost any how.", "author": "Friedrich Nietzsche"},
    {"text": "Pain is inevitable. Suffering is optional.", "author": "Haruki Murakami"},
    {"text": "What you do every day matters more than what you do once in a while.", "author": "Gretchen Rubin"},
    {"text": "The successful warrior is the average person — with laser-like focus.", "author": "Bruce Lee"},
    {"text": "Tomorrow is a mystery. Today is a gift. That's why it's called the present.", "author": "Bil Keane"},
    {"text": "You are not stuck. You are committed to certain patterns.", "author": "Anthony Robbins"},
    {"text": "The best time to plant a tree was 20 years ago. The second best time is now.", "author": "Chinese Proverb"},
    {"text": "We are what we repeatedly do. Excellence is not an act, but a habit.", "author": "Aristotle"},
    {"text": "Stop waiting for someday. Today is the day.", "author": "Anonymous"},
    {"text": "Be so good they can't ignore you.", "author": "Steve Martin"},
    {"text": "If it doesn't challenge you, it doesn't change you.", "author": "Fred DeVito"},
    {"text": "You are not your thoughts. You are the awareness behind them.", "author": "Eckhart Tolle"},
    {"text": "Start where you are. Use what you have. Do what you can.", "author": "Arthur Ashe"},
    {"text": "Don't wish it were easier. Wish you were better.", "author": "Jim Rohn"},
    {"text": "You become what you give your attention to.", "author": "Epictetus"},
    {"text": "It always seems impossible until it's done.", "author": "Nelson Mandela"},
    {"text": "The only person you should try to be better than is the person you were yesterday.", "author": "Anonymous"},
    {"text": "Either you run the day, or the day runs you.", "author": "Jim Rohn"},
    {"text": "The man who moves a mountain begins by carrying away small stones.", "author": "Confucius"},
    {"text": "Whether you think you can or you can't — you're right.", "author": "Henry Ford"},
    {"text": "Do what is right, not what is easy.", "author": "Anonymous"},
    {"text": "Strength does not come from physical capacity. It comes from an indomitable will.", "author": "Mahatma Gandhi"},
    {"text": "Fall seven times. Stand up eight.", "author": "Japanese Proverb"},
    {"text": "Success is not final, failure is not fatal — the courage to continue is what counts.", "author": "Winston Churchill"},
    {"text": "If you are not willing to risk the usual, you will have to settle for the ordinary.", "author": "Jim Rohn"},
    {"text": "What lies behind us and what lies before us are tiny matters compared to what lies within us.", "author": "Ralph Waldo Emerson"},
    {"text": "The only way out is through.", "author": "Robert Frost"},
]


def _seeded_index(user_id: str, day: _date, n: int, salt: str = "") -> int:
    """Deterministic index in [0, n) from (user_id, day, salt)."""
    s = f"{user_id}|{day.isoformat()}|{salt}"
    h = hashlib.sha256(s.encode()).digest()
    # Take first 4 bytes as int
    val = int.from_bytes(h[:4], "big")
    return val % max(1, n)


def get_today_quote(user_id: str, day: _date | None = None) -> dict:
    day = day or _date.today()
    return QUOTES[_seeded_index(user_id, day, len(QUOTES), salt="quote")]


def get_today_challenge(user_id: str, day: _date | None = None) -> dict:
    day = day or _date.today()
    return CHALLENGES[_seeded_index(user_id, day, len(CHALLENGES), salt="challenge")]


def find_challenge(challenge_id: str) -> dict | None:
    for c in CHALLENGES:
        if c["id"] == challenge_id:
            return c
    return None
