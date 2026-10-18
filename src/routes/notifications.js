const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Handy for demos: see the outbox. Optional filter: ?status=pending
router.get('/', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.status) { params.push(req.query.status); where = 'WHERE status = $1'; }
  const { rows } = await pool.query(
    `SELECT id, workshop_id AS "workshopId", member_id AS "memberId", kind, status, attempts,
            next_attempt_at AS "nextAttemptAt", last_error AS "lastError", sent_at AS "sentAt"
     FROM notifications ${where} ORDER BY id LIMIT 500`,
    params
  );
  res.json(rows);
});

router.get('/summary', async (req, res) => {
  const { rows } = await pool.query('SELECT status, COUNT(*)::int AS count FROM notifications GROUP BY status');
  const summary = { pending: 0, sent: 0, failed: 0 };
  rows.forEach((r) => { summary[r.status] = r.count; });
  res.json(summary);
});

module.exports = router;
