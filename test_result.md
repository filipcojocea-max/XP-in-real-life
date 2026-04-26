#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: "Test the 4 newly-added/modified backend features: 200-level XP system (/api/levels), un-tick (uncomplete) restored, custom task XP cap = 20 (defaults unrestricted), anonymous mode via X-Anonymous-Id header."

backend:
  - task: "200-level XP system (/api/levels) + level field in profile reflects XP curve"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "PASS — GET /api/levels returns max_level=200, total_xp_cap=1000000, formula='cum_xp(L) = round(49.6 * L^1.87)', and a 200-entry list with {level, cum_xp, delta_to_reach}. L1 cum=0, L50 cum=74569 (within 73000-76000 spec band), L200 cum=996340 (within 990000-1000000 band). Profile.level computed via level_from_xp() returns 1 for a fresh user, increments via task completes. Note: spec line 'with 1000 XP level should be 5 (since L5 cum_xp=1006)' is internally inconsistent — 1000 < 1006, so the correct level is 4, which is exactly what the backend returns. The formula and table are correct; the spec sentence has a typo. No action needed on backend."

  - task: "Un-tick / uncomplete refunds XP (POST /api/tasks/{id}/uncomplete)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "PASS — Registered new user, completed default 'Morning reflection' task → +15 XP awarded. POST /tasks/{id}/uncomplete with body {date:'2026-04-26'} returned 200 with {profile, xp_removed:15}. GET /profile shows total_xp rolled back to 0. GET /tasks shows the task as completed=false again. Once-per-day block is intentionally NOT enforced any more (matches review request: un-tick restored)."

  - task: "Custom task XP cap = 20 (POST/PUT) — defaults unrestricted"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "PASS — POST /api/tasks with xp_value=150 → response xp_value=20 (capped). xp_value=10 → 10 (unchanged). xp_value=20 → 20. PUT custom task with xp_value=999 → 20 (capped). PUT default task ('Morning reflection (5 min)') with xp_value=80 → 80 (NOT capped — defaults bypass the cap as required). Fresh user's seeded defaults remain at original 10-40 XP values [15, 40, 10, 30, 15, 20, 10, 20], including 'Workout session' at 40 XP. Both POST (line 808 max(5, min(20, body.xp_value))) and PUT (line 836 'if not existing.get(is_default)') correctly differentiate custom vs default."

  - task: "Anonymous mode via X-Anonymous-Id header (data isolation per device)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "PASS — GET /api/profile without any header returns 200 with the legacy 'main' account. GET /profile with X-Anonymous-Id: device-aaa-<uuid> returns a separate isolated profile (user_id internally 'anon-device-aaa-...'), GET /profile with a different X-Anonymous-Id returns yet another distinct profile. After creating a custom task and completing it on anon A, anon A's total_xp=20 while anon B's total_xp=0 — confirming data isolation. Header value 'ab' (length 2 < 8 minimum) correctly falls back to 'main'. Authenticated request with both Bearer token AND X-Anonymous-Id correctly ignores the header and uses the JWT user_id (returned name matched the registered user, not anon). get_user_or_legacy() in server.py L133-153 implements the priority correctly: JWT > X-Anonymous-Id (if 8-64 chars) > 'main'."

  - task: "Auth + per-user data isolation (register/verify/login/me/resend, JWT, scoped tasks/profile/sleep, 11-task limit, uncomplete blocked, default-delete blocked, wake_time, custom-date tasks)"
    implemented: true
    working: false
    file: "/app/backend/server.py"
    stuck_count: 1
    priority: "high"
    needs_retesting: false
    status_history:
        - working: false
          agent: "testing"
          comment: "Ran full auth + isolation suite via /app/backend_test.py against https://xp-confidence.preview.emergentagent.com/api. 25/26 assertions PASS, 1 CRITICAL FAIL. PASSING: (1) register returns dev_code (no token); (2) verify with wrong code → 400 'Wrong code. Please try again.'; (3) verify with correct dev_code → 200 with token+user; (4) GET /auth/me with Bearer → 200 returns full_name/email/verified=true; (5) GET /auth/me without auth → 401 'Not authenticated'; (6) login with correct creds → 200 with fresh token; (7) login with wrong pw → 401 'Wrong email or password.'; (8) per-user task isolation verified — Carol completed a default task and her profile XP=15 while a freshly-registered Dan has XP=0 and disjoint task ids; (9b) 12th custom task POST returns 400 with the expected 11-quest message; (10) /tasks/{id}/uncomplete returns 400 with once-per-day message; (11) DELETE on a default task returns 400 'Default quests cannot be deleted'; (12) PUT /profile {wake_time:'06:30'} succeeds and GET /profile reflects wake_time='06:30'; (13) GET /tasks?date=2026-04-25 returns 200 with date+tasks list; (14) /auth/resend returns a new dev_code for an unverified user; (15) Carol completes /sleep/onboarding while Dan's /sleep/profile still returns {onboarded:false} confirming sleep is per-user. ❌ CRITICAL FAIL — 11-task limit is NOT user-scoped: in /app/backend/server.py line ~746 `create_task` does `db.tasks.count_documents({\"is_default\": {\"$ne\": True}})` with NO user_id filter. As a result, once any user (or pre-existing legacy data) has ≥11 non-default tasks anywhere in the DB, NO user can create even a single custom task. Dan's #1 custom task POST already returned 400 'You\\'ve hit the 11-quest limit.' because the global custom-task collection already contained ≥11 docs (from earlier tests). FIX: change to `db.tasks.count_documents({\"user_id\": user_id, \"is_default\": {\"$ne\": True}})`. This breaks the per-user isolation contract and is blocking every newly-registered user from creating quests."

  - task: "Tasks API — default vs custom update/delete rules"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "Created /app/backend_test.py covering all 7 scenarios from the review request against the public API (https://xp-confidence.preview.emergentagent.com/api). Pre-existing DB contained tasks seeded before the is_default migration (no is_default flag), so the test performs POST /api/profile/reset followed by POST /api/seed to obtain properly tagged default tasks, then POSTs a custom task. Results: 12/12 assertions PASS. (1) GET /api/tasks returns tagged default + custom tasks. (2) PUT default task with {title, description, xp_value, reminder_enabled} returns 200 and updates those fields while focus_area/time_slot remain unchanged. (3) PUT default task with focus_area / time_slot / scheduled_time each return 400 with message 'Cannot change <field> on a default quest — only title, description, XP and reminder are editable.' (4) DELETE on default task returns 400 with message 'Default quests cannot be deleted — …' and task still present on subsequent GET. (5) PUT custom task with {title, time_slot=evening, focus_area=mindset, scheduled_time=20:00} returns 200 with all fields updated. (6) PUT custom task to time_slot=afternoon, scheduled_time=13:00 returns 200 and GET /api/tasks shows it in the afternoon bucket. (7) DELETE custom task returns 200 {deleted: true} and it disappears from GET /api/tasks. LOCKED_DEFAULT_FIELDS enforcement and default-delete protection are working correctly."

  - task: "Sleep Coach mini-app — full backend flow (profile/onboarding/checkin/chat/regenerate/health-mock/reset)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "Rewrote /app/backend_test.py to cover all 10 sleep endpoints from the review request and ran it against the public ingress (https://xp-confidence.preview.emergentagent.com/api). EMERGENT_LLM_KEY is set in /app/backend/.env and the LLM (openai gpt-4o-mini via emergentintegrations) was reached successfully on every call. Results: 63/63 assertions PASS. Step-by-step: (1) POST /sleep/reset → 200 {reset:true}. (2) GET /sleep/profile (cold) → {onboarded:false, questions:[19 items]}; all expected types present (scale/time/single/multi/text), each q has id/type/q. (3) POST /sleep/onboarding with the realistic 19-field answers payload → 200; profile.plan length=1188 chars, profile.routine has 5 items each with time/title/description/icon, check_ins=[], answers persisted. (4) GET /sleep/profile (warm) → {onboarded:true, profile:{...}, questions:[19], show_checkin_prompt:true}. (5) POST /sleep/checkin {rating:8, hours:7.5, notes:'Slept well'} → 200 {saved:true, entry:{date,rating:8,hours:7.5,notes,ts}}; subsequent GET shows check_ins length=1 and show_checkin_prompt:false. (6) POST /sleep/chat 'What if I can't fall asleep tonight?' → 200; assistant reply 371 chars, contextually appropriate (mentions getting out of bed / quiet activity), not a fallback error. (7) GET /sleep/chat → 2 messages ordered user→assistant. (8) POST /sleep/chat 'Should I take a nap?' → 200; assistant reply 328 chars referencing nap timing. GET /sleep/chat now returns 4 messages confirming multi-turn persistence. (9) POST /sleep/regenerate {message:'milk gives me indigestion, find an alternative'} → 200; new plan length=1023 chars, routine grew from 5 to 7 items, plan text differs from previous, check_ins preserved (still 1). (10) GET /sleep/health-mock → 200 {connected:false, source:'Simulated data', nights:[7 entries each with date/day/total_hours/deep_hours/rem_hours/light_hours/score], avg_total_hours, avg_score, best_night, worst_night}. (11) POST /sleep/reset followed by GET /sleep/profile → onboarded:false; GET /sleep/chat → empty messages array. LLM integration, JSON parsing of plan/routine, MongoDB persistence (sleep_profile + sleep_chat collections), check-in prompt logic, and reset semantics are all working correctly."

metadata:
  created_by: "testing_agent"
  version: "1.1"
  test_sequence: 2
  run_ui: false

test_plan:
  current_focus:
    - "200-level XP system (/api/levels) + level field in profile reflects XP curve"
    - "Un-tick / uncomplete refunds XP (POST /api/tasks/{id}/uncomplete)"
    - "Custom task XP cap = 20 (POST/PUT) — defaults unrestricted"
    - "Anonymous mode via X-Anonymous-Id header (data isolation per device)"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
    - agent: "testing"
      message: "Tested all 4 newly-added/modified backend features against https://xp-confidence.preview.emergentagent.com/api via /app/backend_test.py. 37/38 assertions PASS, 0 critical fails. (1) 200-level XP system: /api/levels returns the full table with max_level=200, total_xp_cap=1000000, formula 'cum_xp(L) = round(49.6 * L^1.87)', L1=0, L50=74569 (in 73000-76000 band), L200=996340 (in 990000-1000000 band). (2) Un-tick: complete + uncomplete round-trip works perfectly — 15 XP awarded then refunded, profile rolls back, task shows completed=false. xp_removed field returned. (3) Custom XP cap=20: POST 150→20, 10→10, 20→20; PUT custom 999→20; PUT default 80→80 (unrestricted); fresh user defaults intact at [15,40,10,30,15,20,10,20]. (4) Anonymous mode: no-header→main, two distinct X-Anonymous-Id values give isolated profiles (anon A xp=20 after task complete, anon B xp=0), too-short ID falls back to main, JWT request ignores the header. The single 'failure' in the test output ('1000 XP -> level 5 per /levels table :: level for 1000 XP = 4') is a SPEC TYPO, not a backend bug — the spec said 'with 1000 XP, level should be 5 (since L5 cum_xp=1006)' but mathematically 1000 < 1006 means level 4, which is what the backend correctly returns. Backend logic is correct. No fixes needed."
    - agent: "testing"
      message: "Ran full backend test suite for the updated Tasks API (/app/backend_test.py). All 12 assertions pass against the public ingress URL. Note: the pre-existing Mongo `tasks` collection had items seeded before the `is_default` migration, so the test resets & re-seeds to obtain properly tagged defaults. If the main agent wants default tasks to persist for end users without requiring a reset, consider a one-time migration that marks existing seeded titles as is_default=true, or change POST /api/seed to upsert the flag on legacy docs. Functionality itself (LOCKED_DEFAULT_FIELDS + delete protection + custom-task full edit/move/delete) is correct."
    - agent: "testing"
      message: "Auth + per-user data isolation tested end-to-end (/app/backend_test.py, 26 assertions, 25 PASS / 1 CRITICAL FAIL). All auth flows work (register→dev_code, verify wrong/correct, /auth/me with+without token, login, login wrong pw, resend), per-user XP isolation verified (Carol XP=15 after completing default; Dan XP=0 with disjoint task ids), once-per-day uncomplete returns 400, default-task DELETE returns 400, wake_time PUT/GET roundtrip works, custom-date /tasks?date=2026-04-25 returns 200, sleep onboarding is per-user (Carol onboarded; Dan onboarded:false). 🚨 CRITICAL BUG — the 11-custom-task limit is NOT user-scoped in /app/backend/server.py L746: `db.tasks.count_documents({\"is_default\": {\"$ne\": True}})` is missing `user_id`. As soon as the global custom-task collection has ≥11 docs (already true on this DB), every newly-registered user is blocked from creating a single custom quest. Fix: change to `db.tasks.count_documents({\"user_id\": user_id, \"is_default\": {\"$ne\": True}})`. Test 9b (the 12th-task block) returns the right 400 message, but test 9a (Dan's 1st custom task) was rejected for the wrong reason because the counter is global. After the one-line fix this whole task should pass."