/**
 * tasks.js — To-Do / Task management
 *
 * Two sources of tasks:
 *   1. Auto-generated from application events (doc requests, uploads, payments)
 *   2. Manual — inmobiliaria/constructora assigns to their agents, or self-assigned
 *
 * Separation-of-duties approval workflow:
 * --------------------------------------
 * When task.assigned_to !== task.approver_id, the assignee cannot mark the
 * task truly "completed" by themselves — instead, "complete" submits it for
 * review (status = 'pending_review'). The approver (defaults to
 * assigned_by, but can be reassigned) then either approves (→ 'completada')
 * or rejects (→ 'en_progreso' + review_notes). This prevents the scenario
 * where a client clicks "Done" on "Upload cedula" without actually
 * uploading anything.
 *
 * Self-assigned tasks (assigned_to === approver_id) complete immediately
 * on submit — no review loop.
 *
 * Exported helpers (used by applications.js):
 *   createAutoTask({ ..., approver_id })
 *   autoCompleteTasksByEvent(applicationId, sourceEvent)
 */

const express    = require('express');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const multer     = require('multer');
const { fromFile: fileTypeFromFile } = require('file-type');
const store      = require('./store');
const { userAuth } = require('./auth');
const { notify: pushNotify, refreshBadge: pushRefreshBadge } = require('./push');
const { createTransport } = require('./mailer');
const { logSec } = require('./security-log');
const slaRegistry = require('../utils/sla-registry');
const et = require('../utils/email-templates');

const router      = express.Router();
const transporter = createTransport();
const uuid        = () => crypto.randomUUID();
const PRO_ROLES   = ['agency', 'broker', 'inmobiliaria', 'constructora'];
const BASE_URL    = process.env.BASE_URL || 'https://hogaresrd.com';

// All permitted status values. `pending_review` is set when the
// assignee submits a task that requires a separate approver sign-off.
// `no_aplica` lets the assignee dismiss a task that doesn't apply.
const VALID_STATUSES = ['pendiente', 'en_progreso', 'pending_review', 'completada', 'no_aplica'];

// Enrich a task object with the listing's cover image and title so
// iOS / web clients can render a thumbnail next to the row. The store
// is cheap to query so we do this at response time instead of
// denormalizing onto the task record.
function enrichTask(task) {
  if (!task) return task;
  // Avoid leaking internal _extra
  const out = { ...task };
  if (task.listing_id) {
    const listing = store.getListingById(task.listing_id);
    if (listing) {
      out.listing_title = listing.title || null;
      // First image is the "cover photo" — same rule the rest of the
      // site uses when it needs a single thumbnail for a listing.
      const images = Array.isArray(listing.images) ? listing.images : [];
      out.listing_image = images[0]?.url || images[0] || null;
      out.listing_city  = listing.city || null;
      out.listing_price = listing.price || null;
    }
  }
  // Same lookup for related application (some tasks only reference the
  // application, not the listing).
  if (task.application_id && !out.listing_image) {
    const app = store.getApplicationById(task.application_id);
    if (app?.listing_id) {
      const listing = store.getListingById(app.listing_id);
      if (listing) {
        out.listing_title = out.listing_title || listing.title || null;
        const images = Array.isArray(listing.images) ? listing.images : [];
        out.listing_image = out.listing_image || images[0]?.url || images[0] || null;
        out.listing_city  = out.listing_city || listing.city || null;
      }
    }
  }
  return out;
}

// Resolve who should approve a task. Always prefers an explicit
// approver_id; falls back to assigned_by if that's a real user; if
// the task was created by 'system', we can't resolve an approver and
// the task auto-completes on submit (no review loop).
function resolveApproverId(task) {
  if (task.approver_id) return task.approver_id;
  if (task.assigned_by && task.assigned_by !== 'system') return task.assigned_by;
  return null;
}

function requiresApproval(task) {
  const approverId = resolveApproverId(task);
  return !!approverId && approverId !== task.assigned_to;
}

// ── Subtask + dependency graph helpers ─────────────────────────────────────
// Two relations layered on the embedded task model:
//   parent_task_id  — strict tree, used for "subtask of"
//   depends_on[]    — DAG of predecessor task ids; a task can't move to
//                     pending_review/completada until each predecessor is
//                     completada or no_aplica (or archived/missing → silent
//                     fulfilment)
//
// Both relations are validated for cycles before any write.
function _depsReachable(startId, visited) {
  visited = visited || new Set();
  if (!startId || visited.has(startId)) return visited;
  visited.add(startId);
  const t = store.getTaskById(startId);
  if (t && Array.isArray(t.depends_on)) {
    for (const d of t.depends_on) _depsReachable(d, visited);
  }
  return visited;
}
function wouldCreateDependencyCycle(taskId, predecessorId) {
  if (taskId === predecessorId) return true;
  return _depsReachable(predecessorId).has(taskId);
}
function wouldCreateParentCycle(taskId, parentId) {
  if (taskId === parentId) return true;
  let cur = parentId;
  for (let i = 0; i < 100 && cur; i++) {
    if (cur === taskId) return true;
    const t = store.getTaskById(cur);
    cur = t?.parent_task_id || null;
  }
  return false;
}
// Returns the predecessors that haven't been completada/no_aplica yet.
// Empty array = task is free to complete.
function unfulfilledDependencies(task) {
  if (!Array.isArray(task.depends_on) || task.depends_on.length === 0) return [];
  const out = [];
  for (const depId of task.depends_on) {
    const dep = store.getTaskById(depId);
    if (!dep) continue;          // missing → treat as fulfilled (orphan)
    if (dep.archived) continue;
    if (dep.status === 'completada' || dep.status === 'no_aplica') continue;
    out.push({ id: depId, title: dep.title, status: dep.status });
  }
  return out;
}
// Aggregate subtask completion for a parent task. Returns null if the
// task has no children. Cheap because in-memory store; do not call from
// inside loops over many tasks (O(N²)).
function subtaskProgress(taskId) {
  const children = store.getAllTasks().filter(t => t.parent_task_id === taskId && !t.archived);
  if (children.length === 0) return null;
  const done = children.filter(t => t.status === 'completada' || t.status === 'no_aplica').length;
  return { total: children.length, done };
}

// ── Org-scoping helpers ─────────────────────────────────────────────────────
// Resolve the "org id" a user belongs to. Owners (inmobiliaria/constructora)
// own the org; team members reference it via inmobiliaria_id; everyone else
// has none. Used for the dashboard's "only my team's tasks" filter.
function getUserOrgId(user) {
  if (!user) return null;
  if (['inmobiliaria', 'constructora'].includes(user.role)) return user.id;
  return user.inmobiliaria_id || null;
}

// Resolve the org id a task is anchored to:
//   1. the linked application's inmobiliaria_id, if any
//   2. otherwise the creator's org id
function getTaskOrgId(task) {
  if (!task) return null;
  if (task.application_id) {
    const app = store.getApplicationById(task.application_id);
    if (app?.inmobiliaria_id) return app.inmobiliaria_id;
  }
  const creator = store.getUserById(task.assigned_by);
  return getUserOrgId(creator);
}

// Single source of truth for "should this task appear in user `uid`'s
// task list / badge?" Both GET / and GET /badge-count use this so the
// counts can't disagree with the rendered list.
function isTaskVisibleToUser(task, uid, userOrgId) {
  if (!task) return false;
  const approverId = resolveApproverId(task);
  const isParticipant = task.assigned_to === uid
                     || task.assigned_by === uid
                     || (approverId && approverId === uid);
  if (!isParticipant) return false;
  if (!userOrgId) return true;        // solo brokers / clients have no team filter
  if (task.archived) return false;    // cascade-archived tasks (e.g., on app delete) hide
  return getTaskOrgId(task) === userOrgId;
}

// ── Audit log ───────────────────────────────────────────────────────────────
// Each task carries its own bounded audit_log so reviewers can see who did
// what without joining a separate table. Capped at 200 entries; long-lived
// tasks rotate out the oldest entries.
const AUDIT_LIMIT = 200;
function addTaskAudit(task, type, actorId, data) {
  if (!Array.isArray(task.audit_log)) task.audit_log = [];
  task.audit_log.push({
    id:        uuid(),
    type,                     // created | status_change | approver_changed | edited | reopened | deleted
    actor_id:  actorId || null,
    timestamp: new Date().toISOString(),
    ...(data && Object.keys(data).length ? { data } : {}),
  });
  if (task.audit_log.length > AUDIT_LIMIT) {
    task.audit_log = task.audit_log.slice(-AUDIT_LIMIT);
  }
}

