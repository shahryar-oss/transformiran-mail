// Tasks module — Microsoft To Do-style task management.
// Handles tasks, lists, steps, smart-list queries, My Day reset.

const { pool } = require("./db");

// =====================================================================
// LISTS
// =====================================================================

async function listLists(userId) {
  const r = await pool.query(
    `SELECT l.id, l.name, l.color, l.group_name, l.position, l.created_at,
            (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.completed_at IS NULL)::INT AS open_count
       FROM task_lists l
      WHERE l.user_id = $1
      ORDER BY l.group_name NULLS FIRST, l.position, l.created_at`,
    [userId]
  );
  return r.rows;
}

async function createList(userId, { name, color, group_name }) {
  if (!name || !name.trim()) throw new Error("name_required");
  const r = await pool.query(
    `INSERT INTO task_lists (user_id, name, color, group_name, position)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(position)+1 FROM task_lists WHERE user_id=$1), 0))
     RETURNING id, name, color, group_name, position, created_at`,
    [userId, String(name).slice(0, 120).trim(), color || null, group_name || null]
  );
  return r.rows[0];
}

async function updateList(userId, listId, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const k of ["name", "color", "group_name", "position"]) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      values.push(patch[k]);
    }
  }
  if (!fields.length) return null;
  values.push(userId, listId);
  const r = await pool.query(
    `UPDATE task_lists SET ${fields.join(", ")}, updated_at = NOW()
      WHERE user_id = $${i++} AND id = $${i}
      RETURNING id, name, color, group_name, position`,
    values
  );
  return r.rows[0] || null;
}

async function deleteList(userId, listId) {
  await pool.query(`DELETE FROM task_lists WHERE user_id = $1 AND id = $2`, [userId, listId]);
}

// =====================================================================
// TASKS — CRUD
// =====================================================================

const TASK_COLS = `
  id, list_id, title, notes, due_at, reminder_at, repeat, important,
  in_my_day, my_day_added_at, completed_at, source_message_id,
  source_thread_id, position, created_at, updated_at
`;

// Only persist a known recurrence rule; anything else (incl. "" / junk) → null.
const _VALID_REPEATS = new Set(["daily", "weekdays", "weekly", "monthly", "yearly"]);
function sanitizeRepeat(v) {
  return _VALID_REPEATS.has(v) ? v : null;
}

async function createTask(userId, { title, list_id, notes, due_at, reminder_at, important, in_my_day, source_message_id, source_thread_id, repeat }) {
  if (!title || !title.trim()) throw new Error("title_required");
  const cleanTitle = String(title).slice(0, 500).trim();

  // Dedup: if a non-completed task already exists for this user with the
  // same source_message_id AND the same normalized title, return it instead
  // of creating a duplicate. Catches double-clicks on 'Add to To Do' + the
  // routine wizard re-running over already-processed emails.
  // Completed tasks DON'T block re-creation — user may legitimately want
  // a new instance after marking the old one done.
  if (source_message_id) {
    const dupCheck = await pool.query(
      `SELECT ${TASK_COLS}
         FROM tasks
        WHERE user_id = $1
          AND source_message_id = $2
          AND completed_at IS NULL
          AND LOWER(TRIM(title)) = LOWER($3)
        LIMIT 1`,
      [userId, source_message_id, cleanTitle]
    );
    if (dupCheck.rows[0]) {
      const existing = dupCheck.rows[0];
      existing.deduped = true;
      return existing;
    }
  }

  const r = await pool.query(
    `INSERT INTO tasks (user_id, list_id, title, notes, due_at, reminder_at, repeat, important, in_my_day, my_day_added_at, source_message_id, source_thread_id, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       COALESCE((SELECT MAX(position)+1 FROM tasks WHERE user_id=$1 AND (list_id = $2 OR (list_id IS NULL AND $2 IS NULL))), 0))
     RETURNING ${TASK_COLS}`,
    [
      userId,
      list_id || null,
      cleanTitle,
      notes ? String(notes).slice(0, 8000) : null,
      due_at || null,
      reminder_at || null,
      sanitizeRepeat(repeat),
      !!important,
      !!in_my_day,
      in_my_day ? new Date() : null,
      source_message_id || null,
      source_thread_id || null,
    ]
  );
  return r.rows[0];
}

