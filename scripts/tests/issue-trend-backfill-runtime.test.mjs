import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTrendBackfillMeter, DEFAULT_TREND_BACKFILL_BUDGET, inspectTrendBackfill, normalizeTrendBackfillBudget, runBoundedTrendBackfill, runTrendBackfill, summarizeTrendBackfill } from '../../packages/skill-runtime/src/issue-trend-backfill.mjs';
import { getCommandCatalog } from '../../packages/skill-runtime/src/cli.mjs';
import { COMMANDS } from '../../packages/cli/src/catalog.mjs';
import { parseArguments } from '../../packages/cli/src/parser.mjs';
import { exitCode } from '../../packages/cli/src/main.mjs';

test('public CLI distinguishes complete, bounded stops, conflicts and unknown writes without automatic replay', () => {
  const context = { operationId: randomUUID(), journalPath: '/private/original.json' };
  const summary = (stop_reason, pending_after = 1, metadata_complete = true) => summarizeTrendBackfill({ stop_reason,
    pending_after, usage: { metadata_complete } }, context);
  assert.equal(summary('complete', 0).complete, true);
  assert.equal(exitCode(summary('complete', 0)), 0);
  assert.equal(summary('budget_exhausted').complete, false);
  assert.equal(exitCode(summary('budget_exhausted')), 0);
  assert.equal(exitCode(summary('lease_busy')), 5);
  const unknown = summary('usage_metadata_unknown', 1, false);
  assert.equal(exitCode(unknown), 6);
  assert.equal(unknown.recovery.operation_id, context.operationId);
  assert.equal(unknown.recovery.replay_automatically, false);
  assert.equal(exitCode(summary('TREND_BACKFILL_CONTROL_UNAVAILABLE')), 6);
});

function harness({ jobs = 3, budget: overrides = {}, busy = false, commitFailure, workerDrift = false, priorEvents = [], metadataMissing = false } = {}) {
  let clock = 1000; const requests = [], records = [];
  const budget = normalizeTrendBackfillBudget(overrides);
  const meter = createTrendBackfillMeter({ budget, now: () => clock, sleep: async ms => { clock += ms; }, fetchImpl: async () => { requests.push(clock); return {}; }, onQuery: async event => records.push({ type: 'usage', ...event }) });
  const plan = { operation_id: randomUUID(), budget };
  const control = { id: 1, run_id: busy ? randomUUID() : null, lease_until: busy ? clock + 120000 : 0, fence: 0, last_batch_id: null, last_issue_id: null, last_version: null };
  const queue = Array.from({ length: jobs }, (_, i) => ({ issue_id: randomUUID(), project_id: randomUUID(), cursor: 100, version: 1, secret_body: `DO NOT JOURNAL ISSUE BODY ${i}` }));
  const algorithm = { JOB_PAGE_SQL: 'JOB PAGE LIMIT ?1', TREND_HISTORY_PAGE_SQL: 'HISTORY PAGE', createTrendBackfillCommit: (job, events, ids) => ({ sql: 'COMMIT HISTORY', params: [job.issue_id, job.version, ids.batchId, ids.runId, ids.fence], finished: true, partial: false, event_count: events.length, next_cursor: 0 }) };
  const query = async (sql, params, label) => {
    await meter.fetch('https://api.cloudflare.com/client/v4/accounts/fake/d1/database/fake/query', {});
    let results = [], changes = 0;
    if (label === 'pending_before' || label === 'pending_after' || label === 'queue_after') results = [{ pending_jobs: queue.length }];
    else if (label === 'lease_acquire') { if (control.lease_until <= clock) { control.run_id = params[0]; control.lease_until = params[1]; control.fence += 1; results = [{ fence: control.fence }]; changes = 1; } }
    else if (label === 'lease_renew') { if (control.run_id === params[1] && control.fence === params[2] && control.lease_until > clock) { control.lease_until = params[0]; results = [{ fence: control.fence }]; changes = 1; } }
    else if (label === 'lease_release') { if (control.run_id === params[0] && control.fence === params[1]) { control.run_id = null; control.lease_until = 0; changes = 1; } }
    else if (label === 'job_page') results = queue.slice(0, params[0]).map(job => ({ ...job }));
    else if (label === 'history_page') results = [{ sequence: 1, payload_json: '{"title":"DO NOT JOURNAL EVENTS"}' }];
    else if (label === 'history_commit') {
      if (commitFailure === 'before') throw new Error('provider disconnected before commit');
      const index = queue.findIndex(job => job.issue_id === params[0] && job.version === params[1]);
      if (index >= 0 && control.run_id === params[3] && control.fence === params[4]) { queue.splice(index, 1); control.last_batch_id = params[2]; control.last_issue_id = params[0]; control.last_version = params[1] + 1; changes = 7; }
      if (commitFailure === 'after') throw new Error('provider disconnected after commit');
    } else if (['history_commit_readback', 'uncertain_commit_readback', 'recover_original_batch'].includes(label)) results = [{ ...control }];
    const result = { results, meta: metadataMissing && label === 'history_commit' ? undefined : { rows_read: 2, rows_written: changes, duration: 0.3, changes } };
    await meter.record(result, label); return result;
  };
  const assertWorker = async () => { await meter.fetch('https://api.cloudflare.com/client/v4/accounts/fake/workers/scripts/fake/deployments', {}); if (workerDrift) throw Object.assign(new Error('changed'), { code: 'WORKER_DRIFT' }); };
  return { queue, records, control, requests, meter, plan, algorithm, query, run: () => runBoundedTrendBackfill({ plan, algorithm, query, meter, assertWorker, now: () => clock, record: async event => records.push(event), priorEvents }) };
}