// ── Batch enrichment ────────────────────────────────────────────────────────
// `enrichTask` (single) is fine for one-off lookups but does N store reads
// when called inside a `.map()` over a list. `enrichTasks` pre-fetches each
// distinct listing/application once and reuses the result — turns N+1 into
// 2 + uniqueListingCount + uniqueAppCount.
function enrichTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks || [];
  const listingIds = new Set();
  const appIds     = new Set();
  for (const t of tasks) {
    if (t.listing_id)     listingIds.add(t.listing_id);
    if (t.application_id) appIds.add(t.application_id);
  }
  const listings = new Map();
  for (const id of listingIds) {
    const l = store.getListingById(id);
    if (l) listings.set(id, l);
  }
  const apps = new Map();
  for (const id of appIds) {
    const a = store.getApplicationById(id);
    if (a) apps.set(id, a);
  }
  return tasks.map(t => {
    const out = { ...t };
    let listing = t.listing_id ? listings.get(t.listing_id) : null;
    if (!listing && t.application_id) {
      const app = apps.get(t.application_id);
      if (app?.listing_id) {
        listing = listings.get(app.listing_id) || store.getListingById(app.listing_id);
      }
    }
    if (listing) {
      const images     = Array.isArray(listing.images) ? listing.images : [];
      out.listing_title = listing.title || null;
      out.listing_image = images[0]?.url || images[0] || null;
      out.listing_city  = listing.city  || null;
      out.listing_price = listing.price || null;
    }
    return out;
  });
}

// ── GET /api/tasks — list tasks for the current user ────────────────────────
// Returns tasks where user is assignee, creator, OR approver. Approvers
// need to see tasks sitting in pending_review so they can act on them.
//
// Filters: ?status=, ?priority=, ?application_id=, ?overdue=true
// Pagination: ?limit=N (default 200, max 500), ?offset=N (default 0).
// The response always includes `total` and `has_more` so paginated and
// unpaginated callers see the same shape.
router.get('/', userAuth, (req, res) => {
  const uid = req.user.sub;

  // Build the union of {assignee/creator tasks} ∪ {tasks where I'm approver}
  // via the indexed-style helpers, then dedupe by id. Single-pass scan,
  // no internal-cache leakage.
  const seen = new Set();
  const tasks = [];
  for (const t of [...store.getTasksByUser(uid), ...store.getTasksByApprover(uid)]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    tasks.push(t);
  }

  // Apply optional filters.
  let filtered = tasks;
  const { status, priority, application_id, overdue } = req.query;
  if (status)         filtered = filtered.filter(t => t.status === status);
  if (priority)       filtered = filtered.filter(t => t.priority === priority);
  if (application_id) filtered = filtered.filter(t => t.application_id === application_id);
  if (overdue === 'true') {
    const now = new Date().toISOString();
    filtered = filtered.filter(t =>
      t.due_date && t.due_date < now &&
      t.status !== 'completada' && t.status !== 'no_aplica'
    );
  }

  // Org-scope through the shared visibility predicate so this list and
  // GET /badge-count can never disagree.
  const fullUser  = store.getUserById(uid);
  const userOrgId = getUserOrgId(fullUser);
  filtered = filtered.filter(t => isTaskVisibleToUser(t, uid, userOrgId));

  const total = filtered.length;
  // Pagination — backward-compatible: when caller omits `limit`, returns
  // the legacy "everything up to 200" behaviour. Cap at 500 so a single
  // request can't blow past the in-memory cache.
  const limit  = Math.min(parseInt(req.query.limit  || '200', 10) || 200, 500);
  const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0,   0);
  const page   = filtered.slice(offset, offset + limit);

  res.json({
    tasks:    enrichTasks(page),  // batched listing/application lookups
    total,
    has_more: offset + page.length < total,
    limit,
    offset,
  });
});

// ── GET /api/tasks/badge-count — unread / actionable count for the user ─────
// Returns the number of tasks that currently need the user's attention:
//   - assigned_to user: pendiente / en_progreso (things they haven't done yet)
//   - approver user:    pending_review (things waiting on their review)
// Used to drive the red badge on the "Tareas" menu entry.
router.get('/badge-count', userAuth, (req, res) => {
  const uid       = req.user.sub;
  const fullUser  = store.getUserById(uid);
  const userOrgId = getUserOrgId(fullUser);

  // Same visibility predicate as GET / — counts here can never disagree
  // with the rendered list now.
  const seen  = new Set();
  let count   = 0;
  for (const t of [...store.getTasksByUser(uid), ...store.getTasksByApprover(uid)]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (t.status === 'completada' || t.status === 'no_aplica') continue;
    if (!isTaskVisibleToUser(t, uid, userOrgId)) continue;

    const approverId = resolveApproverId(t);
    if (t.assigned_to === uid && (t.status === 'pendiente' || t.status === 'en_progreso')) {
      count++;
      continue;
    }
    if (approverId === uid && t.assigned_to !== uid && t.status === 'pending_review') {
      count++;
    }
  }
  res.json({ count });
});

// ── GET /api/tasks/:id — single task ────────────────────────────────────────
router.get('/:id', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  const approverId = resolveApproverId(task);
  const canSee = task.assigned_to === req.user.sub
              || task.assigned_by === req.user.sub
              || approverId === req.user.sub;
  if (!canSee) return res.status(403).json({ error: 'Sin acceso a esta tarea' });

  // Org-scope. Earlier this only checked when task.application_id was set,
  // leaving manual cross-org tasks readable if the UUID was known. Now
  // routes through the shared predicate so the check covers both anchor
  // styles (linked-application org and creator org).
  const fullUser  = store.getUserById(req.user.sub);
  const userOrgId = getUserOrgId(fullUser);
  if (userOrgId) {
    const taskOrgId = getTaskOrgId(task);
    if (taskOrgId && taskOrgId !== userOrgId) {
      return res.status(403).json({ error: 'Sin acceso a esta tarea' });
    }
  }

  // Decorate the response with subtask progress (only if children exist)
  // and the live unfulfilled-dependency list. Both are cheap one-task
  // computations; we do NOT include them in list views.
  const enriched = enrichTask(task);
  const progress = subtaskProgress(task.id);
  if (progress) enriched.subtask_progress = progress;
  enriched.unfulfilled_dependencies = unfulfilledDependencies(task);
  res.json(enriched);
});

