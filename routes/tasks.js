/**
 * tasks.js — To-Do / Task management
 *
 * Two sources of tasks:
 *   1. Auto-generated from application events (doc requests, uploads, payments)
 *   2. Manual — inmobiliaria/constructora assigns to their agents, or self-assigned
 *
 * Exported helpers (used by applications.js):
 *   createAutoTask({ title, description, assigned_to, assigned_by, application_id, listing_id, source_event, due_date })
 *   autoCompleteTasksByEvent(applicationId, sourceEvent)
 */

const express    = require('express');
const crypto     = require('crypto');
const store      = require('./store');
const { userAuth } = require('./auth');
const { notify: pushNotify } = require('./push');
const { createTransport } = require('./mailer');

const router      = express.Router();
const transporter = createTransport();
const uuid        = () => crypto.randomUUID();
const PRO_ROLES   = ['agency', 'broker', 'inmobiliaria', 'constructora'];
const BASE_URL    = process.env.BASE_URL || 'https://hogaresrd.com';

// ── GET /api/tasks — list tasks for the current user ────────────────────────
// Returns tasks where user is assignee OR creator.
// Query params: ?status=pendiente&priority=alta&application_id=X&overdue=true
router.get('/', userAuth, (req, res) => {
  let tasks = store.getTasksByUser(req.user.sub);

  const { status, priority, application_id, overdue } = req.query;
  if (status)         tasks = tasks.filter(t => t.status === status);
  if (priority)       tasks = tasks.filter(t => t.priority === priority);
  if (application_id) tasks = tasks.filter(t => t.application_id === application_id);
  if (overdue === 'true') {
    const now = new Date().toISOString();
    tasks = tasks.filter(t => t.due_date && t.due_date < now && t.status !== 'completada');
  }

  res.json({ tasks });
});

// ── GET /api/tasks/:id — single task ────────────────────────────────────────
router.get('/:id', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_to !== req.user.sub && task.assigned_by !== req.user.sub)
    return res.status(403).json({ error: 'Sin acceso a esta tarea' });
  res.json(task);
});

