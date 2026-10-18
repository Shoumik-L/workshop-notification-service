// The outbox worker: a loop that delivers pending notifications.
//
//   find pending rows that are due  ->  send each one  ->  mark sent  (or schedule a retry)
//
// All state lives in the database (status / attempts / next_attempt_at), so if the backend
// restarts, the loop simply continues with whatever is still pending.
const { pool } = require('./db');
const { sendNotification } = require('./notifier');
const { retryDelaySeconds } = require('./backoff');

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS) || 8;
const BATCH = 20;
const RETRY_BASE_SECONDS = Number(process.env.RETRY_BASE_SECONDS) || 2;
const RETRY_CAP_SECONDS = Number(process.env.RETRY_CAP_SECONDS) || 20; // longest wait between two attempts
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Handles ONE notification. It catches its own errors, so one bad member never stops the others.
async function deliver(n) {
  try {
    await sendNotification(n);
    await pool.query(
      `UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`,
      [n.id]
    );
    console.log(`sent      #${n.id} ${n.kind} -> ${n.member_id}`);
  } catch (err) {
    const attempts = n.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE notifications SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1`,
        [n.id, attempts, err.message]
      );
      console.log(`GAVE UP   #${n.id} ${n.kind} -> ${n.member_id} after ${attempts} attempts`);
    } else {
      const delay = retryDelaySeconds(attempts, RETRY_BASE_SECONDS, RETRY_CAP_SECONDS);
      await pool.query(
        `UPDATE notifications
         SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4::float8)
         WHERE id = $1`,
        [n.id, attempts, err.message, delay]
      );
      console.log(`retry     #${n.id} ${n.kind} -> ${n.member_id} (attempt ${attempts} failed: ${err.message}; next in ${delay.toFixed(1)}s)`);
    }
  }
}

async function processDue() {
  const { rows } = await pool.query(
    `SELECT * FROM notifications
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY id LIMIT $1`,
    [BATCH]
  );
  await Promise.all(rows.map(deliver)); // send the batch in parallel
  return rows.length;
}

async function workerLoop() {
  while (true) {
    try {
      const handled = await processDue();
      if (handled === 0) await sleep(500); // nothing due: rest a little
    } catch (err) {
      console.error('worker error:', err.message); // e.g. database briefly down
      await sleep(2000);
    }
  }
}

module.exports = { workerLoop, processDue };