test('default backfill budgets are finite and cannot increase load or provider rate', () => {
  assert.deepEqual(normalizeTrendBackfillBudget(), DEFAULT_TREND_BACKFILL_BUDGET);
  for (const value of [{ batchSize: 9 }, { requestIntervalMs: 499 }, { rowsWritten: 50001 }, { maxPages: 0 }, { sql: 'DELETE' }, { maxDurationMs: Infinity }]) assert.throws(() => normalizeTrendBackfillBudget(value), { code: 'INVALID_TREND_BACKFILL_BUDGET' });
  assert.equal(normalizeTrendBackfillBudget({ batchSize: 1, requestIntervalMs: 1000 }).batchSize, 1);
});

test('provider attempts checkpoint request count and cumulative duration before a failed request', async () => {
  let clock = 2000; const attempts = [];
  const budget = normalizeTrendBackfillBudget({ maxRequests: 5 });
  const meter = createTrendBackfillMeter({ budget, now: () => clock, sleep: async ms => { clock += ms; }, previousUsage: { provider_requests: 3 }, previousElapsedMs: 700,
    onRequest: async event => attempts.push(event), fetchImpl: async () => { throw new Error('provider unreachable'); } });
  for (let i = 0; i < 2; i += 1) await assert.rejects(meter.fetch('https://api.cloudflare.com/client/v4/accounts/fixed/workers/scripts/fixed/deployments', {}), /provider unreachable/);
  assert.deepEqual(attempts.map(event => event.provider_requests), [4, 5]);
  assert.deepEqual(attempts.map(event => event.cumulative_elapsed_ms), [700, 1200]);
  await assert.rejects(meter.fetch('https://api.cloudflare.com/client/v4/accounts/fixed/d1/database/fixed/query', {}), error => error.details.reason === 'budget_exhausted');
  assert.equal(attempts.length, 2);
});

test('one fixed lease fences atomic commits and records actual usage without Issue payloads', async () => {
  const fixture = harness();
  const result = await fixture.run();
  assert.equal(result.stop_reason, 'complete'); assert.equal(result.pending_before, 3); assert.equal(result.pending_after, 0); assert.equal(result.finished_issues, 3);
  assert.equal(fixture.control.run_id, null); assert.equal(fixture.control.lease_until, 0);
  assert.equal(result.worker_cpu_ms, null); assert.ok(result.local_node_cpu_ms >= 0); assert.equal(result.backfill_runs_in, 'local_node');
  assert.equal(result.usage.rows_written, 25, 'changes may include trigger writes; fixed control readback establishes each accepted commit');
  assert.equal(result.usage.provider_requests, fixture.requests.length);
  for (let i = 1; i < fixture.requests.length; i += 1) assert.ok(fixture.requests[i] - fixture.requests[i - 1] >= 500);
  assert.equal(fixture.records.filter(event => event.type === 'trend_backfill_batch_started').length, 3);
  assert.equal(fixture.records.filter(event => event.type === 'trend_backfill_batch_finished').length, 3);
  assert.ok(!JSON.stringify(fixture.records).includes('DO NOT JOURNAL'));
});

test('cross-host active lease prevents a second run from processing or releasing the first run', async () => {
  const fixture = harness({ busy: true }); const previousOwner = fixture.control.run_id;
  const result = await fixture.run(); assert.equal(result.stop_reason, 'lease_busy'); assert.equal(result.pages, 0);
  assert.equal(fixture.control.run_id, previousOwner); assert.equal(fixture.queue.length, 3);
});

test('page and worst-case row budgets stop before starting another commit', async () => {
  const fixture = harness({ jobs: 5, budget: { maxPages: 2 } });
  const result = await fixture.run(); assert.equal(result.stop_reason, 'page_budget_exhausted'); assert.equal(result.pages, 2); assert.equal(fixture.queue.length, 3);
  const tiny = harness({ budget: { rowsRead: 3999 } }); const stopped = await tiny.run();
  assert.equal(stopped.stop_reason, 'budget_exhausted'); assert.equal(stopped.pages, 0); assert.equal(tiny.queue.length, 3);
});