// ── POST /api/tasks — create a task ─────────────────────────────────────────
// Any user can self-assign. Only inmobiliaria/constructora can assign to
// agents within their team.
router.post('/', userAuth, (req, res) => {
  const creator = store.getUserById(req.user.sub);
  if (!creator) return res.status(401).json({ error: 'Usuario no encontrado' });

  const { title, description, priority, due_date, assigned_to, application_id, listing_id, approver_id, parent_task_id, depends_on } = req.body;
  if (!title || !title.trim())
    return res.status(400).json({ error: 'Título requerido' });

  // Validate application_id belongs to the creator's org
  if (application_id) {
    const app = store.getApplicationById(application_id);
    if (app) {
      const creatorOrgId = ['inmobiliaria','constructora'].includes(creator.role) ? creator.id : creator.inmobiliaria_id;
      if (creatorOrgId && app.inmobiliaria_id && app.inmobiliaria_id !== creatorOrgId) {
        return res.status(403).json({ error: 'La aplicacion no pertenece a tu organizacion.' });
      }
    }
  }

  // Validate parent task: same org, not archived, exists. Cycle isn't
  // possible at creation (the new task has no id yet) but we still
  // verify the parent is reachable to the creator.
  let validatedParentId = null;
  if (parent_task_id) {
    const parent = store.getTaskById(parent_task_id);
    if (!parent || parent.archived)
      return res.status(404).json({ error: 'Tarea padre no encontrada' });
    const creatorOrgId = getUserOrgId(creator);
    if (creatorOrgId && getTaskOrgId(parent) !== creatorOrgId)
      return res.status(403).json({ error: 'La tarea padre no pertenece a tu organizacion.' });
    validatedParentId = parent_task_id;
  }

  // Validate depends_on: each id resolves to a task in the same org.
  let validatedDepsOn = [];
  if (Array.isArray(depends_on) && depends_on.length) {
    const creatorOrgId = getUserOrgId(creator);
    const seen = new Set();
    for (const depId of depends_on) {
      if (!depId || typeof depId !== 'string' || seen.has(depId)) continue;
      seen.add(depId);
      const dep = store.getTaskById(depId);
      if (!dep || dep.archived) continue;
      if (creatorOrgId && getTaskOrgId(dep) !== creatorOrgId) continue;
      validatedDepsOn.push(depId);
    }
  }

  const assigneeId = assigned_to || req.user.sub;

  // If assigning to someone else, verify team membership
  if (assigneeId !== req.user.sub) {
    if (!['inmobiliaria', 'constructora'].includes(creator.role))
      return res.status(403).json({ error: 'Solo inmobiliarias y constructoras pueden asignar tareas a otros' });
    const assignee = store.getUserById(assigneeId);
    if (!assignee)
      return res.status(404).json({ error: 'Agente no encontrado' });
    // Assignee must be on the same team (inmobiliaria_id matches creator's id)
    if (assignee.inmobiliaria_id !== creator.id)
      return res.status(403).json({ error: 'El agente no pertenece a tu equipo' });
  }

  // Default approver = the creator (the person requesting the work).
  // Caller can override via `approver_id` (e.g. delegating to a secretary).
  // But the approver cannot be the assignee — separation of duties.
  let approverId = approver_id || req.user.sub;
  if (approverId === assigneeId && assigneeId !== req.user.sub) {
    approverId = req.user.sub; // force back to creator
  }

  const now = new Date().toISOString();
  const task = {
    id:             uuid(),
    title:          title.trim().slice(0, 200),
    description:    (description || '').trim().slice(0, 2000),
    // Auto-set "en_progreso" when assigning to someone else — the
    // assignee already has work to do. Self-assigned starts as pendiente.
    status:         assigneeId !== req.user.sub ? 'en_progreso' : 'pendiente',
    priority:       ['alta', 'media', 'baja'].includes(priority) ? priority : 'media',
    due_date:       due_date || null,
    assigned_to:    assigneeId,
    assigned_by:    req.user.sub,
    approver_id:    approverId,
    application_id: application_id || null,
    listing_id:     listing_id || null,
    source:         'manual',
    source_event:   null,
    // Subtask + dependency relations
    parent_task_id:  validatedParentId,
    depends_on:      validatedDepsOn,
    // Approval workflow state
    approval_status: null,
    review_notes:    null,
    reviewed_at:     null,
    reviewed_by:     null,
    submitted_at:    null,
    completed_at:    null,
    created_at:      now,
    updated_at:      now,
  };

  addTaskAudit(task, 'created', req.user.sub, {
    assigned_to: assigneeId,
    approver_id: approverId,
    ...(validatedParentId ? { parent_task_id: validatedParentId } : {}),
    ...(validatedDepsOn.length ? { depends_on: validatedDepsOn } : {}),
  });
  store.saveTask(task);

  // Notify assignee if it's someone else
  if (assigneeId !== req.user.sub) {
    pushNotify(assigneeId, {
      type:  'task_assigned',
      title: 'Nueva tarea asignada',
      body:  task.title.slice(0, 80),
      url:   '/broker',
    });
    sendTaskEmail(assigneeId, creator.name, task).catch(() => {});
  }

  res.status(201).json(enrichTask(task));
});

// ── PUT /api/tasks/:id — update task ────────────────────────────────────────
// Approvers, alongside assignee and creator, can edit metadata: they
// own the review and need to be able to push the due date or change
// priority while a task sits in pending_review.
router.put('/:id', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  const approverId = resolveApproverId(task);
  if (task.assigned_to !== req.user.sub
      && task.assigned_by !== req.user.sub
      && approverId !== req.user.sub) {
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });
  }

  const before = {
    title:       task.title,
    description: task.description,
    status:      task.status,
    priority:    task.priority,
    due_date:    task.due_date,
  };
  const { title, description, status, priority, due_date } = req.body;
  if (title !== undefined)       task.title       = String(title).trim().slice(0, 200);
  if (description !== undefined) task.description = String(description).trim().slice(0, 2000);
  if (status && VALID_STATUSES.includes(status)) {
    // Block direct jumps to pending_review / completada — those go through
    // the dedicated /complete and /approve endpoints. PUT can only move
    // between pendiente / en_progreso.
    if (status === 'pendiente' || status === 'en_progreso') {
      task.status = status;
      task.completed_at = null;
    }
  }
  if (priority && ['alta', 'media', 'baja'].includes(priority)) task.priority = priority;
  if (due_date !== undefined) task.due_date = due_date || null;
  task.updated_at = new Date().toISOString();

  // Build a compact diff of fields that actually moved so the audit log
  // isn't full of no-op edits.
  const changes = {};
  for (const k of Object.keys(before)) {
    if (before[k] !== task[k]) changes[k] = { from: before[k], to: task[k] };
  }
  if (Object.keys(changes).length) {
    addTaskAudit(task, 'edited', req.user.sub, { changes });
  }

  store.saveTask(task);
  res.json(enrichTask(task));
});

// ── POST /api/tasks/:id/complete ────────────────────────────────────────────
// Assignee marks a task as done.
// - If the task requires separate approval (different approver), this
//   submits for review (status = 'pending_review').
// - Otherwise it completes immediately.
router.post('/:id/complete', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_to !== req.user.sub)
    return res.status(403).json({ error: 'Solo el asignado puede completar esta tarea' });

  const now = new Date().toISOString();

  // Block completion until predecessor tasks are done. Returns the
  // unfulfilled list so the UI can show which tasks the user is waiting on.
  const blocking = unfulfilledDependencies(task);
  if (blocking.length) {
    return res.status(409).json({
      error: 'Esta tarea depende de otras que aún no están completadas.',
      blocking_tasks: blocking,
    });
  }

  if (requiresApproval(task)) {
    const prevStatus     = task.status;
    task.status          = 'pending_review';
    task.approval_status = 'pending_review';
    task.submitted_at    = now;
    task.updated_at      = now;
    // Clear any prior rejection so the approver sees a clean state
    task.review_notes    = null;
    addTaskAudit(task, 'status_change', req.user.sub, { from: prevStatus, to: 'pending_review' });
    store.saveTask(task);

    const approverId = resolveApproverId(task);
    if (approverId) {
      pushNotify(approverId, {
        type:  'task_pending_review',
        title: 'Tarea esperando revisión',
        body:  task.title.slice(0, 80),
        url:   '/broker',
      });
    }
    return res.json(enrichTask(task));
  }

  // No approval needed — complete immediately
  const prevStatus     = task.status;
  task.status          = 'completada';
  task.approval_status = 'approved';
  task.completed_at    = now;
  task.updated_at      = now;
  addTaskAudit(task, 'status_change', req.user.sub, { from: prevStatus, to: 'completada' });
  // Spawn the next recurrence (if any) BEFORE saving so the original
  // task's audit log captures the spawn event in the same write.
  maybeSpawnRecurrence(task, req.user.sub);
  store.saveTask(task);

  if (task.assigned_by !== req.user.sub && task.assigned_by !== 'system') {
    pushNotify(task.assigned_by, {
      type:  'task_completed',
      title: 'Tarea completada',
      body:  task.title.slice(0, 80),
      url:   '/broker',
    });
  }
  // Assignee just removed an item from their pending list — refresh icon
  pushRefreshBadge(req.user.sub).catch(() => {});
  res.json(enrichTask(task));
});