async function updateTask(userId, taskId, patch) {
  // Capture prior state so we can detect a transition into 'completed'.
  // The inbox row needs to re-tag from Urgent/Reply -> Done when the user
  // marks a task done that came from an email.
  let prior = null;
  if (patch.completed === true) {
    prior = await getTask(userId, taskId);
  }
  // Coerce any incoming recurrence rule to a known value (or null).
  if (patch.repeat !== undefined) patch.repeat = sanitizeRepeat(patch.repeat);

  const fields = [];
  const values = [];
  let i = 1;
  for (const k of ["list_id", "title", "notes", "due_at", "reminder_at", "repeat", "important", "in_my_day"]) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      values.push(patch[k]);
      if (k === "in_my_day" && patch[k]) {
        fields.push(`my_day_added_at = $${i++}`);
        values.push(new Date());
      } else if (k === "in_my_day" && !patch[k]) {
        fields.push(`my_day_added_at = NULL`);
      }
    }
  }
  if (patch.completed !== undefined) {
    fields.push(`completed_at = ${patch.completed ? "NOW()" : "NULL"}`);
  }
  if (!fields.length) return null;
  values.push(userId, taskId);
  const r = await pool.query(
    `UPDATE tasks SET ${fields.join(", ")}, updated_at = NOW()
      WHERE user_id = $${i++} AND id = $${i}
      RETURNING ${TASK_COLS}`,
    values
  );
  const row = r.rows[0] || null;

  // Side-effect: if the task just transitioned to completed AND links to a
  // source email, mark that email DONE in the classification table so the
  // inbox row re-tags. The 'Task completed' reason lets the frontend skip
  // auto-archive (we only auto-archive on 'Replied' from live sync).
  if (row && prior && patch.completed === true && !prior.completed_at && prior.source_message_id) {
    try {
      const classifier = require("./classifier");
      await classifier.markMessagesDone(userId, [prior.source_message_id], "Task completed");
    } catch (err) {
      console.warn("[tasks.updateTask] markMessagesDone failed:", err.message);
    }
  }

  // Side-effect: a repeating task that just transitioned to completed spawns
  // its next occurrence (the completed one stays in Completed for history).
  if (row && prior && patch.completed === true && !prior.completed_at && prior.repeat) {
    try {
      const next = await spawnNextRecurrence(userId, prior);
      if (next) row.spawnedRecurrence = next;
    } catch (err) {
      console.warn("[tasks.updateTask] spawnNextRecurrence failed:", err.message);
    }
  }

  return row;
}

async function deleteTask(userId, taskId) {
  await pool.query(`DELETE FROM tasks WHERE user_id = $1 AND id = $2`, [userId, taskId]);
}

// Count of incomplete tasks whose due_at is in the past. Used by the To Do
// rail badge across all pages.
async function overdueCount(userId) {
  const r = await pool.query(
    `SELECT COUNT(*)::INT AS n
       FROM tasks
      WHERE user_id = $1
        AND completed_at IS NULL
        AND due_at IS NOT NULL
        AND due_at < NOW()`,
    [userId]
  );
  return r.rows[0]?.n || 0;
}

// Tasks whose due_at or reminder_at has just hit (or is hitting in the next
// 60 seconds) — for the in-page notification poller. Caller filters by
// last-known-fired set to avoid duplicate notifications.
async function dueSoon(userId, { windowMinutesPast = 5, windowMinutesFuture = 1 } = {}) {
  const r = await pool.query(
    `SELECT ${TASK_COLS}
       FROM tasks
      WHERE user_id = $1
        AND completed_at IS NULL
        AND (
          (due_at IS NOT NULL
            AND due_at >= NOW() - ($2 || ' minutes')::INTERVAL
            AND due_at <= NOW() + ($3 || ' minutes')::INTERVAL)
          OR
          (reminder_at IS NOT NULL
            AND reminder_at >= NOW() - ($2 || ' minutes')::INTERVAL
            AND reminder_at <= NOW() + ($3 || ' minutes')::INTERVAL)
        )
      ORDER BY COALESCE(reminder_at, due_at) ASC
      LIMIT 25`,
    [userId, String(windowMinutesPast), String(windowMinutesFuture)]
  );
  return r.rows;
}

async function getTask(userId, taskId) {
  const r = await pool.query(
    `SELECT ${TASK_COLS} FROM tasks WHERE user_id = $1 AND id = $2`,
    [userId, taskId]
  );
  return r.rows[0] || null;
}

