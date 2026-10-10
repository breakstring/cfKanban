import assert from "node:assert/strict";
import test from "node:test";
import { maintenanceBudget } from "../../apps/worker/src/domain/maintenance-budget.ts";

test("all maintenance tasks share the Free invocation ceiling, including batch statements and R2 calls", () => {
  for (const attachments of [false, true]) for (const usage of [false, true]) {
    const budget = maintenanceBudget(attachments, usage);
    assert.ok(budget.trendJobs >= 1 && budget.trendJobs <= 8);
    assert.equal(budget.attachmentBatch, attachments ? 8 : 0);
    assert.ok(budget.maxSubrequests <= 50);
    assert.equal(budget.maxSubrequests, 4 + (attachments ? 5 + 2 * 8 : 0)
      + (usage ? 9 : 0) + 1 + 5 * budget.trendJobs);
  }
  assert.equal(maintenanceBudget(true, true).trendJobs, 3);
  assert.equal(maintenanceBudget(false, false).trendJobs, 8);
});
