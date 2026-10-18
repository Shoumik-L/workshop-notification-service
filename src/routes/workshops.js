const express = require('express');
const { pool, withTransaction } = require('../db');
const { HttpError } = require('../httpError');

const router = express.Router();

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'invalid id');
  return id;
}

// Organizer creates a workshop
router.post('/', async (req, res) => {
  const title = req.body && req.body.title;
  if (typeof title !== 'string' || title.trim() === '') throw new HttpError(400, 'title is required');
  const { rows } = await pool.query('INSERT INTO workshops (title) VALUES ($1) RETURNING *', [title.trim()]);
  res.status(201).json(rows[0]);
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT w.*, COUNT(r.id)::int AS registrations
     FROM workshops w LEFT JOIN registrations r ON r.workshop_id = w.id
     GROUP BY w.id ORDER BY w.id`
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query('SELECT * FROM workshops WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'workshop not found');
  res.json(rows[0]);
});

router.get('/:id/registrations', async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(
    'SELECT member_id AS "memberId", created_at AS "createdAt" FROM registrations WHERE workshop_id = $1 ORDER BY id',
    [id]
  );
  res.json(rows);
});

// Member registers.
// Registration row + notification row are saved in ONE transaction:
//   - both saved, or neither (a failed registration never creates a confirmation)
//   - the confirmation is already "in the outbox" before we reply, so it survives a crash
router.post('/:id/register', async (req, res) => {
  const workshopId = parseId(req.params.id);
  const memberId = req.body && req.body.memberId;
  if (typeof memberId !== 'string' || memberId.trim() === '') throw new HttpError(400, 'memberId is required');

  try {
    const registration = await withTransaction(async (client) => {
      // FOR UPDATE locks the workshop row, so a cancel and a register cannot interleave:
      // the cancel either sees this registration, or this register sees "cancelled".
      const w = await client.query('SELECT id, status FROM workshops WHERE id = $1 FOR UPDATE', [workshopId]);
      if (!w.rows[0]) throw new HttpError(404, 'workshop not found');
      if (w.rows[0].status !== 'active') throw new HttpError(409, 'workshop is cancelled');

      const reg = await client.query(
        'INSERT INTO registrations (workshop_id, member_id) VALUES ($1, $2) RETURNING id, workshop_id, member_id, created_at',
        [workshopId, memberId.trim()]
      );
      await client.query(
        `INSERT INTO notifications (workshop_id, member_id, kind) VALUES ($1, $2, 'confirmation')`,
        [workshopId, memberId.trim()]
      );
      return reg.rows[0];
    });
    // We reply now. We do NOT wait for the notification service.
    res.status(201).json({
      registrationId: registration.id,
      workshopId: registration.workshop_id,
      memberId: registration.member_id,
      message: 'registered; confirmation will be sent shortly',
    });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'member is already registered for this workshop'); // unique violation
    throw err;
  }
});

// Organizer cancels. Every registered member gets a cancellation notification row,
// created in the same transaction that marks the workshop cancelled.
router.post('/:id/cancel', async (req, res) => {
  const workshopId = parseId(req.params.id);

  const notified = await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE workshops SET status = 'cancelled' WHERE id = $1 AND status = 'active' RETURNING id`,
      [workshopId]
    );
    if (!updated.rows[0]) {
      const exists = await client.query('SELECT status FROM workshops WHERE id = $1', [workshopId]);
      if (!exists.rows[0]) throw new HttpError(404, 'workshop not found');
      throw new HttpError(409, 'workshop is already cancelled');
    }
    // One row per member. A failure for one member later cannot affect the others.
    const inserted = await client.query(
      `INSERT INTO notifications (workshop_id, member_id, kind)
       SELECT workshop_id, member_id, 'cancellation' FROM registrations WHERE workshop_id = $1
       ON CONFLICT DO NOTHING`,
      [workshopId]
    );
    return inserted.rowCount;
  });

  res.json({ workshopId, status: 'cancelled', membersToNotify: notified });
});

module.exports = router;