// =====================================================================
// RECURRENCE — when a repeating task is completed, spawn the next instance
// =====================================================================
// Advance `fromDate` by one period of `repeat`, repeating until the result is
// strictly after `after` (so a task completed late doesn't reappear already
// overdue). Returns a Date, or null for an unknown rule / unparseable date.
function nextOccurrence(fromDate, repeat, after) {
  const d = new Date(fromDate);
  if (isNaN(d.getTime())) return null;
  const floor = after ? new Date(after) : null;
  let guard = 0;
  do {
    switch (repeat) {
      case "daily":    d.setDate(d.getDate() + 1); break;
      case "weekdays": // Mon–Fri only — skip Sat/Sun
        do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
        break;
      case "weekly":   d.setDate(d.getDate() + 7); break;
      case "monthly":  d.setMonth(d.getMonth() + 1); break;
      case "yearly":   d.setFullYear(d.getFullYear() + 1); break;
      default: return null;
    }
    guard++;
  } while (floor && d <= floor && guard < 4000);
  return d;
}

// Create the next occurrence of a just-completed repeating task. Anchored on
// due_at (preferred) or reminder_at; the reminder keeps its original offset
// relative to the due date. Returns the new task row, or null if it can't be
// anchored (no date) or the rule is unknown. Source-email links are dropped
// so the new instance is a fresh, unclassified task.
async function spawnNextRecurrence(userId, prior) {
  if (!prior || !_VALID_REPEATS.has(prior.repeat)) return null;
  const now = new Date();
  const hadDate = !!(prior.due_at || prior.reminder_at);

  const nextDue = prior.due_at ? nextOccurrence(prior.due_at, prior.repeat, now) : null;
  let nextRem = null;
  if (prior.reminder_at) {
    if (prior.due_at && nextDue) {
      // Preserve the reminder's offset relative to the due date.
      const delta = new Date(nextDue).getTime() - new Date(prior.due_at).getTime();
      nextRem = new Date(new Date(prior.reminder_at).getTime() + delta);
    } else {
      nextRem = nextOccurrence(prior.reminder_at, prior.repeat, now);
    }
  }
  // A dated task that couldn't be advanced (unknown rule) → don't spawn a
  // broken dateless duplicate. A task with NO dates → clone as-is so a
  // "repeat on completion" habit task still regenerates.
  if (hadDate && !nextDue && !nextRem) return null;

  const r = await pool.query(
    `INSERT INTO tasks (user_id, list_id, title, notes, due_at, reminder_at, repeat, important, in_my_day, my_day_added_at, source_message_id, source_thread_id, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, NULL, NULL, NULL,
       COALESCE((SELECT MAX(position)+1 FROM tasks WHERE user_id=$1 AND (list_id = $2 OR (list_id IS NULL AND $2 IS NULL))), 0))
     RETURNING ${TASK_COLS}`,
    [
      userId,
      prior.list_id || null,
      prior.title,
      prior.notes || null,
      nextDue ? nextDue.toISOString() : null,
      nextRem ? nextRem.toISOString() : null,
      prior.repeat,
      !!prior.important,
    ]
  );
  return r.rows[0] || null;
}

// =====================================================================
// SMART LISTS — what to show in My Day / Important / Planned / etc.
// =====================================================================

async function listTasksForView(userId, view, { includeCompleted = false } = {}) {
  let where = "user_id = $1";
  const params = [userId];
  let i = 2;

  if (view === "my-day") {
    where += " AND in_my_day = TRUE";
    if (!includeCompleted) where += " AND completed_at IS NULL";
  } else if (view === "important") {
    where += " AND important = TRUE";
    if (!includeCompleted) where += " AND completed_at IS NULL";
  } else if (view === "planned") {
    where += " AND due_at IS NOT NULL";
    if (!includeCompleted) where += " AND completed_at IS NULL";
  } else if (view === "completed") {
    where += " AND completed_at IS NOT NULL";
  } else if (view === "all") {
    if (!includeCompleted) where += " AND completed_at IS NULL";
  } else if (typeof view === "number") {
    where += ` AND list_id = $${i++}`;
    params.push(view);
    if (!includeCompleted) where += " AND completed_at IS NULL";
  } else {
    // "tasks" (the default — unlisted)
    where += " AND list_id IS NULL";
    if (!includeCompleted) where += " AND completed_at IS NULL";
  }

  const order =
    view === "planned" ? "due_at ASC NULLS LAST, position, created_at" :
    view === "completed" ? "completed_at DESC" :
    view === "my-day" ? "important DESC, my_day_added_at" :
    "important DESC, position, created_at";

  const r = await pool.query(
    `SELECT ${TASK_COLS} FROM tasks WHERE ${where} ORDER BY ${order}`,
    params
  );
  return r.rows;
}