// ── POST /api/tasks/:id/approve — approver signs off on a submitted task ────
router.post('/:id/approve', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const approverId = resolveApproverId(task);
  if (!approverId)
    return res.status(400).json({ error: 'Esta tarea no tiene un aprobador asignado' });
  if (approverId !== req.user.sub)
    return res.status(403).json({ error: 'Solo el aprobador asignado puede revisar esta tarea' });
  if (task.assigned_to === req.user.sub)
    return res.status(403).json({ error: 'No puedes aprobar una tarea que tú mismo realizaste' });
  if (task.status !== 'pending_review')
    return res.status(400).json({ error: 'La tarea no está esperando revisión' });

  const now = new Date().toISOString();
  const note = (req.body?.note || '').toString().trim().slice(0, 1000);
  task.status          = 'completada';
  task.approval_status = 'approved';
  task.completed_at    = now;
  task.reviewed_at     = now;
  task.reviewed_by     = req.user.sub;
  task.review_notes    = note || null;
  task.updated_at      = now;
  addTaskAudit(task, 'status_change', req.user.sub, {
    from: 'pending_review', to: 'completada',
    action: 'approve',
    note: note || null,
  });
  maybeSpawnRecurrence(task, req.user.sub);
  store.saveTask(task);

  pushNotify(task.assigned_to, {
    type:  'task_approved',
    title: 'Tarea aprobada ✓',
    body:  task.title.slice(0, 80),
    url:   '/broker',
  });
  // Approver finished a pending_review task → their badge drops.
  // The assignee's pending push (sent above) already recomputes their badge.
  pushRefreshBadge(req.user.sub).catch(() => {});

  res.json(enrichTask(task));
});

// ── POST /api/tasks/:id/reject — approver sends task back for revision ──────
router.post('/:id/reject', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const approverId = resolveApproverId(task);
  if (!approverId)
    return res.status(400).json({ error: 'Esta tarea no tiene un aprobador asignado' });
  if (approverId !== req.user.sub)
    return res.status(403).json({ error: 'Solo el aprobador asignado puede revisar esta tarea' });
  if (task.assigned_to === req.user.sub)
    return res.status(403).json({ error: 'No puedes revisar una tarea que tú mismo realizaste' });
  if (task.status !== 'pending_review')
    return res.status(400).json({ error: 'La tarea no está esperando revisión' });

  const note = (req.body?.note || '').toString().trim().slice(0, 1000);
  if (!note)
    return res.status(400).json({ error: 'El motivo del rechazo es obligatorio' });

  const now = new Date().toISOString();
  task.status          = 'en_progreso';
  task.approval_status = 'rejected';
  task.reviewed_at     = now;
  task.reviewed_by     = req.user.sub;
  task.review_notes    = note;
  task.submitted_at    = null;
  task.completed_at    = null;
  task.updated_at      = now;
  addTaskAudit(task, 'status_change', req.user.sub, {
    from: 'pending_review', to: 'en_progreso',
    action: 'reject',
    note,
  });
  store.saveTask(task);

  pushNotify(task.assigned_to, {
    type:  'task_rejected',
    title: 'Tarea devuelta para revisión',
    body:  (note || task.title).slice(0, 80),
    url:   '/broker',
  });
  // Approver's pending_review item moved off their plate.
  pushRefreshBadge(req.user.sub).catch(() => {});

  res.json(enrichTask(task));
});

// ── POST /api/tasks/:id/not-applicable — mark a task as not applicable ──────
// Either the assignee or the approver can mark a task as N/A.
router.post('/:id/not-applicable', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const isAssignee = task.assigned_to === req.user.sub;
  const approverId = resolveApproverId(task);
  const isApprover = approverId && approverId === req.user.sub;
  if (!isAssignee && !isApprover)
    return res.status(403).json({ error: 'Solo el asignado o el aprobador pueden marcar como no aplica' });
  if (task.status === 'completada' || task.status === 'no_aplica')
    return res.status(400).json({ error: 'La tarea ya fue finalizada' });

  const now  = new Date().toISOString();
  const note = (req.body?.note || '').toString().trim().slice(0, 1000);
  const prevStatus     = task.status;
  task.status          = 'no_aplica';
  task.approval_status = 'not_applicable';
  task.review_notes    = note || null;
  task.reviewed_by     = req.user.sub;
  task.reviewed_at     = now;
  task.completed_at    = now;
  task.updated_at      = now;
  addTaskAudit(task, 'status_change', req.user.sub, {
    from: prevStatus, to: 'no_aplica',
    note: note || null,
  });
  store.saveTask(task);

  // Notify the other party
  const notifyId = isAssignee ? (approverId || task.assigned_by) : task.assigned_to;
  if (notifyId && notifyId !== req.user.sub && notifyId !== 'system') {
    pushNotify(notifyId, {
      type:  'task_not_applicable',
      title: 'Tarea marcada como no aplica',
      body:  task.title.slice(0, 80),
      url:   '/broker',
    });
  }
  // The actor's badge dropped (one fewer pending/review item on their plate)
  pushRefreshBadge(req.user.sub).catch(() => {});
  res.json(enrichTask(task));
});

// ── PUT /api/tasks/:id/approver — reassign who approves this task ───────────
// Only the current approver (or admin) can delegate. The new approver:
//   - cannot be the assignee (separation of duties)
//   - must be in the same org as the current approver (cross-org leak prevention)
// Reassignment is BLOCKED while the task is in pending_review so an
// approver-in-progress doesn't lose context (and review_notes) silently.
router.put('/:id/approver', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const currentApprover = resolveApproverId(task);
  const user    = store.getUserById(req.user.sub);
  const isAdmin = user?.role === 'admin';
  if (currentApprover !== req.user.sub && !isAdmin)
    return res.status(403).json({ error: 'Solo el aprobador actual puede reasignar' });

  // Don't strand the current approver mid-review. Force them to approve
  // or reject (which cleanly resets state) before handing off.
  if (task.status === 'pending_review' && !isAdmin) {
    return res.status(409).json({
      error: 'Esta tarea está en revisión. Aprueba o rechaza primero antes de reasignar el aprobador.',
    });
  }

  const { approver_id: newApproverId } = req.body || {};
  if (!newApproverId)
    return res.status(400).json({ error: 'approver_id es requerido' });
  if (newApproverId === task.assigned_to)
    return res.status(400).json({ error: 'El aprobador no puede ser la misma persona que ejecuta la tarea' });
  const newApprover = store.getUserById(newApproverId);
  if (!newApprover)
    return res.status(404).json({ error: 'Usuario aprobador no encontrado' });

  // Org-scope: the new approver has to be in the same org as the task.
  // Admin override remains for cross-org operational fixes.
  if (!isAdmin) {
    const taskOrgId     = getTaskOrgId(task);
    const newApproverOrg = getUserOrgId(newApprover);
    if (taskOrgId && newApproverOrg !== taskOrgId) {
      return res.status(403).json({
        error: 'El nuevo aprobador no pertenece al equipo de esta tarea.',
      });
    }
  }

  const oldApproverId = task.approver_id || null;
  task.approver_id    = newApproverId;
  task.updated_at     = new Date().toISOString();
  addTaskAudit(task, 'approver_changed', req.user.sub, {
    from: oldApproverId,
    to:   newApproverId,
  });
  store.saveTask(task);

  // Notify the new approver they own the review.
  pushNotify(newApproverId, {
    type:  'task_approver_assigned',
    title: 'Te asignaron una tarea para revisar',
    body:  task.title.slice(0, 80),
    url:   '/broker',
  });
  // Notify the previous approver they're off the hook (skip if it was
  // the same user reassigning to themselves, or the system).
  if (oldApproverId && oldApproverId !== newApproverId
      && oldApproverId !== req.user.sub && oldApproverId !== 'system') {
    pushNotify(oldApproverId, {
      type:  'task_approver_unassigned',
      title: 'Ya no eres el aprobador de una tarea',
      body:  task.title.slice(0, 80),
      url:   '/broker',
    });
  }

  res.json(enrichTask(task));
});

