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
const store      = require('./store');
const { userAuth } = require('./auth');
const { notify: pushNotify } = require('./push');
const { createTransport } = require('./mailer');
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
      out.listing_image = images[0] || null;
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
        out.listing_image = out.listing_image || images[0] || null;
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

// ── GET /api/tasks — list tasks for the current user ────────────────────────
// Returns tasks where user is assignee, creator, OR approver. Approvers
// need to see tasks sitting in pending_review so they can act on them.
router.get('/', userAuth, (req, res) => {
  const uid = req.user.sub;
  let tasks = store.getTasksByUser(uid);
  // Include tasks where the user is the approver but neither assignee
  // nor creator (reassigned approvals).
  const asApprover = store.getTasksByUser.length ? [] : [];
  // getTasksByUser already covers assigned_to and assigned_by.
  // If we ever add an approver_id column we can index on it; for now
  // the in-memory scan is fine.
  const allTasks = store.getTasksByUser(uid); // returns both assignee+creator
  const extraApprover = []; // placeholder — covered by all-scan below
  const all = store._tasks || [];
  if (Array.isArray(all)) {
    for (const row of all) {
      const t = store.getTaskById(row.id);
      if (!t) continue;
      const approverId = resolveApproverId(t);
      if (approverId === uid && t.assigned_to !== uid && t.assigned_by !== uid) {
        tasks.push(t);
      }
    }
  }
  // Dedupe by id
  const seen = new Set();
  tasks = tasks.filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true)));

  const { status, priority, application_id, overdue } = req.query;
  if (status)         tasks = tasks.filter(t => t.status === status);
  if (priority)       tasks = tasks.filter(t => t.priority === priority);
  if (application_id) tasks = tasks.filter(t => t.application_id === application_id);
  if (overdue === 'true') {
    const now = new Date().toISOString();
    tasks = tasks.filter(t => t.due_date && t.due_date < now && t.status !== 'completada');
  }

  // Org-scoping: if the user belongs to an org, only show tasks from the same org
  const fullUser = store.getUserById(uid);
  const userOrgId = ['inmobiliaria','constructora'].includes(fullUser?.role) ? fullUser.id : fullUser?.inmobiliaria_id;
  if (userOrgId) {
    tasks = tasks.filter(t => {
      // Check if the task creator belongs to the same org
      const creator = store.getUserById(t.assigned_by);
      const creatorOrgId = creator ? (['inmobiliaria','constructora'].includes(creator.role) ? creator.id : creator.inmobiliaria_id) : null;
      if (creatorOrgId === userOrgId) return true;
      // Check if the task's application belongs to the same org
      if (t.application_id) {
        const app = store.getApplicationById(t.application_id);
        if (app && app.inmobiliaria_id === userOrgId) return true;
      }
      return false;
    });
  }

  // Enrich each task with listing thumbnail + title before returning
  res.json({ tasks: tasks.map(enrichTask) });
});