async function smartListCounts(userId) {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND in_my_day = TRUE AND completed_at IS NULL)::INT AS my_day,
       (SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND important = TRUE AND completed_at IS NULL)::INT AS important,
       (SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND due_at IS NOT NULL AND completed_at IS NULL)::INT AS planned,
       (SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND completed_at IS NULL)::INT AS all_count,
       (SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND list_id IS NULL AND completed_at IS NULL)::INT AS tasks`,
    [userId]
  );
  return r.rows[0];
}

// =====================================================================
// MY DAY RESET — clears in_my_day=true tasks each night (4am user-local)
// =====================================================================

async function resetMyDay(userId) {
  // Only clear UNCOMPLETED my-day items older than 18 hours.
  // (Completed ones stay; they'll be visible in Completed.)
  const r = await pool.query(
    `UPDATE tasks SET in_my_day = FALSE, my_day_added_at = NULL
      WHERE user_id = $1
        AND in_my_day = TRUE
        AND completed_at IS NULL
        AND my_day_added_at < NOW() - INTERVAL '18 hours'`,
    [userId]
  );
  return r.rowCount;
}

// Worker entry point: roll My Day for EVERY user in one statement (the
// per-user resetMyDay exists for an explicit single-user reset). Rolling
// 18-hour window is timezone-agnostic and self-healing across restarts.
async function resetMyDayAllUsers() {
  const r = await pool.query(
    `UPDATE tasks SET in_my_day = FALSE, my_day_added_at = NULL
      WHERE in_my_day = TRUE
        AND completed_at IS NULL
        AND my_day_added_at IS NOT NULL
        AND my_day_added_at < NOW() - INTERVAL '18 hours'`
  );
  return r.rowCount;
}

// =====================================================================
// STEPS — sub-tasks
// =====================================================================

async function listSteps(userId, taskId) {
  // Verify ownership
  const o = await pool.query(`SELECT 1 FROM tasks WHERE user_id = $1 AND id = $2`, [userId, taskId]);
  if (!o.rowCount) return [];
  const r = await pool.query(
    `SELECT id, title, completed_at, position FROM task_steps WHERE task_id = $1 ORDER BY position, id`,
    [taskId]
  );
  return r.rows;
}

async function createStep(userId, taskId, title) {
  const o = await pool.query(`SELECT 1 FROM tasks WHERE user_id = $1 AND id = $2`, [userId, taskId]);
  if (!o.rowCount) throw new Error("task_not_found");
  const r = await pool.query(
    `INSERT INTO task_steps (task_id, title, position)
     VALUES ($1, $2, COALESCE((SELECT MAX(position)+1 FROM task_steps WHERE task_id=$1), 0))
     RETURNING id, title, completed_at, position`,
    [taskId, String(title).slice(0, 500).trim()]
  );
  return r.rows[0];
}

async function updateStep(userId, taskId, stepId, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  if (patch.title !== undefined) { fields.push(`title = $${i++}`); values.push(patch.title); }
  if (patch.completed !== undefined) {
    fields.push(`completed_at = ${patch.completed ? "NOW()" : "NULL"}`);
  }
  if (!fields.length) return null;
  values.push(taskId, stepId, userId);
  // Verify ownership in the WHERE — userId is PARAMETERIZED (never inlined)
  // to keep this injection-proof even if the id type ever changes.
  const r = await pool.query(
    `UPDATE task_steps SET ${fields.join(", ")}
       WHERE task_id = $${i++} AND id = $${i++}
         AND task_id IN (SELECT id FROM tasks WHERE user_id = $${i})
       RETURNING id, title, completed_at, position`,
    values
  );
  return r.rows[0] || null;
}

async function deleteStep(userId, taskId, stepId) {
  await pool.query(
    `DELETE FROM task_steps WHERE task_id = $1 AND id = $2
       AND task_id IN (SELECT id FROM tasks WHERE user_id = $3)`,
    [taskId, stepId, userId]
  );
}

module.exports = {
  // lists
  listLists, createList, updateList, deleteList,
  // tasks
  createTask, updateTask, deleteTask, getTask,
  listTasksForView, smartListCounts,
  // counts + due-soon (badge + notification poller)
  overdueCount, dueSoon,
  // my-day
  resetMyDay, resetMyDayAllUsers,
  // steps
  listSteps, createStep, updateStep, deleteStep,
};