// ── POST /api/tasks/:id/reopen — reopen a closed task ──────────────────────
// `completada` and `no_aplica` are otherwise terminal. The creator or
// approver can reopen a task to `en_progreso` if it was closed by mistake
// or new information surfaced. The reason is required and goes into the
// audit log so the history stays auditable.
router.post('/:id/reopen', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const approverId = resolveApproverId(task);
  const canReopen  = task.assigned_by === req.user.sub
                   || (approverId && approverId === req.user.sub);
  if (!canReopen)
    return res.status(403).json({ error: 'Solo el creador o el aprobador pueden reabrir esta tarea' });

  if (task.status !== 'completada' && task.status !== 'no_aplica')
    return res.status(400).json({ error: 'Solo se pueden reabrir tareas finalizadas' });

  const reason = (req.body?.reason || '').toString().trim().slice(0, 1000);
  if (!reason)
    return res.status(400).json({ error: 'El motivo de la reapertura es obligatorio' });

  const now            = new Date().toISOString();
  const prevStatus     = task.status;
  task.status          = 'en_progreso';
  task.approval_status = null;
  task.completed_at    = null;
  task.reviewed_at     = null;
  task.reviewed_by     = null;
  task.review_notes    = null;
  task.submitted_at    = null;
  task.updated_at      = now;
  addTaskAudit(task, 'reopened', req.user.sub, { from: prevStatus, reason });
  store.saveTask(task);

  if (task.assigned_to !== req.user.sub) {
    pushNotify(task.assigned_to, {
      type:  'task_reopened',
      title: 'Tarea reabierta',
      body:  task.title.slice(0, 80),
      url:   '/broker',
    });
  }
  pushRefreshBadge(req.user.sub).catch(() => {});
  res.json(enrichTask(task));
});

// ── DELETE /api/tasks/:id ───────────────────────────────────────────────────
// Hard-delete; the task and its embedded audit_log are gone. We log the
// event to the security log first so there's a durable trail of who
// deleted what.
router.delete('/:id', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Solo el creador puede eliminar esta tarea' });

  logSec('task_deleted', req, {
    taskId:        task.id,
    title:         task.title,
    status:        task.status,
    assigned_to:   task.assigned_to,
    application_id: task.application_id || null,
  });
  store.deleteTask(task.id);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Recurring tasks
// ════════════════════════════════════════════════════════════════════════════
// task.recurrence shape:
//   { rule: 'daily'|'weekly'|'monthly', interval: 1+, count?: N, until?: ISO,
//     last_spawned_at?: ISO, next_due_at?: ISO }
// When a recurring task moves to `completada`, we synchronously spawn the
// next occurrence with the next due date. `no_aplica` does NOT spawn (the
// occurrence was skipped); `reopen` does NOT spawn (the original is being
// re-worked, not closed).
const VALID_RECURRENCE_RULES = new Set(['daily', 'weekly', 'monthly']);
function _addInterval(dateStr, rule, interval) {
  const d = dateStr ? new Date(dateStr) : new Date();
  if (isNaN(d.getTime())) return null;
  const n = Math.max(1, parseInt(interval, 10) || 1);
  if (rule === 'daily')   d.setUTCDate(d.getUTCDate() + n);
  if (rule === 'weekly')  d.setUTCDate(d.getUTCDate() + n * 7);
  if (rule === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
}
function validateRecurrence(input) {
  if (input == null) return { ok: true, value: null };       // explicit clear
  if (typeof input !== 'object') return { ok: false, error: 'recurrence debe ser un objeto o null' };
  const { rule, interval, count, until } = input;
  if (!VALID_RECURRENCE_RULES.has(rule))
    return { ok: false, error: `rule debe ser una de: ${[...VALID_RECURRENCE_RULES].join(', ')}` };
  const itv = parseInt(interval, 10);
  if (!Number.isFinite(itv) || itv < 1 || itv > 365)
    return { ok: false, error: 'interval debe ser un entero entre 1 y 365' };
  if (count !== undefined && count !== null) {
    const c = parseInt(count, 10);
    if (!Number.isFinite(c) || c < 1 || c > 1000)
      return { ok: false, error: 'count debe ser un entero entre 1 y 1000, o null' };
  }
  if (until !== undefined && until !== null) {
    const u = new Date(until);
    if (isNaN(u.getTime()))
      return { ok: false, error: 'until debe ser una fecha ISO o null' };
  }
  return {
    ok: true,
    value: {
      rule,
      interval: itv,
      count:    count == null ? null : parseInt(count, 10),
      until:    until == null ? null : new Date(until).toISOString(),
    },
  };
}
// Called from /complete + /approve + autoCompleteTasksByEvent. Spawns the
// next occurrence (if any) and writes audit entries on both the original
// and the new task. The CALLER must still persist `task` afterwards —
// this function doesn't double-save.
function maybeSpawnRecurrence(task, actorId) {
  const r = task.recurrence;
  if (!r || !VALID_RECURRENCE_RULES.has(r.rule)) return null;
  if (typeof r.count === 'number' && r.count <= 1) {
    addTaskAudit(task, 'recurrence_ended', actorId, { reason: 'count_exhausted' });
    return null;
  }
  const baseDue = task.due_date || new Date().toISOString();
  const nextDue = _addInterval(baseDue, r.rule, r.interval || 1);
  if (!nextDue) return null;
  if (r.until && nextDue > r.until) {
    addTaskAudit(task, 'recurrence_ended', actorId, { reason: 'until_passed' });
    return null;
  }

  const now = new Date().toISOString();
  const next = {
    ...task,
    id:              uuid(),
    // Reset workflow state to a fresh start
    status:          task.assigned_to !== task.assigned_by ? 'en_progreso' : 'pendiente',
    approval_status: null,
    review_notes:    null,
    reviewed_at:     null,
    reviewed_by:     null,
    submitted_at:    null,
    completed_at:    null,
    audit_log:       [],
    comments:        [],
    attachments:     [],
    archived:        false,
    archived_at:     null,
    archived_reason: null,
    due_date:        nextDue,
    created_at:      now,
    updated_at:      now,
    spawned_from:    task.id,
    recurrence: {
      ...r,
      count:           typeof r.count === 'number' ? r.count - 1 : r.count,
      last_spawned_at: now,
      next_due_at:     _addInterval(nextDue, r.rule, r.interval || 1),
    },
  };
  addTaskAudit(next, 'created', actorId, { source: 'recurrence', spawned_from: task.id });
  store.saveTask(next);

  // Annotate the original so its history shows the spawn event.
  addTaskAudit(task, 'recurrence_spawned', actorId, {
    spawned_task_id: next.id,
    next_due_at:     nextDue,
  });
  return next.id;
}

// PUT /api/tasks/:id/recurrence — creator sets/clears the rule. Body shape:
//   { rule: 'daily'|'weekly'|'monthly', interval: N, count?: N, until?: ISO }
// or null/empty body to clear.
router.put('/:id/recurrence', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Solo el creador puede cambiar la recurrencia' });

  const input = req.body && Object.keys(req.body).length ? req.body : null;
  const v = validateRecurrence(input);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const before = task.recurrence || null;
  task.recurrence = v.value;
  task.updated_at = new Date().toISOString();
  addTaskAudit(task, 'recurrence_set', req.user.sub, { from: before, to: v.value });
  store.saveTask(task);
  res.json(enrichTask(task));
});

// ════════════════════════════════════════════════════════════════════════════
// Subtasks + dependencies
// ════════════════════════════════════════════════════════════════════════════
// Two relations layered on the existing task model:
//   parent_task_id   — strict tree, "X is a subtask of Y"
//   depends_on[]     — DAG, "Y can't complete until X is done"
// Cycle detection runs before each write; both relations validate the
// counterpart task is in the same org as the requester.

// GET /api/tasks/:id/subtasks — list direct children of a task.
router.get('/:id/subtasks', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (!ensureCommentParticipant(task, req.user.sub))
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });
  const children = store.getAllTasks().filter(t =>
    t.parent_task_id === req.params.id && !t.archived
  );
  res.json({ subtasks: enrichTasks(children), progress: subtaskProgress(req.params.id) });
});

