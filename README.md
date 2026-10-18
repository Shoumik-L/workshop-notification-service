# Workshop Registration and Notifications

A backend service for registering members to workshops, together with a mock notification service. A member who registers receives a confirmation, and when a workshop is cancelled every registered member receives a cancellation message. Registration replies immediately and never waits for the notification service, which is allowed to fail, time out, or go down.

**Stack:** Node.js 18+, Express 5, PostgreSQL, the `pg` library. Plain JavaScript with no other dependencies.

## Overview

The service has three parts:

* **Backend** (port 3000): workshops, registrations, cancellation, and a background worker that delivers notifications.
* **PostgreSQL**: stores workshops, registrations, and a table of notifications waiting to be sent.
* **Mock notification service** (port 4000): a fake email/SMS provider that fails and times out on purpose. A successful response means the message was delivered.

## How it works

The central design is the **outbox pattern**. If registration called the notification service directly, a slow or broken service would make registration slow or broken, and a crash between saving the registration and sending the message would lose the confirmation. Instead:

1. Registration saves the registration and a "message to send" row in **one database transaction**.
2. The backend replies right away.
3. A background loop reads the pending rows and delivers them, retrying when delivery fails.

The table of messages to send is the outbox. Because it lives in the database, it survives crashes and restarts.

```
POST /workshops/1/register
        |
        v
  one database transaction
  |-- INSERT registration
  '-- INSERT notification (status = pending)
        |
        v
  reply 201 to the member

  --- in the background ---

  worker loop (runs inside the backend):
     find notifications that are pending and due
        |
        v
     send to the notification service (2 second timeout)
        |-- success --> status = sent
        '-- failure --> attempts + 1, retry later (wait roughly doubles)
                        after 8 attempts --> status = failed
```

## Project structure

```
db/schema.sql                         the three tables
src/server.js                         creates the tables, starts the worker, starts the web server
src/app.js                            Express setup and error handler
src/db.js                             database pool and the withTransaction helper
src/routes/workshops.js               create, list, register, cancel
src/routes/notifications.js           read-only view of the outbox
src/worker.js                         loop that delivers pending notifications
src/notifier.js                       sends one message to the notification service
src/backoff.js                        computes the wait before a retry
mock-notification-service/server.js   the unreliable fake provider
scripts/demo.js                       end-to-end scenario with PASS/FAIL checks
test/backoff.test.js                  unit tests
```

## Database

| Table | Purpose | Key rule |
|---|---|---|
| `workshops` | id, title, `status` (`active` or `cancelled`) | |
| `registrations` | which member registered for which workshop | `UNIQUE (workshop_id, member_id)`: the database refuses a second registration |
| `notifications` | the outbox, one row per message to send | `UNIQUE (workshop_id, member_id, kind)`: never two rows for the same message |

A notification row holds its `kind` (`confirmation` or `cancellation`), `status` (`pending`, `sent`, `failed`), `attempts`, `next_attempt_at` (earliest time of the next attempt), `last_error`, and `sent_at`.

## Registration

`POST /workshops/:id/register` runs inside one transaction (`withTransaction` in `src/db.js`):

1. `SELECT ... FOR UPDATE` locks the workshop row, so a registration and a cancellation cannot interleave and miss each other.
2. A missing workshop gives `404`; a cancelled one gives `409`.
3. The registration is inserted. If the member is already registered, PostgreSQL raises a unique violation (error code `23505`), the transaction rolls back, and the route answers `409`.
4. A `confirmation` notification is inserted with status `pending`.
5. The transaction commits and the route replies `201`.

Because steps 3 and 4 share a transaction, a failed registration never leaves a confirmation behind, and a successful registration always has its confirmation in the outbox before the member sees the reply. Concurrent requests for the same member are resolved by the unique constraint, so only one registration is created.

## Cancellation

`POST /workshops/:id/cancel` also runs in one transaction:

