import { replayConversations } from './conversation-simulator.mjs';
import { summaryOf, qualityGate } from './quality-gate.mjs';

// Each contestant gets its OWN generated prior replies. Reference targets are never sent to generators.
export async function evaluateCandidate({ dataset, baselineGenerator, candidateGenerator, judge,
  gateOptions = {}, onProgress = () => {} }) {
  const baseline = await replayConversations(dataset.conversations, baselineGenerator);
  onProgress({phase:'generated_baseline', conversations: baseline.length});
  const candidate = await replayConversations(dataset.conversations, candidateGenerator);
  onProgress({phase:'generated_candidate', conversations: candidate.length});
  const judgedBaseline = [], judgedCandidate = [], diagnostics = [];
  for (let c = 0; c < baseline.length; c++) {
    const baseConversation = baseline[c], newConversation = candidate[c];
    for (let t = 0; t < baseConversation.turns.length; t++) {
      const base = baseConversation.turns[t], current = newConversation.turns[t];
      const id = `${baseConversation.id}-${t}`;
      const review = await judge({ id, context: base.context, input: base.input,
        reference: base.reference, baseline: base.answer, candidate: current.answer,
        candidateContext: current.context });
      judgedBaseline.push(review.baseline);
      judgedCandidate.push(review.candidate);
      diagnostics.push({ id, step: t, baseline: { scores: review.baseline, response: base.answer, context: base.context },
        candidate: { scores: review.candidate, response: current.answer, context: current.context },
        input: base.input, reference: base.reference });
      onProgress({ phase:'judged', judged: judgedCandidate.length, total: dataset.steps });
    }
  }
  const report = { status: 'ok', datasetSha256: dataset.sha256,
    conversations: new Set(dataset.conversations.map(c => c.sourceSession)).size, steps: dataset.steps,
    baseline: summaryOf(judgedBaseline), candidate: summaryOf(judgedCandidate), errors: [] };
  report.gate = qualityGate(report, gateOptions);
  return { report, diagnostics };
}