// PUT /api/tasks/:id/parent — re-parent (body.parent_task_id = null detaches).
router.put('/:id/parent', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Solo el creador puede mover una tarea de padre' });

  const newParentId = req.body?.parent_task_id || null;
  if (newParentId === task.parent_task_id) {
    return res.json(enrichTask(task));   // no-op
  }

  if (newParentId) {
    const parent = store.getTaskById(newParentId);
    if (!parent || parent.archived)
      return res.status(404).json({ error: 'Tarea padre no encontrada' });
    const fullUser = store.getUserById(req.user.sub);
    const userOrgId = getUserOrgId(fullUser);
    if (userOrgId && getTaskOrgId(parent) !== userOrgId)
      return res.status(403).json({ error: 'La tarea padre no pertenece a tu organizacion.' });
    if (wouldCreateParentCycle(task.id, newParentId))
      return res.status(409).json({ error: 'Esa relación crearía un ciclo de tareas padre/hija.' });
  }

  const oldParentId   = task.parent_task_id || null;
  task.parent_task_id = newParentId;
  task.updated_at     = new Date().toISOString();
  addTaskAudit(task, 'parent_changed', req.user.sub, {
    from: oldParentId, to: newParentId,
  });
  store.saveTask(task);
  res.json(enrichTask(task));
});

// POST /api/tasks/:id/depends-on — add a predecessor.
// Body: { predecessor_id }
router.post('/:id/depends-on', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_by !== req.user.sub && task.assigned_to !== req.user.sub)
    return res.status(403).json({ error: 'Solo el creador o el asignado pueden cambiar las dependencias' });

  const predecessorId = (req.body?.predecessor_id || '').toString();
  if (!predecessorId)
    return res.status(400).json({ error: 'predecessor_id es requerido' });
  if (predecessorId === task.id)
    return res.status(400).json({ error: 'Una tarea no puede depender de sí misma' });

  const predecessor = store.getTaskById(predecessorId);
  if (!predecessor || predecessor.archived)
    return res.status(404).json({ error: 'Tarea predecesora no encontrada' });

  const fullUser  = store.getUserById(req.user.sub);
  const userOrgId = getUserOrgId(fullUser);
  if (userOrgId && getTaskOrgId(predecessor) !== userOrgId)
    return res.status(403).json({ error: 'La tarea predecesora no pertenece a tu organizacion.' });

  if (wouldCreateDependencyCycle(task.id, predecessorId))
    return res.status(409).json({ error: 'Esa dependencia crearía un ciclo entre tareas.' });

  if (!Array.isArray(task.depends_on)) task.depends_on = [];
  if (task.depends_on.includes(predecessorId)) {
    return res.json(enrichTask(task));   // already linked, idempotent
  }
  task.depends_on.push(predecessorId);
  task.updated_at = new Date().toISOString();
  addTaskAudit(task, 'depends_on_added', req.user.sub, { predecessor_id: predecessorId });
  store.saveTask(task);
  res.status(201).json(enrichTask(task));
});

// DELETE /api/tasks/:id/depends-on/:predecessorId — remove a predecessor.
router.delete('/:id/depends-on/:predecessorId', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_by !== req.user.sub && task.assigned_to !== req.user.sub)
    return res.status(403).json({ error: 'Solo el creador o el asignado pueden cambiar las dependencias' });

  if (!Array.isArray(task.depends_on)) task.depends_on = [];
  const before = task.depends_on.length;
  task.depends_on = task.depends_on.filter(id => id !== req.params.predecessorId);
  if (task.depends_on.length === before)
    return res.status(404).json({ error: 'Esa dependencia no existe en la tarea' });

  task.updated_at = new Date().toISOString();
  addTaskAudit(task, 'depends_on_removed', req.user.sub, { predecessor_id: req.params.predecessorId });
  store.saveTask(task);
  res.json(enrichTask(task));
});

// ════════════════════════════════════════════════════════════════════════════
// Comments — embedded thread per task
// ════════════════════════════════════════════════════════════════════════════
// Stored at task.comments = [{id, author_id, author_name, body, created_at,
// edited_at?}]. Bounded to COMMENTS_LIMIT to keep the task row reasonable;
// when full, the oldest entry rotates out (same pattern as audit_log).
const COMMENTS_LIMIT  = 200;
const COMMENT_MAX_LEN = 4000;

function ensureCommentParticipant(task, uid) {
  const approverId = resolveApproverId(task);
  return task.assigned_to === uid
      || task.assigned_by === uid
      || (approverId && approverId === uid);
}

// GET /api/tasks/:id/comments — list comments + audit log for a task.
router.get('/:id/comments', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (!ensureCommentParticipant(task, req.user.sub))
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });
  res.json({
    comments:  Array.isArray(task.comments)  ? task.comments  : [],
    audit_log: Array.isArray(task.audit_log) ? task.audit_log : [],
  });
});

// POST /api/tasks/:id/comments — add a comment.
router.post('/:id/comments', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (!ensureCommentParticipant(task, req.user.sub))
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });

  const body = (req.body?.body || '').toString().trim().slice(0, COMMENT_MAX_LEN);
  if (!body) return res.status(400).json({ error: 'El comentario está vacío' });

  if (!Array.isArray(task.comments)) task.comments = [];
  const author = store.getUserById(req.user.sub);
  const comment = {
    id:          uuid(),
    author_id:   req.user.sub,
    author_name: author?.name || null,
    body,
    created_at:  new Date().toISOString(),
  };
  task.comments.push(comment);
  if (task.comments.length > COMMENTS_LIMIT) {
    task.comments = task.comments.slice(-COMMENTS_LIMIT);
  }
  task.updated_at = comment.created_at;
  addTaskAudit(task, 'comment_added', req.user.sub, { comment_id: comment.id });
  store.saveTask(task);

  // Notify the other participants (everyone but the author).
  const approverId = resolveApproverId(task);
  const targets = new Set([task.assigned_to, task.assigned_by, approverId]
    .filter(x => x && x !== 'system' && x !== req.user.sub));
  for (const target of targets) {
    pushNotify(target, {
      type:  'task_comment',
      title: 'Nuevo comentario en una tarea',
      body:  body.slice(0, 80),
      url:   '/tareas',
    });
  }

  res.status(201).json(comment);
});

// PATCH /api/tasks/:id/comments/:cid — edit your own comment.
router.patch('/:id/comments/:cid', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  const list = Array.isArray(task.comments) ? task.comments : [];
  const c = list.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comentario no encontrado' });
  if (c.author_id !== req.user.sub)
    return res.status(403).json({ error: 'Solo el autor puede editar su comentario' });

  const body = (req.body?.body || '').toString().trim().slice(0, COMMENT_MAX_LEN);
  if (!body) return res.status(400).json({ error: 'El comentario está vacío' });

  c.body      = body;
  c.edited_at = new Date().toISOString();
  task.updated_at = c.edited_at;
  addTaskAudit(task, 'comment_edited', req.user.sub, { comment_id: c.id });
  store.saveTask(task);
  res.json(c);
});

// DELETE /api/tasks/:id/comments/:cid — delete your own comment (or
// creator deletes any comment on their task).
router.delete('/:id/comments/:cid', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  const list = Array.isArray(task.comments) ? task.comments : [];
  const idx  = list.findIndex(x => x.id === req.params.cid);
  if (idx < 0) return res.status(404).json({ error: 'Comentario no encontrado' });
  const c = list[idx];
  if (c.author_id !== req.user.sub && task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Solo el autor o el creador de la tarea pueden eliminar comentarios' });

  list.splice(idx, 1);
  task.comments   = list;
  task.updated_at = new Date().toISOString();
  addTaskAudit(task, 'comment_deleted', req.user.sub, { comment_id: c.id });
  store.saveTask(task);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Attachments — multer storage in data/task-attachments
// ════════════════════════════════════════════════════════════════════════════
// Stored at task.attachments = [{id, filename, original_name, size,
// mime, uploaded_by, uploaded_at}]. Files land in TASK_ATTACH_DIR with
// random-UUID filenames so the URL is never guessable. Same security
// pattern as applications.js documents:
//   - extension allowlist on multer fileFilter
//   - magic-byte MIME sniff after upload
//   - path-traversal guard on download
// Permissions:
//   - upload: any participant (assignee/creator/approver)
//   - read:   same
//   - delete: uploader OR creator
const TASK_ATTACH_DIR = path.join(__dirname, '..', 'data', 'task-attachments');
if (!fs.existsSync(TASK_ATTACH_DIR)) fs.mkdirSync(TASK_ATTACH_DIR, { recursive: true });

const ATTACH_LIMIT_PER_TASK = 20;
const ATTACH_BYTES_PER_FILE = 10 * 1024 * 1024;     // 10 MB
const ATTACH_FILES_PER_REQ  = 5;
// Same extension whitelist as application documents — covers what real
// users send (photos, scans, PDFs, Office docs).
const ATTACH_ALLOWED_EXT  = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|pdf|docx?|xlsx?|odt|ods|txt|csv|rtf|zip)$/i;
const ATTACH_ALLOWED_MIME = new Set([
  'image/jpeg','image/pjpeg','image/png','image/gif','image/webp',
  'image/heic','image/heif','image/tiff','image/bmp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain','text/csv',
  'application/rtf','text/rtf',
  'application/zip',
]);

const taskAttachStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TASK_ATTACH_DIR),
  filename:    (req, file, cb) => cb(null, `${uuid()}_${file.originalname.replace(/\s/g, '_')}`),
});
const taskAttachUpload = multer({
  storage: taskAttachStorage,
  limits:  { fileSize: ATTACH_BYTES_PER_FILE, files: ATTACH_FILES_PER_REQ },
  fileFilter: (req, file, cb) => {
    if (!ATTACH_ALLOWED_EXT.test(file.originalname)) {
      return cb(new Error('Tipo de archivo no permitido'));
    }
    cb(null, true);
  },
});