// ── POST /api/tasks — create a task ─────────────────────────────────────────
// Any user can self-assign. Only inmobiliaria/constructora can assign to
// agents within their team.
router.post('/', userAuth, (req, res) => {
  const creator = store.getUserById(req.user.sub);
  if (!creator) return res.status(401).json({ error: 'Usuario no encontrado' });

  const { title, description, priority, due_date, assigned_to, application_id, listing_id } = req.body;
  if (!title || !title.trim())
    return res.status(400).json({ error: 'Título requerido' });

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

  const now = new Date().toISOString();
  const task = {
    id:             uuid(),
    title:          title.trim().slice(0, 200),
    description:    (description || '').trim().slice(0, 2000),
    status:         'pendiente',
    priority:       ['alta', 'media', 'baja'].includes(priority) ? priority : 'media',
    due_date:       due_date || null,
    assigned_to:    assigneeId,
    assigned_by:    req.user.sub,
    application_id: application_id || null,
    listing_id:     listing_id || null,
    source:         'manual',
    source_event:   null,
    completed_at:   null,
    created_at:     now,
    updated_at:     now,
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

  res.status(201).json(task);
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
  if (status && ['pendiente', 'en_progreso', 'completada'].includes(status)) {
    task.status = status;
    if (status === 'completada' && !task.completed_at) task.completed_at = new Date().toISOString();
    if (status !== 'completada') task.completed_at = null;
  }
  if (priority && ['alta', 'media', 'baja'].includes(priority)) task.priority = priority;
  if (due_date !== undefined) task.due_date = due_date || null;
  task.updated_at = new Date().toISOString();

  store.saveTask(task);
  res.json(task);
});

// ── POST /api/tasks/:id/complete — quick-complete ───────────────────────────
router.post('/:id/complete', userAuth, (req, res) => {
  const task = store.getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  if (task.assigned_to !== req.user.sub)
    return res.status(403).json({ error: 'Solo el asignado puede completar esta tarea' });

  task.status       = 'completada';
  task.completed_at = new Date().toISOString();
  task.updated_at   = task.completed_at;
  store.saveTask(task);

  // Notify the creator if it's someone else
  if (task.assigned_by !== req.user.sub && task.assigned_by !== 'system') {
    pushNotify(task.assigned_by, {
      type:  'task_completed',
      title: 'Tarea completada',
      body:  task.title.slice(0, 80),
      url:   '/broker',
    });
  }

  res.json(task);
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
 */
function createAutoTask({ title, description, assigned_to, assigned_by, application_id, listing_id, source_event, due_date }) {
  if (!assigned_to || !title) return null;

  // Dedup check
  if (application_id && source_event) {
    const existing = store.getTasksByApplication(application_id);
    if (existing.some(t => t.source_event === source_event && t.status !== 'completada')) {
      return null; // Already has a pending task for this event
    }
  }

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
    application_id: application_id || null,
    listing_id:     listing_id || null,
    source:         'auto',
    source_event:   source_event || null,
    completed_at:   null,
    created_at:     now,
    updated_at:     now,
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
 */
function autoCompleteTasksByEvent(applicationId, sourceEvent) {
  if (!applicationId || !sourceEvent) return;
  const tasks = store.getTasksByApplication(applicationId);
  const now = new Date().toISOString();
  for (const t of tasks) {
    if (t.source_event === sourceEvent && t.status !== 'completada') {
      t.status       = 'completada';
      t.completed_at = now;
      t.updated_at   = now;
      store.saveTask(t);
    }
  }
}

// ── Email helper ────────────────────────────────────────────────────────────

async function sendTaskEmail(assigneeId, creatorName, task) {
  const user = store.getUserById(assigneeId);
  if (!user?.email) return;
  const firstName = (user.name || '').split(' ')[0] || 'Agente';
  const dueLine = task.due_date
    ? `<tr><td style="padding:4px 0;color:#7a9bbf;">Fecha límite:</td><td style="padding:4px 0;"><strong>${new Date(task.due_date).toLocaleDateString('es-DO')}</strong></td></tr>`
    : '';
  await transporter.sendMail({
    to:      user.email,
    subject: `Nueva tarea asignada — ${task.title.slice(0, 60)}`,
    html: `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
<table width="100%" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
  <tr><td style="background:linear-gradient(135deg,#002D62,#1a5fa8);padding:24px 32px;">
    <div style="font-size:1.1rem;font-weight:800;color:#fff;">Nueva tarea asignada</div>
  </td></tr>
  <tr><td style="padding:24px 32px;">
    <p style="margin:0 0 12px;color:#1a2b40;">Hola <strong>${firstName}</strong>,</p>
    <p style="margin:0 0 16px;font-size:0.92rem;color:#4d6a8a;"><strong>${creatorName}</strong> te asignó una nueva tarea:</p>
    <div style="background:#f0f6ff;border-radius:10px;padding:14px 18px;margin-bottom:14px;">
      <div style="font-size:1rem;font-weight:700;color:#002D62;margin-bottom:6px;">${task.title}</div>
      ${task.description ? `<div style="font-size:0.85rem;color:#4d6a8a;margin-bottom:8px;">${task.description.slice(0, 200)}</div>` : ''}
      <table style="font-size:0.85rem;color:#1a2b40;">
        <tr><td style="padding:4px 0;color:#7a9bbf;">Prioridad:</td><td style="padding:4px 0;"><strong>${task.priority === 'alta' ? 'Alta' : task.priority === 'baja' ? 'Baja' : 'Media'}</strong></td></tr>
        ${dueLine}
      </table>
    </div>
    <a href="${BASE_URL}/broker" style="display:inline-block;background:#002D62;color:#fff;font-size:0.9rem;font-weight:700;padding:12px 28px;border-radius:10px;text-decoration:none;">Ver mis tareas →</a>
  </td></tr>
</table>
</td></tr></table></body></html>`,
  });
}

module.exports = router;
module.exports.createAutoTask = createAutoTask;
module.exports.autoCompleteTasksByEvent = autoCompleteTasksByEvent;
