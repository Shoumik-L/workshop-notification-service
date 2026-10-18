// Sends ONE notification to the mock HTTP service. Throws if it did not clearly succeed.
const NOTIFY_URL = process.env.NOTIFY_URL || 'http://localhost:4000';
const TIMEOUT_MS = Number(process.env.NOTIFY_TIMEOUT_MS) || 2000;

async function sendNotification(n) {
  // The idempotency key is the same on every retry of the same message.
  // The receiving service can use it to ignore duplicates.
  const idempotencyKey = `${n.kind}:workshop-${n.workshop_id}:member-${n.member_id}`;

  const res = await fetch(`${NOTIFY_URL}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ workshopId: n.workshop_id, memberId: n.member_id, kind: n.kind }),
    signal: AbortSignal.timeout(TIMEOUT_MS), // give up if the service does not answer in time
  });
  if (!res.ok) throw new Error(`notification service answered ${res.status}`);
}

module.exports = { sendNotification };
