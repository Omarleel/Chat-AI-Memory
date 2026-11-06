# Etapa 1: compila la interfaz React (solo archivos estáticos; Node no queda en la imagen final).
FROM node:26-bookworm-slim AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /service
COPY api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY api ./api
COPY --from=ui /ui/dist ./api/static
RUN mkdir -p /uploads && chown -R 10001:10001 /uploads /service
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).read()"
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