1. `UPDATE workshops SET status = 'cancelled' WHERE id = ... AND status = 'active'`. If no row changes, the workshop is missing (`404`) or already cancelled (`409`).
2. `INSERT INTO notifications ... SELECT ... FROM registrations` creates one cancellation row for every registered member in a single statement.

Every member has an independent row, so a failing delivery to one member cannot block delivery to the others.

## Notification worker

`src/worker.js` starts together with the backend and loops forever:

1. Select up to 20 rows with `status = 'pending'` and `next_attempt_at <= now()`.
2. Deliver them in parallel. Each message is handled by its own `try/catch`, so one failure affects only that message.
3. On success the row becomes `sent`.
4. On failure the worker increments `attempts`, stores the error in `last_error`, and sets `next_attempt_at` to a later time. After 8 attempts the row becomes `failed`.
5. If nothing was due, the worker sleeps for half a second.

Each delivery (`src/notifier.js`) is an HTTP `POST` to the notification service with a 2 second timeout, so a service that never answers cannot block the worker. Any response that is not 2xx counts as a failure.

The wait between attempts (`src/backoff.js`) roughly doubles each time: about 2 s, 4 s, 8 s, 16 s, capped at 20 s. Each value is multiplied by a random factor between 0.75 and 1.25 (jitter) so failed messages do not all retry at the same moment.

## Delivery guarantees

**Lost notifications.** A notification is a database row created in the same transaction as the registration, so it cannot be lost between being saved and being queued. A row leaves `pending` only after the notification service answered with success. A message that fails 8 times becomes `failed` and stays in the table with `last_error` explaining why.

**Retries.** Every error, timeout, or non-2xx response schedules another attempt with exponential backoff and jitter. Messages are retried independently of each other.

**Duplicate delivery.** Delivery is at-least-once. If the service delivers a message but the reply is lost, the backend cannot know and retries, so the message can arrive twice. To make this harmless, every request carries an `Idempotency-Key` header (for example `confirmation:workshop-1:member-alice`) that is identical on every retry of the same message. The receiver ignores keys it has already seen. In the database, `UNIQUE (workshop_id, member_id)` prevents double registration and `UNIQUE (workshop_id, member_id, kind)` prevents duplicate notification rows.

**Backend restarts.** All delivery state (`status`, `attempts`, `next_attempt_at`) is stored in PostgreSQL and nothing is kept in memory. When the backend starts, the worker simply continues with the rows that are still `pending`. If the process stops in the middle of a send, that row is still `pending` and is sent again after the restart, which the idempotency key makes safe.

## Mock notification service

`mock-notification-service/server.js` listens on port 4000. For each `POST /notify`:

* If it has been put "down": it answers `503`.
* With probability `TIMEOUT_RATE` (default 10%): it does not answer within the client's timeout. Half of these timeouts record the delivery first, so the message was delivered but the reply is lost. The backend's retry then carries the same `Idempotency-Key`, and the mock ignores the repeat.
* With probability `FAIL_RATE` (default 20%): it answers `500`.
* Otherwise: it records the delivery and answers `200`.

Control endpoints: `POST /admin/down`, `POST /admin/up`, `GET /admin/stats`, `GET /admin/delivered`, `POST /admin/reset`.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/workshops` with `{"title": "..."}` | Create a workshop |
| GET | `/workshops`, `/workshops/:id` | List / get |
| POST | `/workshops/:id/register` with `{"memberId": "..."}` | Register a member. `201`, or `409` if already registered or the workshop is cancelled |
| GET | `/workshops/:id/registrations` | List registered members |
| POST | `/workshops/:id/cancel` | Cancel and queue a notification for every member. `409` if already cancelled |
| GET | `/notifications?status=pending` | View the outbox |
| GET | `/notifications/summary` | Counts of pending / sent / failed |
| GET | `/health` | Liveness check |

## Configuration

Environment variables, all optional except `DATABASE_URL` when your database differs from the default:

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/workshops` | Database connection |
| `PORT` | 3000 | Backend port |
| `NOTIFY_URL` | `http://localhost:4000` | Address of the notification service |
| `NOTIFY_TIMEOUT_MS` | 2000 | Time to wait for one delivery call |
| `MAX_ATTEMPTS` | 8 | Attempts before a message is marked `failed` |
| `RETRY_BASE_SECONDS` | 2 | First retry wait |
| `RETRY_CAP_SECONDS` | 20 | Longest wait between attempts |
| `FAIL_RATE`, `TIMEOUT_RATE` | 0.2, 0.1 | Mock service only |