// Path-traversal guard. Returns the real absolute path if it's inside
// TASK_ATTACH_DIR, otherwise null. Mirrors applications.js#guardDocPath.
function guardAttachPath(rawPath) {
  try {
    const resolved = path.resolve(rawPath);
    const base     = path.resolve(TASK_ATTACH_DIR);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
    const realFile = fs.realpathSync(resolved);
    const realBase = fs.realpathSync(base);
    if (realFile === realBase) return null;
    if (!realFile.startsWith(realBase + path.sep)) return null;
    return realFile;
  } catch {
    return null;
  }
}

// Magic-byte mime sniff. Same `file-type` package the application docs use.
// Deletes the file and returns false on mismatch.
async function validateAttachMime(filePath) {
  try {
    const result = await fileTypeFromFile(filePath);
    // result is undefined for plain-text or unrecognized formats. Allow
    // text/plain + text/csv through by relying on the extension check
    // already done by multer fileFilter; everything else needs a hit.
    if (!result) {
      const ext = path.extname(filePath).toLowerCase();
      const textyExts = new Set(['.txt', '.csv', '.rtf']);
      if (textyExts.has(ext)) return true;
      fs.unlink(filePath, () => {});
      return false;
    }
    if (!ATTACH_ALLOWED_MIME.has(result.mime)) {
      fs.unlink(filePath, () => {});
      return false;
    }
    return true;
  } catch {
    fs.unlink(filePath, () => {});
    return false;
  }
}

// POST /api/tasks/:id/attachments — upload up to 5 files at once.
router.post('/:id/attachments', userAuth, (req, res, next) => {
  taskAttachUpload.array('files', ATTACH_FILES_PER_REQ)(req, res, (err) => {
    if (err) {
      // multer fileFilter / size errors land here. Surface a clean message.
      return res.status(400).json({ error: err.message || 'Error al subir archivo' });
    }
    next();
  });
}, async (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) {
    // Clean up any files multer already wrote — task didn't exist.
    for (const f of (req.files || [])) fs.unlink(f.path, () => {});
    return res.status(404).json({ error: 'Tarea no encontrada' });
  }
  if (!ensureCommentParticipant(task, req.user.sub)) {
    for (const f of (req.files || [])) fs.unlink(f.path, () => {});
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });
  }

  if (!Array.isArray(task.attachments)) task.attachments = [];
  const remainingSlots = ATTACH_LIMIT_PER_TASK - task.attachments.length;
  if (remainingSlots <= 0) {
    for (const f of (req.files || [])) fs.unlink(f.path, () => {});
    return res.status(400).json({ error: `Esta tarea ya tiene el máximo de ${ATTACH_LIMIT_PER_TASK} archivos.` });
  }

  const accepted = [];
  for (const f of (req.files || []).slice(0, remainingSlots)) {
    const ok = await validateAttachMime(f.path);
    if (!ok) continue;
    const att = {
      id:            uuid(),
      filename:      path.basename(f.path),       // stored name (uuid prefix)
      original_name: f.originalname,
      size:          f.size,
      mime:          f.mimetype,
      uploaded_by:   req.user.sub,
      uploaded_at:   new Date().toISOString(),
    };
    task.attachments.push(att);
    accepted.push(att);
  }
  // Files that came in after the slot limit — already wrote to disk; delete.
  for (const f of (req.files || []).slice(remainingSlots)) fs.unlink(f.path, () => {});

  if (accepted.length === 0) {
    return res.status(400).json({ error: 'Ningún archivo válido fue aceptado.' });
  }

  task.updated_at = new Date().toISOString();
  for (const a of accepted) {
    addTaskAudit(task, 'attachment_added', req.user.sub, {
      attachment_id: a.id, original_name: a.original_name, size: a.size,
    });
  }
  store.saveTask(task);

  // Notify the other participants there's new context to look at.
  const approverId = resolveApproverId(task);
  const targets = new Set([task.assigned_to, task.assigned_by, approverId]
    .filter(x => x && x !== 'system' && x !== req.user.sub));
  for (const target of targets) {
    pushNotify(target, {
      type:  'task_attachment',
      title: 'Nuevo archivo en una tarea',
      body:  task.title.slice(0, 80),
      url:   '/tareas',
    });
  }

  res.status(201).json({ attachments: accepted, total: task.attachments.length });
});

// GET /api/tasks/:id/attachments — list attachment metadata.
router.get('/:id/attachments', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (!ensureCommentParticipant(task, req.user.sub))
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });
  res.json({ attachments: Array.isArray(task.attachments) ? task.attachments : [] });
});

