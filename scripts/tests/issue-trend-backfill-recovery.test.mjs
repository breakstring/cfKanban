import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTrendBackfillEvidence } from '../../packages/skill-runtime/src/issue-trend-backfill.mjs';
import { canonicalDigest } from '../../packages/skill-runtime/src/utils.mjs';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fence = 7;
const databaseNowMs = 200000;

function checkpoint(issue, version, cursor) {
  return { type: 'trend_backfill_batch_started', batch_id: canonicalDigest({ runId, fence, issue, version, cursor }),
    issue_id: issue, original_version: version, original_cursor: cursor };
}

function fixture() {
  const previous = checkpoint('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 3, 900);
  const current = checkpoint('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 4, 500);
  const events = [{ type: 'trend_backfill_lease_acquired', run_id: runId, fence }, previous,
    { ...previous, type: 'trend_backfill_batch_finished', finished: true }, current,
    { type: 'trend_backfill_query_started', query_id: 'commit-current', label: 'history_commit' }];
  const inspection = { lease: { run_id: runId, fence, lease_until: databaseNowMs - 1,
    last_batch_id: previous.batch_id, last_issue_id: previous.issue_id, last_version: previous.original_version + 1 },
  pending: { pending_jobs: 12 } };
  return { events, inspection, previous, current, job: { version: current.original_version, cursor: current.original_cursor } };
}

function reconcile(value) {
  return reconcileTrendBackfillEvidence(value.events, value.inspection, value.job, databaseNowMs);
}

function rejects(value, reason) {
  assert.throws(() => reconcile(value), error => error.code === 'TREND_BACKFILL_STOPPED' && error.details.reason === reason);
}

test('read-only recovery proves the exact original committed batch and preserves unknown usage', () => {
  const value = fixture();
  Object.assign(value.inspection.lease, { last_batch_id: value.current.batch_id,
    last_issue_id: value.current.issue_id, last_version: value.current.original_version + 1 });
  value.job = null;
  const retained = structuredClone(value);
  const result = reconcile(value);
  assert.equal(result.batch_outcome, 'committed');
  assert.equal(result.batch_id, value.current.batch_id);
  assert.equal(result.original_fence, fence);
  assert.equal(result.original_lease_active, false);
  assert.equal(result.pending_jobs, 12);
  assert.equal(result.replayed_writes, 0);
  assert.equal(result.original_usage_complete, false);
  assert.equal(result.unknown_queries, 1);
  assert.deepEqual(result.conservative_unknown_usage, { rows_read: 4000, rows_written: 1000 });
  assert.deepEqual(value, retained, 'reconciliation does not mutate the original evidence');
});

test('unchanged original job plus the previous accepted marker proves a batch was not committed', () => {
  const value = fixture();
  const result = reconcile(value);
  assert.equal(result.batch_outcome, 'not_committed');
  assert.equal(result.batch_id, value.current.batch_id);
  assert.equal(result.replayed_writes, 0);
  assert.equal(result.original_usage_complete, false, 'a proven outcome does not reconstruct missing D1 usage');
});

test('first uncommitted batch can be reconciled from an empty control marker and unchanged job', () => {
  const value = fixture();
  value.events = value.events.filter(event => event.batch_id !== value.previous.batch_id);
  Object.assign(value.inspection.lease, { last_batch_id: null, last_issue_id: null, last_version: null });
  assert.equal(reconcile(value).batch_outcome, 'not_committed');
});

test('first batch of a later run uses the checkpoint atomically retained at lease acquisition', () => {
  const value = fixture();
  value.events = value.events.filter(event => event.batch_id !== value.previous.batch_id);
  value.events[0].previous_checkpoint = { batch_id: value.previous.batch_id,
    issue_id: value.previous.issue_id, version: value.previous.original_version + 1 };
  const result = reconcile(value);
  assert.equal(result.batch_outcome, 'not_committed');
  assert.equal(result.original_usage_complete, false);
  assert.equal(result.replayed_writes, 0);
});

test('a changed acquisition checkpoint cannot prove the first uncertain batch was not committed', () => {
  for (const changed of [{ batch_id: 'other' }, { issue_id: 'other' }, { version: 99 }]) {
    const value = fixture();
    value.events = value.events.filter(event => event.batch_id !== value.previous.batch_id);
    value.events[0].previous_checkpoint = { batch_id: value.previous.batch_id,
      issue_id: value.previous.issue_id, version: value.previous.original_version + 1, ...changed };
    rejects(value, 'original_batch_unconfirmed');
  }
  const missingBaseline = fixture();
  missingBaseline.events = missingBaseline.events.filter(event => event.batch_id !== missingBaseline.previous.batch_id);
  rejects(missingBaseline, 'original_batch_unconfirmed');
});

test('an original committed marker supersedes the earlier lease acquisition checkpoint', () => {
  const value = fixture();
  value.events = value.events.filter(event => event.batch_id !== value.previous.batch_id);
  value.events[0].previous_checkpoint = { batch_id: value.previous.batch_id,
    issue_id: value.previous.issue_id, version: value.previous.original_version + 1 };
  Object.assign(value.inspection.lease, { last_batch_id: value.current.batch_id,
    last_issue_id: value.current.issue_id, last_version: value.current.original_version + 1 });
  value.job = null;
  assert.equal(reconcile(value).batch_outcome, 'committed');
});

test('a later accepted batch supersedes the acquisition checkpoint for an uncommitted next batch', () => {
  const value = fixture();
  value.events[0].previous_checkpoint = { batch_id: 'older-run', issue_id: 'older-issue', version: 2 };
  assert.equal(reconcile(value).batch_outcome, 'not_committed');
});

test('an active original lease, including the database clock equality boundary, remains unrecoverable', () => {
  for (const lease_until of [databaseNowMs, databaseNowMs + 1]) {
    const value = fixture();
    value.inspection.lease.lease_until = lease_until;
    rejects(value, 'original_lease_unconfirmed');
  }
  for (const now of [undefined, NaN, 1.5]) {
    const value = fixture();
    assert.throws(() => reconcileTrendBackfillEvidence(value.events, value.inspection, value.job, now),
      error => error.details.reason === 'original_lease_unconfirmed');
  }
});

test('a released lease with the original fence remains recoverable without another release write', () => {
  const value = fixture();
  Object.assign(value.inspection.lease, { run_id: null, lease_until: 0 });
  const result = reconcile(value);
  assert.equal(result.batch_outcome, 'not_committed');
  assert.equal(result.original_lease_active, false);
  assert.equal(result.replayed_writes, 0);
});

test('a changed fence or another run owner cannot be cleared using the original journal', () => {
  for (const changed of [{ fence: fence + 1 }, { fence: fence - 1 }, { run_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }]) {
    const value = fixture();
    Object.assign(value.inspection.lease, changed);
    rejects(value, 'original_lease_unconfirmed');
  }
  const missing = fixture();
  missing.events = missing.events.filter(event => event.type !== 'trend_backfill_lease_acquired');
  rejects(missing, 'original_lease_unconfirmed');
});

test('neither a partial committed tuple nor a changed previous marker proves the original outcome', () => {
  const changes = [{ last_batch_id: 'unrecognized' }, { last_issue_id: 'unrecognized' }, { last_version: 99 },
    { last_batch_id: fixture().current.batch_id },
    { last_batch_id: fixture().current.batch_id, last_issue_id: fixture().current.issue_id, last_version: 99 }];
  for (const changed of changes) {
    const value = fixture();
    Object.assign(value.inspection.lease, changed);
    rejects(value, 'original_batch_unconfirmed');
  }
});

test('job cursor or version drift cannot be mistaken for an uncommitted original batch', () => {
  for (const job of [null, { version: 5, cursor: 500 }, { version: 4, cursor: 499 },
    { version: 3, cursor: 500 }, { version: 4 }]) {
    const value = fixture();
    value.job = job;
    rejects(value, 'original_batch_unconfirmed');
  }
});

test('all unmatched known queries retain conservative reads and only possible writes reserve writes', () => {
  const value = fixture();
  value.events.push({ type: 'trend_backfill_query_started', query_id: 'uncertain-readback', label: 'uncertain_commit_readback' },
    { type: 'trend_backfill_query_started', query_id: 'release', label: 'lease_release' },
    { type: 'trend_backfill_query_started', query_id: 'pending-after', label: 'pending_after' },
    { type: 'trend_backfill_query_failed', query_id: 'commit-current', label: 'history_commit', provider_request_sent: true,
      status: 401, codes: [10000] });
  const result = reconcile(value);
  assert.equal(result.unknown_queries, 4);
  assert.equal(result.original_usage_complete, false);
  assert.deepEqual(result.conservative_unknown_usage, { rows_read: 16000, rows_written: 2000 });
});

test('failure proven before a provider attempt contributes no unknown provider usage', () => {
  const value = fixture();
  value.events.push({ type: 'trend_backfill_query_failed', query_id: 'commit-current', label: 'history_commit',
    provider_request_sent: false, code: 'TREND_BACKFILL_AUTH_UNAVAILABLE' });
  const result = reconcile(value);
  assert.equal(result.batch_outcome, 'not_committed');
  assert.equal(result.original_usage_complete, true);
  assert.equal(result.unknown_queries, 0);
  assert.deepEqual(result.conservative_unknown_usage, { rows_read: 0, rows_written: 0 });
});

test('valid D1 usage pairs complete accounting without changing an independently proven batch outcome', () => {
  const value = fixture();
  value.events.push({ type: 'trend_backfill_query_usage', query_id: 'commit-current', label: 'history_commit',
    rows_read: 2, rows_written: 0, sql_duration_ms: 0.25 });
  const result = reconcile(value);
  assert.equal(result.batch_outcome, 'not_committed');
  assert.equal(result.original_usage_complete, true);
  assert.equal(result.unknown_queries, 0);
});

test('a query usage event with missing or invalid D1 metadata still reserves unknown cost', () => {
  for (const usage of [{ metadata_complete: false }, { rows_read: 2, rows_written: 0 },
    { rows_read: -1, rows_written: 0, sql_duration_ms: 0.1 },
    { rows_read: 2, rows_written: 0.5, sql_duration_ms: 0.1 },
    { rows_read: 2, rows_written: 0, sql_duration_ms: Infinity }]) {
    const value = fixture();
    value.events.push({ type: 'trend_backfill_query_usage', query_id: 'commit-current', label: 'history_commit', ...usage });
    const result = reconcile(value);
    assert.equal(result.original_usage_complete, false);
    assert.equal(result.unknown_queries, 1);
    assert.deepEqual(result.conservative_unknown_usage, { rows_read: 4000, rows_written: 1000 });
  }
});

test('an unknown query label prevents claiming a conservative bound for arbitrary SQL', () => {
  const value = fixture();
  value.events.push({ type: 'trend_backfill_query_started', query_id: 'unrecognized', label: 'arbitrary_sql' });
  rejects(value, 'original_query_unrecognized');
});

test('fully recorded batches need no invented uncertain batch even if the final readback lost usage', () => {
  const value = fixture();
  value.events.push({ ...value.current, type: 'trend_backfill_batch_finished', finished: true });
  Object.assign(value.inspection.lease, { last_batch_id: value.current.batch_id,
    last_issue_id: value.current.issue_id, last_version: value.current.original_version + 1 });
  value.events.push({ type: 'trend_backfill_query_usage', query_id: 'commit-current', label: 'history_commit',
    rows_read: 2, rows_written: 5, sql_duration_ms: 0.25 },
  { type: 'trend_backfill_query_started', query_id: 'pending-after', label: 'pending_after' });
  value.job = null;
  const result = reconcile(value);
  assert.equal(result.batch_outcome, 'no_uncertain_batch');
  assert.equal(result.batch_id, null);
  assert.equal(result.unknown_queries, 1);
  assert.deepEqual(result.conservative_unknown_usage, { rows_read: 4000, rows_written: 0 });
});

test('without an uncertain batch the control marker must still match the last recorded finished batch', () => {
  for (const changed of [{ last_batch_id: 'unrecorded' }, { last_issue_id: 'unrecorded' }, { last_version: 99 }]) {
    const value = fixture();
    value.events.push({ ...value.current, type: 'trend_backfill_batch_finished', finished: true });
    Object.assign(value.inspection.lease, { last_batch_id: value.current.batch_id,
      last_issue_id: value.current.issue_id, last_version: value.current.original_version + 1 }, changed);
    value.job = null;
    rejects(value, 'original_checkpoint_unconfirmed');
  }
});

test('before any batch begins a retained acquisition baseline proves the untouched control marker', () => {
  const value = fixture();
  value.events = [{ ...value.events[0], previous_checkpoint: { batch_id: value.previous.batch_id,
    issue_id: value.previous.issue_id, version: value.previous.original_version + 1 } }];
  value.job = null;
  assert.equal(reconcile(value).batch_outcome, 'no_uncertain_batch');
  for (const changed of [{ last_batch_id: 'unrecorded' }, { last_issue_id: 'unrecorded' }, { last_version: 99 }]) {
    const drifted = structuredClone(value);
    Object.assign(drifted.inspection.lease, changed);
    rejects(drifted, 'original_checkpoint_unconfirmed');
  }
});