test('unknown committed and uncommitted outcomes retain original batch and never retry it', async () => {
  for (const failure of ['before', 'after']) {
    const fixture = harness({ commitFailure: failure }); const result = await fixture.run();
    assert.equal(result.pages, 0); assert.equal(fixture.queue.length, failure === 'before' ? 3 : 2);
    assert.equal(result.usage.metadata_complete, false, 'an uncertain write cannot claim complete aggregate usage');
    const checkpoint = fixture.records.find(event => event.type === 'trend_backfill_batch_started');
    const uncertain = fixture.records.find(event => event.type === 'trend_backfill_batch_uncertain');
    assert.equal(uncertain.batch_id, checkpoint.batch_id); assert.equal(uncertain.committed, failure === 'after'); assert.equal(uncertain.metadata_complete, false);
    assert.equal(fixture.requests.length, result.usage.provider_requests);
    assert.equal(fixture.records.filter(event => event.label === 'history_commit').length, 0);
    assert.equal(fixture.control.run_id, null);
  }
});

test('missing D1 metadata stops after one write rather than counting it as zero', async () => {
  const fixture = harness({ metadataMissing: true }); const result = await fixture.run();
  assert.equal(result.stop_reason, 'usage_metadata_unknown'); assert.equal(result.usage.metadata_complete, false); assert.equal(fixture.queue.length, 2);
  assert.equal(fixture.records.filter(event => event.type === 'trend_backfill_batch_started').length, 1);
  assert.equal(fixture.records.find(event => event.type === 'trend_backfill_batch_uncertain').committed, true);
});

test('interrupted private checkpoint is reconciled once and cannot start another batch', async () => {
  const checkpoint = { type: 'trend_backfill_batch_started', batch_id: 'original', issue_id: randomUUID(), original_cursor: 9, original_version: 1 };
  const fixture = harness({ priorEvents: [checkpoint] }); const result = await fixture.run();
  assert.equal(result.stop_reason, 'original_batch_usage_unknown'); assert.equal(fixture.queue.length, 3); assert.equal(fixture.control.fence, 0);
  assert.equal(fixture.records.filter(event => event.type === 'trend_backfill_batch_uncertain').length, 1);
});

test('Worker version drift stops before history changes and releases the acquired fence', async () => {
  const fixture = harness({ workerDrift: true }); const result = await fixture.run();
  assert.equal(result.stop_reason, 'WORKER_DRIFT'); assert.equal(result.pages, 0); assert.equal(fixture.queue.length, 3); assert.equal(fixture.control.run_id, null);
});

test('maintenance rejects arbitrary targets and requires exact bound run authorization before reading secrets', async () => {
  await assert.rejects(inspectTrendBackfill({ accountId: 'attacker', instanceId: randomUUID() }), { code: 'TREND_BACKFILL_TARGET_OVERRIDE' });
  await assert.rejects(runTrendBackfill({ instanceId: randomUUID(), taskId: 'test', operationId: randomUUID(), plan: {} }), { code: 'INVALID_TREND_BACKFILL_PLAN' });
  const instanceId = randomUUID(), operationId = randomUUID();
  await assert.rejects(runTrendBackfill({ instanceId, operationId, taskId: 'test', plan: { kind: 'issue_trend_history_backfill', schema_version: 1, instance_id: instanceId, operation_id: operationId, task_id: 'test' } }), { code: 'TREND_BACKFILL_AUTHORIZATION_REQUIRED' });
});

test('Skill and public CLI expose independent inspect/plan/run with correct effects and bounded file transport', async () => {
  const helpers = getCommandCatalog({ surface: 'deploy' }).commands;
  for (const suffix of ['inspect', 'plan', 'run']) assert.ok(helpers.some(command => command.name === `maintenance trends ${suffix}`));
  assert.equal(COMMANDS.find(command => command.name === 'deploy trends inspect').effect, 'read');
  assert.equal(COMMANDS.find(command => command.name === 'deploy trends plan').effect, 'plan');
  const command = COMMANDS.find(entry => entry.name === 'deploy trends run');
  assert.equal(command.effect, 'write'); assert.equal(command.workflow, 'trend-backfill-run');
  const parsed = await parseArguments(['deploy', 'trends', 'plan', '--input-file', 'fake', '--json', '--no-interactive'], { fileRead: async () => JSON.stringify({ instanceId: randomUUID(), taskId: 'test', currentReceiptPath: '/private/receipt.json', serviceBundleRoot: '/private/bundle', wranglerExecutable: '/private/wrangler', budget: { batchSize: 2 } }) });
  assert.equal(parsed.input.budget.batchSize, 2); assert.equal(parsed.command.name, 'deploy trends plan');
});