// GET /api/tasks/:id/attachments/:aid/file — download.
router.get('/:id/attachments/:aid/file', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (!ensureCommentParticipant(task, req.user.sub))
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });

  const att = (task.attachments || []).find(a => a.id === req.params.aid);
  if (!att) return res.status(404).json({ error: 'Archivo no encontrado' });

  const onDisk = guardAttachPath(path.join(TASK_ATTACH_DIR, att.filename));
  if (!onDisk || !fs.existsSync(onDisk))
    return res.status(404).json({ error: 'Archivo no disponible' });

  res.setHeader('Content-Type',        att.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${att.original_name.replace(/"/g, '')}"`);
  fs.createReadStream(onDisk).pipe(res);
});

// DELETE /api/tasks/:id/attachments/:aid — uploader or creator removes a file.
router.delete('/:id/attachments/:aid', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const list = Array.isArray(task.attachments) ? task.attachments : [];
  const idx  = list.findIndex(a => a.id === req.params.aid);
  if (idx < 0) return res.status(404).json({ error: 'Archivo no encontrado' });
  const att = list[idx];

  if (att.uploaded_by !== req.user.sub && task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Solo quien subió el archivo o el creador pueden eliminarlo' });

  // Best-effort file delete — even if disk delete fails, drop the metadata.
  const onDisk = guardAttachPath(path.join(TASK_ATTACH_DIR, att.filename));
  if (onDisk) fs.unlink(onDisk, () => {});

  list.splice(idx, 1);
  task.attachments = list;
  task.updated_at  = new Date().toISOString();
  addTaskAudit(task, 'attachment_deleted', req.user.sub, {
    attachment_id: att.id, original_name: att.original_name,
  });
  store.saveTask(task);
  res.json({ success: true });
});

// ── Helpers for auto-task creation (called from applications.js) ────────────

/**
 * Create an auto-generated task from an application event.
 * Deduplicates: if a pending task already exists for the same
 * application_id + source_event, skips silently (prevents duplicates
 * when e.g. a broker re-requests documents).
 *
 * The approver defaults to assigned_by (the broker who triggered the
 * event). That means the client who receives a "upload cedula" task
 * cannot mark it done themselves — the broker has to review and approve.
 */
function createAutoTask({ title, description, assigned_to, assigned_by, application_id, listing_id, source_event, due_date, approver_id }) {
  if (!assigned_to || !title) return null;

  // Dedup check
  if (application_id && source_event) {
    const existing = store.getTasksByApplication(application_id);
    if (existing.some(t => t.source_event === source_event && t.status !== 'completada' && t.status !== 'no_aplica')) {
      return null; // Already has a pending task for this event
    }
  }

  // Resolve the default approver. Prefer the explicit value, then
  // assigned_by (if it's a real user), otherwise leave null — the
  // task will auto-complete on submit because no approver exists.
  let resolvedApprover = approver_id || null;
  if (!resolvedApprover && assigned_by && assigned_by !== 'system') {
    resolvedApprover = assigned_by;
  }
  // Never let the approver equal the assignee for auto-tasks.
  if (resolvedApprover === assigned_to) resolvedApprover = null;

  const now = new Date().toISOString();
  const task = {
    id:             uuid(),
    title:          String(title).slice(0, 200),
    description:    String(description || '').slice(0, 2000),
    status:         'pendiente',
    priority:       'media',
    due_date:       due_date || null,
    assigned_to,
    assigned_by:    assigned_by || 'system',
    approver_id:    resolvedApprover,
    application_id: application_id || null,
    listing_id:     listing_id || null,
    source:         'auto',
    source_event:   source_event || null,
    approval_status: null,
    review_notes:    null,
    reviewed_at:     null,
    reviewed_by:     null,
    submitted_at:    null,
    completed_at:    null,
    created_at:      now,
    updated_at:      now,
  };

  addTaskAudit(task, 'created', task.assigned_by, {
    source:       'auto',
    source_event: source_event || null,
    application_id: application_id || null,
  });
  store.saveTask(task);

  // Push notification to assignee
  pushNotify(assigned_to, {
    type:  'task_assigned',
    title: 'Nueva tarea',
    body:  task.title.slice(0, 80),
    url:   '/tareas',
  });

  return task;
}

/**
 * Auto-complete all pending tasks for a given application + source_event.
 * Called when a superseding event happens (e.g. client uploads docs →
 * completes the "upload docs" task).
 *
 * NOTE: this is the ONE case where the approval loop is bypassed. It
 * only fires when the server itself detects that the work was done
 * (actual document uploaded, actual receipt verified). That's a
 * trusted signal — no review needed.
 */
function autoCompleteTasksByEvent(applicationId, sourceEvent) {
  if (!applicationId || !sourceEvent) return;
  const tasks = store.getTasksByApplication(applicationId);
  const now = new Date().toISOString();
  for (const t of tasks) {
    if (t.source_event === sourceEvent && t.status !== 'completada') {
      const prevStatus    = t.status;
      t.status            = 'completada';
      t.approval_status   = 'approved';
      t.completed_at      = now;
      t.updated_at        = now;
      addTaskAudit(t, 'status_change', 'system', {
        from: prevStatus, to: 'completada',
        action: 'auto_complete_by_event',
        source_event: sourceEvent,
      });
      maybeSpawnRecurrence(t, 'system');
      store.saveTask(t);
    }
  }
}

// ── Cross-cascade helpers ──────────────────────────────────────────────────
// Called from applications.js when an application is hard-deleted.
// We don't drop the task records (they may carry billable / SLA history)
// but we mark them archived so they no longer surface in lists or badges.
function archiveTasksByApplication(applicationId, actorId = 'system') {
  if (!applicationId) return 0;
  const tasks = store.getTasksByApplication(applicationId);
  let archived = 0;
  for (const t of tasks) {
    if (t.archived) continue;
    t.archived         = true;
    t.archived_at      = new Date().toISOString();
    t.archived_reason  = 'application_deleted';
    t.updated_at       = t.archived_at;
    addTaskAudit(t, 'archived', actorId, {
      reason: 'application_deleted',
      application_id: applicationId,
    });
    store.saveTask(t);
    archived++;
  }
  return archived;
}

// ── Email helper ────────────────────────────────────────────────────────────

async function sendTaskEmail(assigneeId, creatorName, task) {
  const user = store.getUserById(assigneeId);
  if (!user?.email) return;
  const firstName = (user.name || '').split(' ')[0] || 'Agente';
  const priorityLabel = task.priority === 'alta' ? 'Alta' : task.priority === 'baja' ? 'Baja' : 'Media';
  await transporter.sendMail({
    to:      user.email,
    subject: `Nueva tarea asignada — ${task.title.slice(0, 60)}`,
    html: et.layout({
      title: 'Nueva tarea asignada',
      preheader: `Nueva tarea asignada: ${task.title.slice(0, 80)}`,
      body:
        et.p(`Hola <strong>${et.esc(firstName)}</strong>,`)
        + et.p(`<strong>${et.esc(creatorName)}</strong> te asigno una nueva tarea:`)
        + et.infoTable(
            et.infoRow('Tarea', et.esc(task.title))
            + (task.description ? et.infoRow('Descripcion', et.esc(task.description.slice(0, 200))) : '')
            + et.infoRow('Prioridad', priorityLabel)
            + (task.due_date ? et.infoRow('Fecha limite', new Date(task.due_date).toLocaleDateString('es-DO')) : '')
          )
        + et.button('Ver mis tareas', `${BASE_URL}/broker`),
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLA / age-out handler
// ════════════════════════════════════════════════════════════════════════════
// Two breach signals per task:
//   1. overdue   — due_date is past AND status not in {completada, no_aplica}
//   2. idle      — updated_at older than 5 days AND status in
//                  {pendiente, en_progreso, pending_review}
// Each fires AT MOST once per UTC day per task (idempotency via
// `task.sla_last_overdue_at` / `task.sla_last_idle_at`). Notifications
// land on the responsible party for the current status:
//   - overdue: assignee + creator + approver (everyone needs to know)
//   - idle:    assignee for pendiente/en_progreso; approver for pending_review
const SLA_IDLE_MS = 5 * 24 * 60 * 60 * 1000;
async function tasksSlaCheck() {
  const now    = Date.now();
  const today  = new Date().toISOString().slice(0, 10);
  let issues   = 0;

  for (const t of store.getAllTasks()) {
    if (!t || t.archived) continue;
    if (t.status === 'completada' || t.status === 'no_aplica') continue;
    let updated = false;

    // ── Overdue ───────────────────────────────────────────────────────────
    if (t.due_date) {
      const dueAt = new Date(t.due_date).getTime();
      if (Number.isFinite(dueAt) && dueAt < now) {
        const lastDate = (t.sla_last_overdue_at || '').slice(0, 10);
        if (lastDate !== today) {
          t.sla_last_overdue_at = new Date().toISOString();
          addTaskAudit(t, 'sla_overdue', 'system', { due_date: t.due_date });
          const targets = new Set([t.assigned_to, t.assigned_by, resolveApproverId(t)]
            .filter(x => x && x !== 'system'));
          for (const u of targets) {
            pushNotify(u, {
              type:  'task_overdue',
              title: 'Tarea vencida',
              body:  (t.title || '').slice(0, 80),
              url:   '/tareas',
            });
          }
          issues++; updated = true;
        }
      }
    }

    // ── Idle ──────────────────────────────────────────────────────────────
    const updatedAt = t.updated_at ? new Date(t.updated_at).getTime() : 0;
    if (Number.isFinite(updatedAt) && updatedAt > 0 && (now - updatedAt) > SLA_IDLE_MS) {
      const lastDate = (t.sla_last_idle_at || '').slice(0, 10);
      if (lastDate !== today) {
        t.sla_last_idle_at = new Date().toISOString();
        addTaskAudit(t, 'sla_idle', 'system', { idle_since: t.updated_at });
        const target = (t.status === 'pending_review')
          ? resolveApproverId(t)
          : t.assigned_to;
        if (target && target !== 'system') {
          pushNotify(target, {
            type:  'task_idle',
            title: 'Tarea inactiva',
            body:  (t.title || '').slice(0, 80),
            url:   '/tareas',
          });
        }
        issues++; updated = true;
      }
    }

    if (updated) store.saveTask(t);
  }
  return issues;
}
slaRegistry.register('tasks', tasksSlaCheck);

module.exports = router;
module.exports.createAutoTask = createAutoTask;
module.exports.autoCompleteTasksByEvent = autoCompleteTasksByEvent;
module.exports.archiveTasksByApplication = archiveTasksByApplication;
module.exports.tasksSlaCheck = tasksSlaCheck;
