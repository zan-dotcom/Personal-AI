"""HTTP integration tests with a deterministic local Ollama stand-in."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from personal_ai.server import App


class ModelHandler(BaseHTTPRequestHandler):
    payloads = []

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({"models": [{"name": "qwen3:8b"}]}).encode())

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.payloads.append(payload)
        self.send_response(200)
        self.end_headers()
        if payload["model"] == "broken":
            self.wfile.write(b'{"error":"model unavailable"}\n')
            return
        for token in ["Hello ", "from your local AI."]:
            self.wfile.write(json.dumps({"message": {"content": token}, "done": False}).encode() + b"\n")
        self.wfile.write(b'{"done":true}\n')


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        self.model_thread = threading.Thread(target=self.model.serve_forever, daemon=True)
        self.model_thread.start()
        self.app = App(("127.0.0.1", 0), self.temp.name,
                       f"http://127.0.0.1:{self.model.server_port}")
        self.app_thread = threading.Thread(target=self.app.serve_forever, daemon=True)
        self.app_thread.start()
        self.url = f"http://127.0.0.1:{self.app.server_port}"
        self.client = build_opener(ProxyHandler({}))
        ModelHandler.payloads = []

    def tearDown(self):
        self.app.shutdown()
        self.app.server_close()
        self.model.shutdown()
        self.model.server_close()
        self.app_thread.join()
        self.model_thread.join()
        self.temp.cleanup()

    def request(self, path, body=None, method=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        return self.client.open(Request(self.url + path, data=data, method=method,
                                        headers=headers or {}), timeout=10)

    def chat(self, **overrides):
        body = {"message": "Help me write a plan", "model": "qwen3:8b", **overrides}
        with self.request("/api/chat", body) as response:
            return [json.loads(line) for line in response]

    def test_home_and_models(self):
        with self.request("/") as response:
            self.assertIn(b"Hearth", response.read())
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        with self.request("/api/status") as response:
            self.assertEqual(json.load(response)["models"], ["qwen3:8b"])

    def test_stream_history_followup_persistence_and_delete(self):
        events = self.chat()
        self.assertEqual(events[-1], {"type": "done"})
        self.assertEqual("".join(e.get("content", "") for e in events), "Hello from your local AI.")
        cid = events[0]["conversation_id"]
        with self.request(f"/api/conversations/{cid}") as response:
            saved = json.load(response)
        self.assertEqual([m["role"] for m in saved["messages"]], ["user", "assistant"])
        self.chat(conversation_id=cid, message="Make it shorter", system_prompt="Be brief")
        payload = ModelHandler.payloads[-1]
        self.assertEqual([m["role"] for m in payload["messages"]], ["system", "user", "assistant", "user"])
        self.assertEqual(payload["messages"][0]["content"], "Be brief")
        self.assertFalse(payload["think"])
        from personal_ai.server import Store
        reopened = Store(Path(self.temp.name) / "chats.sqlite3")
        self.assertEqual(len(reopened.get(cid)["messages"]), 4)
        with self.request(f"/api/conversations/{cid}", method="DELETE") as response:
            self.assertTrue(json.load(response)["deleted"])
        self.assertIsNone(reopened.get(cid))
        with reopened.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)

    def test_validation_and_missing_conversations(self):
        for body in [{"message": "", "model": "x"}, {"message": "x" * 12001, "model": "x"},
                     {"message": "x", "model": "x", "temperature": "hot"}, []]:
            with self.assertRaises(HTTPError) as caught:
                self.request("/api/chat", body)
            self.assertEqual(caught.exception.code, 400)
        with self.assertRaises(HTTPError) as caught:
            self.chat(conversation_id="nonexistent")
        self.assertEqual(caught.exception.code, 404)
        self.assertEqual(self.app.store.list(), [])

    def test_foreign_origins_hosts_and_static_paths_blocked(self):
        for headers in [{"Origin": "https://evil.example"}, {"Host": "evil.example"}]:
            with self.assertRaises(HTTPError) as caught:
                self.request("/api/chat", {"message": "hello", "model": "x"}, headers=headers)
            self.assertEqual(caught.exception.code, 403)
        with self.assertRaises(HTTPError) as caught:
            self.request("/../server.py")
        self.assertEqual(caught.exception.code, 404)

    def test_model_error_keeps_user_message_without_fake_answer(self):
        events = self.chat(model="broken")
        self.assertEqual(events[-1], {"type": "error", "error": "model unavailable"})
        saved = self.app.store.get(events[0]["conversation_id"])
        self.assertEqual(len(saved["messages"]), 1)
        self.assertEqual(saved["messages"][0]["role"], "user")

    def test_offline_model_status(self):
        self.model.shutdown()
        self.model.server_close()
        with self.request("/api/status") as response:
            self.assertFalse(json.load(response)["online"])

    def test_history_budget_keeps_current_message(self):
        cid = self.app.store.create("Long chat")
        self.app.store.add(cid, "user", "a" * 7000)
        self.app.store.add(cid, "assistant", "b" * 7000)
        self.chat(conversation_id=cid, message="Latest question")
        messages = ModelHandler.payloads[-1]["messages"]
        self.assertEqual(messages[-1]["content"], "Latest question")
        self.assertEqual(messages[0]["role"], "system")
        self.assertLessEqual(sum(len(m["content"]) for m in messages), 12000)


if __name__ == "__main__":
    unittest.main()
