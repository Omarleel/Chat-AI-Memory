import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreReviewer} from '../../src/lab/reviewer-metrics.mjs';

test('métricas del revisor frente a etiquetas humanas', () => {
  const key = {a: {origin: 'real'}, b: {origin: 'draft'}, c: {origin: 'draft'}, d: {origin: 'draft'}, e: {origin: 'real'}};
  const labels = [{itemId: 'a', label: 'valid'}, {itemId: 'b', label: 'invents'}, {itemId: 'c', label: 'valid'},
    {itemId: 'd', label: 'incoherent'}, {itemId: 'e', label: 'valid'}, {itemId: 'x', label: 'valid'}];
  const verdicts = {a: {valid: true}, b: {valid: true}, c: {valid: false}, d: {valid: false}, e: {valid: true}, x: {error: 'timeout'}};
  const r = scoreReviewer({labels, verdicts, key});
  assert.equal(r.n, 5, 'los veredictos con error no cuentan');
  assert.equal(r.agreement, 0.6);
  assert.deepEqual([r.approved, r.humanValid, r.approvalPrecision, r.approvalRecall, r.falseRejections], [3, 3, 0.667, 0.667, 1]);
  assert.deepEqual(r.falseApprovals, {invents: 1});
  assert.deepEqual(r.byOrigin.real, {n: 2, humanValid: 2, approved: 2, agreement: 1});
});
