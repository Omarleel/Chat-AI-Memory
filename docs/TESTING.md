# Pruebas

Las pruebas automatizadas se organizan en:

- `tests/unit/`: dominio, contexto, ranking, datos, agentes y juez, validaciones del laboratorio y servicios con dobles de prueba.
- `tests/integration/`: contratos entre componentes, repositorio SQLite temporal, transporte HTTP, importaciones, WhatsApp, entrenamiento y laboratorio con infraestructura simulada.
- `tests/python/`: FastAPI con TestClient y máscaras de supervisión del entrenamiento.
- `ui/src/**/*.spec.js`: reglas de dominio y adaptador HTTP de la interfaz (Vitest).

No necesitan credenciales de NVIDIA, Ollama, agentes externos ni acceso a WhatsApp.

```powershell
npm test
npm run test:unit
npm run test:integration
npm run test:python
npm run test:ui
```

`npm test` ejecuta las dos categorías Node; los scripts por grupo usan un lanzador compatible con PowerShell/CMD sin expansión de comodines. Python requiere `pytest` y las dependencias de `api/requirements.txt`. Los archivos de la interfaz usan la extensión `.spec.js` para que `node --test` no los recoja; `npm run ui:build` compila la interfaz que sirve FastAPI.

## Cobertura

Versión 1.0.0: **231** pruebas Node, **18** Python y **9** de la interfaz. Cubren contratos de código, no la integración real con el juez remoto, el entrenamiento en GPU, Docker ni el diálogo humano.

## Pruebas de entorno

```powershell
npm run lab:doctor
npm run lab:benchmark -- --dataset examples/lab-demo.jsonl --candidate-model mi-modelo:latest --min-turns 1
```

`lab:doctor` muestra la disponibilidad de modelos y la configuración; con el juez NIM no comprueba el acceso remoto ni el formato JSON. El benchmark sintético comprueba la cadena completa, pero no sirve para aprobar una mejora de imitación.