## Running locally

### Requirements

* Node.js 18 or newer (`node -v`)
* PostgreSQL (`psql --version`)

On Windows with WSL, run PostgreSQL, the mock service, the backend, and the demo all inside WSL. WSL and Windows behave like separate machines on the network, and mixing them makes the backend unable to reach the mock service.

### Setup

Start PostgreSQL (on WSL this is needed each time WSL is restarted):

```bash
sudo service postgresql start
```

Create the database, using your own password:

```bash
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'YOURPASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE workshops;"
```

Install dependencies:

```bash
npm install
```

The tables are created automatically when the backend starts.

### Start the services

Use three terminals, all in the project folder and all of the same kind.

Terminal 1, the mock notification service:

```bash
npm run mock
```

Terminal 2, the backend:

```bash
DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/workshops npm start
```

The backend prints one line per delivery attempt, for example:

```
sent      #1 confirmation -> alice
retry     #4 confirmation -> dave (attempt 1 failed: notification service answered 503; next in 2.5s)
sent      #4 confirmation -> dave
```

### Demo

Terminal 3:

```bash
npm run demo
```

`scripts/demo.js` runs this scenario and prints PASS or FAIL for each check:

1. Registers three members. Each reply returns in milliseconds, without waiting for a notification.
2. Registers one of them again and expects `409`.
3. Waits for the three confirmations to be delivered.
4. Puts the mock service down, registers two more members, and checks that their messages stay pending while `attempts` increases.
5. Brings the mock service back and waits for all five confirmations.
6. Cancels the workshop, checks that five cancellation messages are created, and that a second cancel and a late registration both return `409`.
7. Prints the outbox summary and the mock service counters, and checks that ten messages were sent, none failed, and the mock holds ten unique deliveries.

The run ends with `ALL CHECKS PASSED`. It can take from about 10 to 60 seconds because the mock service fails at random and the worker retries.

### Tests

```bash
npm test
```

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:5432` on backend start | PostgreSQL is not running. Run `sudo service postgresql start`. |
| `password authentication failed` | The password in `DATABASE_URL` differs from the one set for the `postgres` user. |
| `database "workshops" does not exist` | Create it with `CREATE DATABASE workshops;`. |
| `EADDRINUSE` on port 3000 or 4000 | Another copy is still running. Stop it with Ctrl+C. |
| Messages end up `failed` with `fetch failed`, and the mock's counters show `"requests": 0` | The backend cannot reach the mock service, usually because they run in different environments (Windows and WSL). Run everything in the same environment, and make sure `NOTIFY_URL` is unset or correct. |
| Need the reason a message failed | Read `last_error` in the `notifications` table or the `retry` lines in the backend output. Connection problems show the cause in brackets, for example `fetch failed (ECONNREFUSED)`. |
| Old failed rows affect a new run | Run `DROP TABLE IF EXISTS notifications, registrations, workshops;` in the database and restart the backend, which recreates the tables. |

## Design decisions and limitations

* A single worker delivers all notifications. This keeps the logic simple and correct; two workers would need row locking (`SELECT ... FOR UPDATE SKIP LOCKED`) to avoid taking the same row.
* The worker polls the database every half second, which adds up to about 0.5 s of delay before a message is first attempted.
* If a workshop is cancelled while a confirmation is still pending, the member receives both messages, because every successful registration must produce a confirmation.
* There is no authentication and no capacity limit. `memberId` is a plain string in the request body.
* The mock service keeps its received keys in memory, so restarting it clears them.
* A message that fails 8 times is marked `failed` and is not retried again automatically.

