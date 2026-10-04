import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { issueTree } from '../src/embedded/issue-tree.ts';
import { readIssueHierarchy } from '../src/lib/issue-hierarchy.ts';

const workspace = randomUUID(), project = randomUUID();
const parent = number => ({ id: randomUUID(), identifier: `CFK-${number}`, title: `Parent ${number}`, workspace_id: workspace, project_id: project, status: { key: 'done', display_name: 'Done' } });
const issue = (number, parents = [], progress = { total: 0, done: 0 }) => ({ identifier: `CFK-${number}`, title: `Issue ${number}`, version: 1, status: { key: 'todo' }, priority: 'none', hierarchy: { parents, parent_count: parents.length, children: progress } });

test('a parent outside the current status page is context and never another counted issue', () => {
  const shared = parent(1);
  const rows = issueTree([issue(3, [shared]), issue(2, [shared])]);
  assert.deepEqual(rows.map(row => [row.identifier, row.depth, Boolean(row.context)]), [['CFK-1', 0, true], ['CFK-3', 1, false], ['CFK-2', 1, false]]);
  assert.equal(rows.filter(row => row.issue).length, 2);
  assert.equal(rows[0].contextProgress, undefined);
  const completedParent = { ...issue(1, [], { total: 9, done: 7 }), status: { key: 'done' } };
  const loadedContext = issueTree([issue(3, [shared]), issue(2, [shared])], [completedParent]);
  assert.deepEqual(loadedContext[0].contextProgress, { total: 9, done: 7 });
  assert.equal(loadedContext[0].issue, undefined);
  assert.equal(loadedContext.filter(row => row.issue).length, 2);
});

test('a loaded ancestor replaces context once, and nested children retain their page order', () => {
  const rows = issueTree([issue(4, [parent(2)]), issue(3, [parent(2)]), issue(2, [parent(1)]), issue(1)]);
  assert.deepEqual(rows.map(row => [row.identifier, row.depth]), [['CFK-1', 0], ['CFK-2', 1], ['CFK-4', 2], ['CFK-3', 2]]);
  assert.equal(rows.some(row => row.context), false);
});

test('historical cycles stop at one deterministic root and preserve each issue exactly once', () => {
  const input = [issue(1, [parent(2)]), issue(2, [parent(3)]), issue(3, [parent(1)])];
  const rows = issueTree(input);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(row => row.identifier)).size, 3);
  assert.equal(rows.filter(row => row.cycle).length, 1);
  assert.equal(rows[0].identifier, 'CFK-1');
  assert.equal(rows[0].depth, 0);
  assert.equal(issueTree([issue(1, [parent(1)])])[0].cycle, true);
  assert.equal(input[0].hierarchy.parents[0].identifier, 'CFK-2');
});

test('multi-parent relations choose the supplied stable first parent without duplicating a child', () => {
  const input = issue(3, [parent(1), parent(2)]);
  input.hierarchy.parent_count = 12;
  const rows = issueTree([input]);
  assert.deepEqual(rows.map(row => row.identifier), ['CFK-1', 'CFK-3']);
  assert.equal(rows[1].issue.hierarchy.parent_count, 12);
});

test('a historical cycle across loaded status groups is marked without expanding context ancestors', () => {
  const todo = issue(1, [parent(2)]);
  const done = { ...issue(2, [parent(1)]), status: { key: 'done' } };
  const rows = issueTree([todo], [todo, done]);
  assert.deepEqual(rows.map(row => [row.identifier, row.depth, row.cycle]), [['CFK-2', 0, false], ['CFK-1', 1, true]]);
  assert.equal(rows.filter(row => row.issue).length, 1);
  assert.equal(rows[0].context.identifier, 'CFK-2');
});

test('deep trees use a bounded iterative walk and old services render flat rows', () => {
  const input = Array.from({ length: 1000 }, (_, index) => issue(index + 1, index ? [parent(index)] : []));
  const rows = issueTree(input);
  assert.equal(rows.length, 1000);
  assert.equal(rows.at(-1).depth, 999);
  const legacy = { ...issue(2), hierarchy: undefined };
  assert.deepEqual(issueTree([legacy]).map(row => [row.identifier, row.depth]), [['CFK-2', 0]]);
});

test('the hierarchy boundary rejects forged counts, duplicate parents, private data and unbounded parents', () => {
  const valid = { parents: [parent(1)], parent_count: 1, children: { total: 6, done: 5 } };
  assert.deepEqual(readIssueHierarchy(valid), valid);
  for (const mutate of [
    value => { value.children.done = 7; },
    value => { value.children.total = -1; },
    value => { value.parent_count = 0; },
    value => { value.parents.push(value.parents[0]); value.parent_count = 2; },
    value => { value.parents[0].token = 'never-export'; },
    value => { value.parents = Array.from({ length: 11 }, (_, index) => parent(index + 1)); value.parent_count = 11; },
    value => { value.parents[0].status.key = 'invented'; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.equal(readIssueHierarchy(invalid), undefined);
  }
});

test('hierarchy status names use the service limit of 128 Unicode code points', () => {
  const valid = { parents: [parent(1)], parent_count: 1, children: { total: 6, done: 5 } };
  for (const displayName of ['🚀'.repeat(65), '🚀'.repeat(128), 'a'.repeat(128), 'e\u0301'.repeat(64)]) {
    valid.parents[0].status.display_name = displayName;
    assert.deepEqual(readIssueHierarchy(valid), valid);
  }
  for (const displayName of ['🚀'.repeat(129), 'a'.repeat(129), 'e\u0301'.repeat(65)]) {
    valid.parents[0].status.display_name = displayName;
    assert.equal(readIssueHierarchy(valid), undefined);
  }
});
