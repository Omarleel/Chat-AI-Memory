/**
 * Puerto de la API administrativa. Las vistas dependen de este contrato, no de fetch ni de rutas HTTP.
 * El adaptador real es infrastructure/http-admin-api.js; las pruebas pueden inyectar uno en memoria.
 *
 * @typedef {Object} AdminApi
 * @property {() => Promise<object>} system
 * @property {() => Promise<object>} whatsappStatus
 * @property {() => Promise<string|null>} whatsappQrUrl  URL de objeto (blob:) del QR, o null si no hay.
 * @property {() => Promise<{allowlist: string[], contacts: object[]}>} contacts
 * @property {(contact: string) => Promise<object[]>} chatImports
 * @property {(input: {file: File, contact: string, self: string, peer: string}) => Promise<object>} importChat
 * @property {(input: object) => Promise<object>} preview
 * @property {(contact: string, sessionId: string) => Promise<object[]>} previewHistory
 * @property {(contact: string, sessionId: string) => Promise<number>} clearPreview
 * @property {(contact: string) => Promise<object[]>} memories
 * @property {(contact: string, fact: string) => Promise<object>} addMemory
 * @property {(contact: string, id: number) => Promise<object>} deleteMemory
 * @property {() => Promise<object[]>} drafts
 * @property {(id: string) => Promise<object>} sendDraft
 * @property {(contact: string, question: string) => Promise<object>} ragSearch
 * @property {() => Promise<object>} ragMetrics
 * @property {() => Promise<object[]>} models
 * @property {() => Promise<object[]>} trainingSources
 * @property {() => Promise<object>} trainingRunner
 * @property {(input: object) => Promise<object>} trainingPlan
 * @property {() => Promise<object[]>} trainingJobs
 * @property {(input: object) => Promise<object>} createTrainingJob
 * @property {(id: string, afterLog?: number) => Promise<{job: object, logs: object[]}>} trainingJob
 * @property {(id: string) => Promise<object>} cancelTrainingJob
 * @property {(id: string) => Promise<object>} calibrateReviewer
 * @property {() => Promise<object>} burstLabeling
 * @property {(input: object) => Promise<object>} startBurstLabeling
 * @property {() => Promise<object>} pauseBurstLabeling
 * @property {(contact: string) => Promise<object>} graphStatus
 * @property {(input: {contact: string, importHash: string, maxMessages?: number}) => Promise<object>} startGraphExtraction
 * @property {(contact: string) => Promise<boolean>} pauseGraphExtraction
 * @property {(contact: string) => Promise<object>} rebuildGraph
 * @property {(contact: string, q: string) => Promise<object[]>} graphEntities
 * @property {(contact: string, key: string) => Promise<{entity: object, relations: object[]}>} graphEntity
 */
export class ApiError extends Error {
  constructor(message, {status = 0, code = null} = {}) {
    super(message);
    Object.assign(this, {name: 'ApiError', status, code});
  }
}
