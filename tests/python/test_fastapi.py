"""Contract tests with a fake Node backend, no WhatsApp or Ollama required."""

import os
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ["ADMIN_TOKEN"] = "test_admin_token_" + "S" * 40

from fastapi.testclient import TestClient
from api import main

TOKEN = os.environ["ADMIN_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def test_swagger_and_auth():
    with TestClient(main.app) as client:
        assert client.get("/health").json()["ok"]
        spec = client.get("/openapi.json").json()
        assert "/api/v1/chats/import" in spec["paths"]
        assert client.get("/api/v1/contacts").status_code == 401
        assert client.get("/api/v1/contacts", headers={"Authorization": "Bearer incorrect"}).status_code == 401


def test_upload_chat_to_contact_and_cleanup(tmp_path):
    with patch.object(main, "UPLOAD_DIR", tmp_path), patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"linkedTo": "51999999999", "importedMessages": 2, "skipped": False}
        with TestClient(main.app) as client:
            response = client.post("/api/v1/chats/import", headers=HEADERS, files={"file": ("chat.txt", BytesIO(b"[01/01/2026, 10:00] Alex: Hola\n[01/01/2026, 10:01] Diego: Hola"), "text/plain")},
                data={"contact": "51999999999", "self": "Alex", "peer": "Diego"})
            assert response.status_code == 200, response.text
            assert response.json()["linkedTo"] == "51999999999"
            assert not list(tmp_path.iterdir()), "No deben quedar TXT en el volumen temporal"
            request = send.await_args.kwargs["payload"]
            assert request["contact"] == "51999999999"
            assert request["filename"].startswith("upload-")
            assert request["originalFilename"] == "chat.txt"


def test_bad_upload_never_calls_backend(tmp_path):
    with patch.object(main, "UPLOAD_DIR", tmp_path), patch.object(main, "backend", new_callable=AsyncMock) as send:
        with TestClient(main.app) as client:
            base = {"contact":"51999999999", "self":"Alex", "peer":"Diego"}
            for filename in ["bad.zip", "chat.json"]:
                response = client.post("/api/v1/chats/import", headers=HEADERS,
                    files={"file": (filename, b"test", "application/octet-stream")}, data=base)
                assert response.status_code == 415
            response = client.post("/api/v1/chats/import", headers=HEADERS,
                files={"file": ("chat.txt", b"", "text/plain")}, data=base)
            assert response.status_code == 422
            response = client.post("/api/v1/chats/import", headers=HEADERS,
                files={"file": ("chat.txt", b"abc", "text/plain")}, data={**base,"contact":"invalid"})
            assert response.status_code == 422
            assert not list(tmp_path.iterdir())
            send.assert_not_awaited()


def test_preview_is_no_send_operation():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"answer": "Hola", "mode": "reply", "sent": False}
        with TestClient(main.app) as client:
            response = client.post("/api/v1/preview", headers=HEADERS,
                json={"contact": "51999999999", "text": "Hola"})
            assert response.status_code == 200
            assert response.json()["sent"] is False
            assert send.await_args.args == ("POST", "/api/preview")
            assert send.await_args.kwargs["payload"]["mode"] == "reply"
            assert send.await_args.kwargs["payload"]["include_recent"] is False


def test_upload_max_size_cleans_temporary_file(tmp_path):
    with (patch.object(main, "UPLOAD_DIR", tmp_path),
          patch.object(main, "MAX_IMPORT_BYTES", 4),
          patch.object(main, "backend", new_callable=AsyncMock) as send):
        with TestClient(main.app) as client:
            response = client.post("/api/v1/chats/import", headers=HEADERS,
                files={"file": ("chat.txt", b"12345", "text/plain")},
                data={"contact": "51999999999", "self": "Alex", "peer": "Diego"})
            assert response.status_code == 413
            assert not list(tmp_path.iterdir())
            send.assert_not_awaited()


def test_draft_id_with_colons_is_forwarded():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"sent": True, "messageId": "web:demo"}
        with TestClient(main.app) as client:
            result = client.post("/api/v1/drafts/web:51999999999:abc/send", headers=HEADERS)
            assert result.status_code == 200
            assert send.await_args.args == ("POST", "/api/drafts/web:51999999999:abc/send")


def test_backend_error_has_actionable_diagnostic():
    import httpx
    import asyncio

    async def mock_request(request):
        return httpx.Response(503, json={
            "error": "Ollama no encuentra el modelo de embeddings",
            "code": "EMBED_MODEL_NOT_FOUND",
            "hint": "docker compose exec ollama ollama pull embeddinggemma",
        })

    transport = httpx.MockTransport(mock_request)
    real_client = httpx.AsyncClient
    def client_factory(**kwargs):
        kwargs.pop("trust_env", None)
        return real_client(transport=transport, **kwargs)

    with patch.object(main.httpx, "AsyncClient", side_effect=client_factory):
        with TestClient(main.app) as client:
            response = client.get("/api/v1/contacts", headers=HEADERS)
            assert response.status_code == 503
            detail = response.json()["detail"]
            assert "EMBED_MODEL_NOT_FOUND" in detail
            assert "ollama pull embeddinggemma" in detail