// ── GET /api/tasks/badge-count — unread / actionable count for the user ─────
// Returns the number of tasks that currently need the user's attention:
//   - assigned_to user: pendiente / en_progreso (things they haven't done yet)
//   - approver user:    pending_review (things waiting on their review)
// Used to drive the red badge on the "Tareas" menu entry.
router.get('/badge-count', userAuth, (req, res) => {
  const uid = req.user.sub;
  const all = store._tasks || [];
  let count = 0;
  for (const row of all) {
    const t = store.getTaskById(row.id);
    if (!t) continue;
    if (t.status === 'completada' || t.status === 'no_aplica') continue;
    const approverId = resolveApproverId(t);
    // Task assigned to me and still actionable
    if (t.assigned_to === uid && (t.status === 'pendiente' || t.status === 'en_progreso')) {
      count++;
      continue;
    }
    // Task waiting for my review (as approver, not assignee)
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

  // Verify org scope: if user belongs to an org, task must be from same org
  const fullUser = store.getUserById(req.user.sub);
  const userOrgId = ['inmobiliaria','constructora'].includes(fullUser?.role) ? fullUser.id : fullUser?.inmobiliaria_id;
  if (userOrgId && task.application_id) {
    const app = store.getApplicationById(task.application_id);
    if (app && app.inmobiliaria_id && app.inmobiliaria_id !== userOrgId) {
      return res.status(403).json({ error: 'Sin acceso a esta tarea' });
    }
  }

  res.json(enrichTask(task));
});

// ── POST /api/tasks — create a task ─────────────────────────────────────────
// Any user can self-assign. Only inmobiliaria/constructora can assign to
// agents within their team.
router.post('/', userAuth, (req, res) => {
  const creator = store.getUserById(req.user.sub);
  if (!creator) return res.status(401).json({ error: 'Usuario no encontrado' });

  const { title, description, priority, due_date, assigned_to, application_id, listing_id, approver_id } = req.body;
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

  store.saveTask(task);

  // Notify assignee if it's someone else
  if (assigneeId !== req.user.sub) {
    const assigneeName = store.getUserById(assigneeId)?.name || '';
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
router.put('/:id', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_to !== req.user.sub && task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });

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

  if (requiresApproval(task)) {
    task.status          = 'pending_review';
    task.approval_status = 'pending_review';
    task.submitted_at    = now;
    task.updated_at      = now;
    // Clear any prior rejection so the approver sees a clean state
    task.review_notes    = null;
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
  task.status          = 'completada';
  task.approval_status = 'approved';
  task.completed_at    = now;
  task.updated_at      = now;
  store.saveTask(task);

  if (task.assigned_by !== req.user.sub && task.assigned_by !== 'system') {
    pushNotify(task.assigned_by, {
      type:  'task_completed',
      title: 'Tarea completada',
      body:  task.title.slice(0, 80),
      url:   '/broker',
    });
  }
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
  store.saveTask(task);

  pushNotify(task.assigned_to, {
    type:  'task_approved',
    title: 'Tarea aprobada ✓',
    body:  task.title.slice(0, 80),
    url:   '/broker',
  });

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
  store.saveTask(task);

  pushNotify(task.assigned_to, {
    type:  'task_rejected',
    title: 'Tarea devuelta para revisión',
    body:  (note || task.title).slice(0, 80),
    url:   '/broker',
  });

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
  task.status          = 'no_aplica';
  task.approval_status = 'not_applicable';
  task.review_notes    = note || null;
  task.reviewed_by     = req.user.sub;
  task.reviewed_at     = now;
  task.completed_at    = now;
  task.updated_at      = now;
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
  res.json(enrichTask(task));
});

// ── PUT /api/tasks/:id/approver — reassign who approves this task ───────────
// Only the current approver (or admin) can delegate. New approver cannot
// be the assignee.
router.put('/:id/approver', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const currentApprover = resolveApproverId(task);
  const user = store.getUserById(req.user.sub);
  const isAdmin = user?.role === 'admin';
  if (currentApprover !== req.user.sub && !isAdmin)
    return res.status(403).json({ error: 'Solo el aprobador actual puede reasignar' });

  const { approver_id: newApproverId } = req.body || {};
  if (!newApproverId)
    return res.status(400).json({ error: 'approver_id es requerido' });
  if (newApproverId === task.assigned_to)
    return res.status(400).json({ error: 'El aprobador no puede ser la misma persona que ejecuta la tarea' });
  const newApprover = store.getUserById(newApproverId);
  if (!newApprover)
    return res.status(404).json({ error: 'Usuario aprobador no encontrado' });

  task.approver_id = newApproverId;
  task.updated_at  = new Date().toISOString();
  store.saveTask(task);

  pushNotify(newApproverId, {
    type:  'task_approver_assigned',
    title: 'Te asignaron una tarea para revisar',
    body:  task.title.slice(0, 80),
    url:   '/broker',
  });

  res.json(enrichTask(task));
});

// ── DELETE /api/tasks/:id ───────────────────────────────────────────────────
router.delete('/:id', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Solo el creador puede eliminar esta tarea' });
  store.deleteTask(task.id);
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
    if (existing.some(t => t.source_event === source_event && t.status !== 'completada')) {
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
      t.status          = 'completada';
      t.approval_status = 'approved';
      t.completed_at    = now;
      t.updated_at      = now;
      store.saveTask(t);
    }
  }
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

module.exports = router;
module.exports.createAutoTask = createAutoTask;
module.exports.autoCompleteTasksByEvent = autoCompleteTasksByEvent;
