import {describe, expect, it, vi} from 'vitest';
import {createHttpAdminApi} from './http-admin-api.js';

const json = (status, body) => ({ok: status < 400, status, json: async () => body});

describe('adaptador HTTP de AdminApi', () => {
  it('envía el token, arma la URL y desempaqueta la respuesta', async () => {
    const fetchImpl = vi.fn(async () => json(200, {jobs: [{id: 'train_a_00000000'}]}));
    const api = createHttpAdminApi({getToken: () => 'tok', fetchImpl, origin: 'http://127.0.0.1:8000'});
    expect(await api.trainingJobs()).toEqual([{id: 'train_a_00000000'}]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:8000/api/v1/training/jobs');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });
  it('traduce errores de FastAPI y avisa del 401', async () => {
    const onUnauthorized = vi.fn();
    const responses = [json(422, {detail: [{loc: ['body', 'steps'], msg: 'debe ser >= 10'}]}),
      json(502, {detail: 'Ollama no pudo completar la prueba [OLLAMA_PREVIEW_FAILED]. Revisa'}), json(401, {detail: 'No autorizado'})];
    const api = createHttpAdminApi({getToken: () => 't', fetchImpl: async () => responses.shift(), onUnauthorized, origin: 'http://x'});
    await expect(api.createTrainingJob({})).rejects.toThrow(/steps: debe ser >= 10/);
    await expect(api.preview({})).rejects.toMatchObject({status: 502, code: 'OLLAMA_PREVIEW_FAILED'});
    await expect(api.system()).rejects.toMatchObject({status: 401});
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