def test_preview_memory_query_and_invalid_mode():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"mode": "memory_query", "answer": "Hablaron del partido [H1]", "evidence": [
            {"id": "H1", "kind": "history", "excerpt": "El sábado: partido"}], "sent": False}
        with TestClient(main.app) as client:
            response = client.post("/api/v1/preview", headers=HEADERS,
                json={"contact": "51999999999", "text": "¿De qué hablamos?", "mode": "memory_query"})
            assert response.status_code == 200
            assert response.json()["evidence"][0]["id"] == "H1"
            assert send.await_args.kwargs["payload"]["mode"] == "memory_query"
            bad = client.post("/api/v1/preview", headers=HEADERS,
                json={"contact": "51999999999", "text": "Hola", "mode": "sent"})
            assert bad.status_code == 422
            assert send.await_count == 1
            spec = client.get("/openapi.json").json()
            schema = spec["components"]["schemas"]["PreviewRequest"]
            assert "mode" in schema["properties"]



def test_preview_sessions_and_history_endpoints():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"answer": "No, no te presto.", "mode": "reply", "sent": False,
                             "session_id": "prestamo-1", "saved": True}
        with TestClient(main.app) as client:
            reply = client.post('/api/v1/preview', headers=HEADERS,
                json={"contact": "51999999999", "mode": "reply", "text": "¿Me prestas dinero?",
                      "session_id": "prestamo-1", "save": True})
            assert reply.status_code == 200
            assert send.await_args.kwargs['payload']['session_id'] == 'prestamo-1'
            assert send.await_args.kwargs['payload']['save'] is True
            invalid = client.post('/api/v1/preview', headers=HEADERS,
                json={"contact":"51999999999", "mode":"reply", "text":"Hola", "session_id":"../secret"})
            assert invalid.status_code == 422
            assert send.await_count == 1
            get = client.get('/api/v1/preview/history?contact=51999999999&session_id=prestamo-1&limit=16', headers=HEADERS)
            assert get.status_code == 200
            assert send.await_args.args == ('GET','/api/preview/history')
            assert send.await_args.kwargs['params'] == {"contact":"51999999999","session_id":"prestamo-1","limit":16}
            delete = client.delete('/api/v1/preview/history?contact=51999999999&session_id=prestamo-1', headers=HEADERS)
            assert delete.status_code == 200
            assert send.await_args.args == ('DELETE','/api/preview/history')
            assert send.await_args.kwargs['params'] == {"contact":"51999999999","session_id":"prestamo-1"}
            assert client.delete('/api/v1/preview/history?contact=51999999999&session_id=../secret',headers=HEADERS).status_code == 422
            assert client.get('/api/v1/preview/history?contact=51999999999', headers=HEADERS).status_code == 200
            assert client.get('/api/v1/preview/history?contact=51999999999').status_code == 401


def test_preview_debug_rag_contract_is_exposed_and_forwarded():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"mode":"reply", "answer":"Háblale con calma", "sent":False,
                             "rag":{"retrieval":{"anchors":["valeria"]},"selected":[]}}
        with TestClient(main.app) as client:
            result = client.post('/api/v1/preview', headers=HEADERS, json={
                'contact':'51999999999','text':'¿Qué hago con Valeria?','mode':'reply',
                'session_id':'valeria-test','save':False,'debug_rag':True})
            assert result.status_code == 200
            assert result.json()['rag']['retrieval']['anchors'] == ['valeria']
            assert send.await_args.kwargs['payload']['debug_rag'] is True
            spec = client.get('/openapi.json').json()
            assert 'debug_rag' in spec['components']['schemas']['PreviewRequest']['properties']


def test_preview_rag_policy_documentation_and_forwarding():
    with patch.object(main, 'backend', new_callable=AsyncMock) as send:
        send.return_value={'mode':'reply','answer':'Háblale tranqui','sent':False,'saved':False}
        with TestClient(main.app) as client:
            response=client.post('/api/v1/preview',headers=HEADERS,json={
                'contact':'51999999999','text':'¿Qué hago con Valeria? Me gusta',
                'mode':'reply','save':False,'rag_policy':'force','debug_rag':True})
            assert response.status_code == 200
            assert send.await_args.kwargs['payload']['rag_policy'] == 'force'
            bad=client.post('/api/v1/preview',headers=HEADERS,json={
                'contact':'51999999999','text':'hola','rag_policy':'unexpected'})
            assert bad.status_code == 422
            assert send.await_count == 1
            spec=client.get('/openapi.json').json()
            assert 'rag_policy' in spec['components']['schemas']['PreviewRequest']['properties']


