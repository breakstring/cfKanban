import assert from "node:assert/strict";
import test from "node:test";
import { maintenanceBudget } from "../../apps/worker/src/domain/maintenance-budget.ts";

test("all maintenance tasks share the Free invocation ceiling, including batch statements and R2 calls", () => {
  for (const attachments of [false, true]) for (const usage of [false, true]) {
    const budget = maintenanceBudget(attachments, usage);
    assert.equal(budget.trendJobs, undefined);
    assert.equal(budget.attachmentBatch, attachments ? 8 : 0);
    assert.ok(budget.maxSubrequests <= 50);
    assert.equal(budget.maxSubrequests, 4 + (attachments ? 5 + 2 * 8 : 0)
      + (usage ? 9 : 0));
  }
  assert.equal(maintenanceBudget(true, true).maxSubrequests, 34);
  assert.equal(maintenanceBudget(false, false).maxSubrequests, 4);
});
