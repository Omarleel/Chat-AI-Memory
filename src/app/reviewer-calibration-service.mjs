import {ResponseValidationService} from './response-validation-service.mjs';
import {selectHoldoutCases} from '../domain/holdout-cases.mjs';
import {datasetPairs, exampleSelector, shortApprovalLimit} from '../domain/holder-examples.mjs';
import {replyShape} from '../domain/reply-shape.mjs';
import {summarizeCalibration} from '../domain/reviewer-calibration.mjs';

// Calibra el revisor para una identidad sin etiquetas humanas: las respuestas reales del titular
// en conversaciones reservadas (split=test) deberían aprobarse. Mide los rechazos falsos; las
// aprobaciones falsas solo se miden con etiquetas humanas (scripts/reviewer-benchmark.mjs).
// Los ejemplos y la forma salen solo de train, como en producción saldrían del historial.
export class ReviewerCalibrationService {
  constructor({llm, config = {}}) {Object.assign(this, {llm, config});}

  async calibrate({testRows, trainRows, selfName, peerName = 'Interlocutor', limit = 30, examples = true, onProgress = () => {}}) {
    if (testRows.some(r => r.provenance?.split && r.provenance.split !== 'test')) throw new Error('testRows debe contener solo split=test');
    if (trainRows.some(r => r.provenance?.split && r.provenance.split !== 'train')) throw new Error('trainRows debe contener solo split=train');
    const cases = selectHoldoutCases(testRows, {limit});
    const pairs = datasetPairs(trainRows);
    const select = examples && pairs.length ? exampleSelector(pairs) : () => [];
    const shortLimit = shortApprovalLimit(replyShape(pairs.map(p => p.reply)), this.config.reviewShortApproval);
    const reviewer = new ResponseValidationService({llm: this.llm, config: this.config});
    const verdicts = [];
    for (const [i, c] of cases.entries()) {
      try {
        verdicts.push(await reviewer.validate({question: c.input, answer: c.reference, evidence: [], judgeOnly: true,
          recent: c.context.map(m => ({author: m.role === 'assistant' ? selfName : peerName, text: m.content, origin: 'live_message'})),
          selfAuthor: selfName, peerAuthor: peerName, holderExamples: select(c.input), shortApprovalLimit: shortLimit}));
      } catch (error) {verdicts.push({error: String(error?.message ?? error)});}
      onProgress(i + 1, cases.length);
    }
    return {...summarizeCalibration(verdicts), examples: examples && pairs.length > 0, shortApproval: shortLimit};
  }
}