def test_preview_rejects_placeholder_recent_messages():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        with TestClient(main.app) as client:
            response = client.post("/api/v1/preview", headers=HEADERS,
                json={"contact": "51999999999", "text": "Hola", "recent_messages": [{"additionalProp1": {}}]})
            assert response.status_code == 422
            send.assert_not_awaited()
            send.return_value = {"answer": "Dale", "mode": "reply", "sent": False}
            response = client.post("/api/v1/preview", headers=HEADERS,
                json={"contact": "51999999999", "text": "Hola", "recent_messages": [{"side": "peer", "text": "Vamos?"}]})
            assert response.status_code == 200
            assert send.await_args.kwargs["payload"]["recent_messages"] == [{"side": "peer", "text": "Vamos?"}]


def test_training_proxy_validates_and_forwards():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"job": {"id": "train_abc_0123abcd", "state": "queued"}}
        with TestClient(main.app) as client:
            body = {"modelName": "juan", "sources": [{"contact": "51999999999", "importHash": "a" * 64}]}
            response = client.post("/api/v1/training/jobs", headers=HEADERS, json=body)
            assert response.status_code == 201, response.text
            payload = send.await_args.kwargs["payload"]
            assert payload["quant"] == "q4_K_M" and payload["steps"] == 400 and "selfName" not in payload
            assert client.post("/api/v1/training/jobs", headers=HEADERS, json={**body, "steps": 1}).status_code == 422
            assert client.post("/api/v1/training/jobs", headers=HEADERS,
                               json={**body, "sources": [{"contact": "x", "importHash": "zz"}]}).status_code == 422
            assert client.get("/api/v1/training/jobs/../../etc", headers=HEADERS).status_code in (404, 422)
            assert client.get("/api/v1/training/jobs/train_abc_0123abcd", headers=HEADERS).status_code == 200
            assert send.await_args.args == ("GET", "/api/training/jobs/train_abc_0123abcd")
            assert client.get("/api/v1/training/jobs").status_code == 401
            assert client.post("/api/v1/training/jobs/train_abc_0123abcd/calibrate-reviewer", headers=HEADERS).status_code == 200
            assert send.await_args.args == ("POST", "/api/training/jobs/train_abc_0123abcd/calibrate-reviewer")
            assert client.post("/api/v1/training/jobs/train_abc_0123abcd/retry", headers=HEADERS).status_code == 200
            assert send.await_args.args == ("POST", "/api/training/jobs/train_abc_0123abcd/retry")
            src = [{"contact": "51999999999", "importHash": "a" * 64}]
            assert client.post("/api/v1/training/cleaning/label", headers=HEADERS, json={"sources": src, "limit": 50}).status_code == 202
            assert send.await_args.kwargs["payload"] == {"sources": src, "limit": 50}
            assert client.post("/api/v1/training/plan", headers=HEADERS, json={"sources": src, "cleaning": {"bursts": "otro"}}).status_code == 422
            client.post("/api/v1/training/plan", headers=HEADERS, json={"sources": src, "cleaning": {"bursts": "llm"}})
            assert send.await_args.kwargs["payload"]["cleaning"] == {"timeSplit": False, "bursts": "llm"}


def test_preview_forwards_writer_model_and_root_redirects():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"answer": "Bueno", "mode": "reply", "sent": False}
        with TestClient(main.app) as client:
            response = client.post("/api/v1/preview", headers=HEADERS,
                json={"contact": "51999999999", "text": "Hola", "writer_model": "juan:q4"})
            assert response.status_code == 200
            assert send.await_args.kwargs["payload"]["writer_model"] == "juan:q4"
            assert client.post("/api/v1/preview", headers=HEADERS,
                json={"contact": "51999999999", "text": "Hola", "writer_model": "a b"}).status_code == 422
            redirect = client.get("/", follow_redirects=False)
            assert redirect.status_code in (302, 307)


def test_graph_proxy_validates_and_forwards():
    with patch.object(main, "backend", new_callable=AsyncMock) as send:
        send.return_value = {"extraction": {}}
        with TestClient(main.app) as client:
            body = {"contact": "51999999999", "importHash": "a" * 64, "maxMessages": 2000}
            assert client.post("/api/v1/graph/extraction/start", headers=HEADERS, json=body).status_code == 202
            assert send.await_args.kwargs["payload"] == body
            assert client.post("/api/v1/graph/extraction/start", headers=HEADERS, json={**body, "maxMessages": 5}).status_code == 422
            assert client.get("/api/v1/graph/entity", headers=HEADERS, params={"contact": "51999999999", "key": "x" * 200}).status_code == 422
            client.get("/api/v1/graph/entities", headers=HEADERS, params={"contact": "51999999999", "q": "chato"})
            assert send.await_args.kwargs["params"] == {"contact": "51999999999", "q": "chato"}
