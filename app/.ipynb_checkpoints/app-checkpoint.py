from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = BASE_DIR / "data" / "questions.json"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def load_questions() -> Dict[str, Any]:
    with DATA_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


QUESTIONS = load_questions()


def _key(cat_idx: int, q_idx: int) -> str:
    return f"{cat_idx}:{q_idx}"


state: Dict[str, Any] = {
    "opened": set(),
    "current": None,
    "buzz": None,
    "scores": {},
}


class Connection:
    def __init__(self, ws: WebSocket, role: str, name: Optional[str] = None):
        self.ws = ws
        self.role = role
        self.name = name


connections: List[Connection] = []


def unique_player_name(name: str) -> str:
    if name not in state["scores"]:
        return name
    i = 2
    while f"{name} {i}" in state["scores"]:
        i += 1
    return f"{name} {i}"


def board_state() -> Dict[str, Any]:
    categories = []
    for c_idx, cat in enumerate(QUESTIONS["categories"]):
        questions = []
        for q_idx, q in enumerate(cat["questions"]):
            questions.append(
                {
                    "points": q["points"],
                    "opened": _key(c_idx, q_idx) in state["opened"],
                }
            )
        categories.append({"title": cat["title"], "questions": questions})

    current = state["current"]
    current_payload = None
    if current:
        q = QUESTIONS["categories"][current["cat"]]["questions"][current["q"]]
        current_payload = {
            "cat": current["cat"],
            "q": current["q"],
            "points": q["points"],
            "audio": q["audio"],
        }

    return {
        "categories": categories,
        "current": current_payload,
        "buzz": state["buzz"],
        "scores": state["scores"],
    }


def answer_for_current() -> Optional[str]:
    current = state["current"]
    if not current:
        return None
    q = QUESTIONS["categories"][current["cat"]]["questions"][current["q"]]
    return q.get("answer") or ""


def current_audio_url() -> Optional[str]:
    current = state["current"]
    if not current:
        return None
    q = QUESTIONS["categories"][current["cat"]]["questions"][current["q"]]
    return f"/static/audio/{q['audio']}"


async def broadcast(payload: Dict[str, Any]) -> None:
    dead: List[Connection] = []
    for conn in connections:
        try:
            await conn.ws.send_json(payload)
        except Exception:
            dead.append(conn)
    for conn in dead:
        if conn in connections:
            connections.remove(conn)


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "board.html")


@app.get("/board")
def board() -> FileResponse:
    return FileResponse(STATIC_DIR / "board.html")


@app.get("/host")
def host() -> FileResponse:
    return FileResponse(STATIC_DIR / "host.html")


@app.get("/player")
def player() -> FileResponse:
    return FileResponse(STATIC_DIR / "player.html")


@app.get("/api/state")
def api_state() -> JSONResponse:
    return JSONResponse(board_state())


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    role = None
    name = None
    conn = None

    try:
        hello = await ws.receive_json()
        role = hello.get("role")
        if role not in {"board", "host", "player"}:
            await ws.send_json({"type": "error", "message": "invalid role"})
            return

        if role == "player":
            raw_name = (hello.get("name") or "Player").strip()
            if not raw_name:
                raw_name = "Player"
            name = unique_player_name(raw_name)
            state["scores"].setdefault(name, 0)

        conn = Connection(ws, role, name)
        connections.append(conn)

        await ws.send_json({"type": "state", "data": board_state(), "name": name})
        await broadcast({"type": "scores", "scores": state["scores"]})

        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "open_question" and role == "host":
                cat = int(data.get("cat"))
                q = int(data.get("q"))
                key = _key(cat, q)
                if key not in state["opened"]:
                    state["opened"].add(key)
                    state["current"] = {"cat": cat, "q": q}
                    state["buzz"] = None
                    await broadcast({
                        "type": "question_opened",
                        "current": board_state()["current"],
                        "audio_url": current_audio_url(),
                    })
                    await broadcast({"type": "state", "data": board_state()})

            elif msg_type == "buzz" and role == "player":
                if state["current"] and state["buzz"] is None:
                    state["buzz"] = name
                    await broadcast({"type": "buzz", "name": name})

            elif msg_type == "clear_buzz" and role == "host":
                state["buzz"] = None
                await broadcast({"type": "buzz", "name": None})

            elif msg_type == "award" and role == "host":
                target = data.get("name")
                delta = int(data.get("delta"))
                if target in state["scores"]:
                    state["scores"][target] += delta
                    await broadcast({"type": "scores", "scores": state["scores"]})

            elif msg_type == "reveal_answer" and role == "host":
                await broadcast({"type": "answer", "answer": answer_for_current()})

            elif msg_type == "close_question" and role == "host":
                state["current"] = None
                state["buzz"] = None
                await broadcast({"type": "state", "data": board_state()})

    except WebSocketDisconnect:
        pass
    finally:
        if conn and conn in connections:
            connections.remove(conn)
