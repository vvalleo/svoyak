from __future__ import annotations

import asyncio
import json
import time
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
import qrcode

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = BASE_DIR / "data" / "questions.json"
STATIC_DIR = BASE_DIR / "static"
DEFAULT_TIMER_SECONDS = 15

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
    "buzz_open": False,
    "timer_deadline": None,
    "timer_task": None,
    "scores": {},
    "public_scores_visible": True,
    "final_round": {
        "active": False,
        "phase": "idle",
        "wagers": {},
        "answers": {},
        "graded": {},
        "revealed": False,
    },
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


def sanitize_score(value: int) -> int:
    return value


def current_question_data() -> Optional[Dict[str, Any]]:
    current = state["current"]
    if not current or current.get("kind") != "board":
        return None
    return QUESTIONS["categories"][current["cat"]]["questions"][current["q"]]


def final_question_data() -> Dict[str, Any]:
    return QUESTIONS.get("final", {"title": "Финальный раунд", "audio": "", "answer": ""})


def answer_for_current() -> Optional[str]:
    current = state["current"]
    if not current:
        return None
    if current["kind"] == "board":
        question = current_question_data()
        return (question or {}).get("answer") or ""
    return final_question_data().get("answer") or ""


def current_audio_url() -> Optional[str]:
    current = state["current"]
    if not current:
        return None
    if current["kind"] == "board":
        question = current_question_data()
        audio = (question or {}).get("audio")
    else:
        audio = final_question_data().get("audio")
    if not audio:
        return None
    return f"/static/audio/{audio}"


def current_payload() -> Optional[Dict[str, Any]]:
    current = state["current"]
    if not current:
        return None
    if current["kind"] == "board":
        question = current_question_data()
        if not question:
            return None
        return {
            "kind": "board",
            "cat": current["cat"],
            "q": current["q"],
            "points": question["points"],
            "audio": question["audio"],
        }

    final = final_question_data()
    return {
        "kind": "final",
        "title": final.get("title") or "Финальный раунд",
        "audio": final.get("audio") or "",
    }


def public_scores(role: str) -> Dict[str, Optional[int]]:
    if role == "host" or state["public_scores_visible"]:
        return dict(state["scores"])
    return {name: None for name in state["scores"]}


def public_final_state(role: str, player_name: Optional[str]) -> Dict[str, Any]:
    final_state = state["final_round"]
    wagers = final_state["wagers"]
    answers = final_state["answers"]
    payload: Dict[str, Any] = {
        "active": final_state["active"],
        "phase": final_state["phase"],
        "revealed": final_state["revealed"],
        "title": final_question_data().get("title") or "Финальный раунд",
    }

    if role == "host":
        payload["wagers"] = dict(wagers)
        payload["answers"] = dict(answers)
        payload["graded"] = dict(final_state["graded"])
    elif player_name:
        payload["wager"] = wagers.get(player_name)
        payload["answer"] = answers.get(player_name, "")
    return payload


def board_state_for(role: str, player_name: Optional[str] = None) -> Dict[str, Any]:
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

    return {
        "categories": categories,
        "current": current_payload(),
        "buzz": state["buzz"],
        "buzz_open": state["buzz_open"],
        "timer_deadline": state["timer_deadline"],
        "timer_seconds": DEFAULT_TIMER_SECONDS,
        "scores": public_scores(role),
        "public_scores_visible": state["public_scores_visible"],
        "final_round": public_final_state(role, player_name),
    }


async def send_state(conn: Connection) -> None:
    await conn.ws.send_json(
        {
            "type": "state",
            "data": board_state_for(conn.role, conn.name),
            "name": conn.name,
        }
    )


async def broadcast(payload: Dict[str, Any], roles: Optional[set[str]] = None) -> None:
    dead: List[Connection] = []
    for conn in connections:
        if roles and conn.role not in roles:
            continue
        try:
            await conn.ws.send_json(payload)
        except Exception:
            dead.append(conn)
    for conn in dead:
        if conn in connections:
            connections.remove(conn)


async def broadcast_state() -> None:
    dead: List[Connection] = []
    for conn in connections:
        try:
            await send_state(conn)
        except Exception:
            dead.append(conn)
    for conn in dead:
        if conn in connections:
            connections.remove(conn)


def cancel_timer() -> None:
    task = state.get("timer_task")
    if task and not task.done():
        task.cancel()
    state["timer_task"] = None
    state["timer_deadline"] = None


async def expire_timer() -> None:
    state["buzz_open"] = False
    state["timer_deadline"] = None
    state["timer_task"] = None
    await broadcast({"type": "timer_expired"})
    await broadcast_state()


def start_timer(seconds: int) -> None:
    cancel_timer()
    deadline = time.time() + seconds
    state["timer_deadline"] = deadline

    async def timer_runner() -> None:
        try:
            await asyncio.sleep(seconds)
            await expire_timer()
        except asyncio.CancelledError:
            pass

    state["timer_task"] = asyncio.create_task(timer_runner())


def reset_final_round() -> None:
    state["final_round"] = {
        "active": False,
        "phase": "idle",
        "wagers": {},
        "answers": {},
        "graded": {},
        "revealed": False,
    }


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
    return JSONResponse(board_state_for("host"))


@app.get("/qr")
def qr_code(data: str) -> Response:
    qr = qrcode.QRCode(box_size=10, border=2)
    qr.add_data(data)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return Response(content=buffer.getvalue(), media_type="image/png")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    conn: Optional[Connection] = None

    try:
        hello = await ws.receive_json()
        role = hello.get("role")
        if role not in {"board", "host", "player"}:
            await ws.send_json({"type": "error", "message": "invalid role"})
            return

        name = None
        if role == "player":
            raw_name = (hello.get("name") or "Player").strip()
            if not raw_name:
                raw_name = "Player"
            name = unique_player_name(raw_name)
            state["scores"].setdefault(name, 0)

        conn = Connection(ws, role, name)
        connections.append(conn)

        await send_state(conn)
        await broadcast({"type": "scores", "scores": public_scores("host")}, roles={"host"})

        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "open_question" and role == "host":
                cat = int(data.get("cat"))
                q = int(data.get("q"))
                seconds = max(3, min(120, int(data.get("seconds") or DEFAULT_TIMER_SECONDS)))
                key = _key(cat, q)
                if key in state["opened"] or state["final_round"]["active"]:
                    continue
                state["opened"].add(key)
                state["current"] = {"kind": "board", "cat": cat, "q": q}
                state["buzz"] = None
                state["buzz_open"] = True
                start_timer(seconds)
                await broadcast(
                    {
                        "type": "question_opened",
                        "current": current_payload(),
                        "audio_url": current_audio_url(),
                    }
                )
                await broadcast_state()

            elif msg_type == "buzz" and role == "player":
                if state["current"] and state["current"]["kind"] == "board" and state["buzz_open"] and state["buzz"] is None:
                    state["buzz"] = conn.name
                    state["buzz_open"] = False
                    await broadcast({"type": "buzz", "name": conn.name})
                    await broadcast_state()

            elif msg_type == "clear_buzz" and role == "host":
                if state["current"] and state["current"]["kind"] == "board":
                    state["buzz"] = None
                    if state["timer_deadline"] is not None:
                        state["buzz_open"] = True
                await broadcast({"type": "buzz", "name": None})
                await broadcast_state()

            elif msg_type == "award" and role == "host":
                target = data.get("name")
                delta = int(data.get("delta"))
                if target in state["scores"]:
                    state["scores"][target] = sanitize_score(state["scores"][target] + delta)
                    await broadcast_state()

            elif msg_type == "reveal_answer" and role == "host":
                if state["current"] is None:
                    continue
                if state["current"]["kind"] == "final":
                    state["final_round"]["revealed"] = True
                await broadcast({"type": "answer", "answer": answer_for_current()})
                await broadcast_state()

            elif msg_type == "close_question" and role == "host":
                cancel_timer()
                state["current"] = None
                state["buzz"] = None
                state["buzz_open"] = False
                await broadcast_state()

            elif msg_type == "start_final_round" and role == "host":
                cancel_timer()
                state["current"] = None
                state["buzz"] = None
                state["buzz_open"] = False
                state["public_scores_visible"] = False
                state["final_round"] = {
                    "active": True,
                    "phase": "wagering",
                    "wagers": {},
                    "answers": {},
                    "graded": {},
                    "revealed": False,
                }
                await broadcast_state()

            elif msg_type == "submit_wager" and role == "player":
                if not state["final_round"]["active"] or state["final_round"]["phase"] != "wagering":
                    continue
                target = conn.name
                if target is None:
                    continue
                max_wager = max(0, state["scores"].get(target, 0))
                wager = int(data.get("wager") or 0)
                if 0 <= wager <= max_wager:
                    state["final_round"]["wagers"][target] = wager
                    await broadcast_state()

            elif msg_type == "open_final_question" and role == "host":
                if not state["final_round"]["active"] or state["final_round"]["phase"] != "wagering":
                    continue
                state["final_round"]["phase"] = "answering"
                state["current"] = {"kind": "final"}
                seconds = max(5, min(180, int(data.get("seconds") or 30)))
                state["buzz"] = None
                state["buzz_open"] = False
                start_timer(seconds)
                await broadcast(
                    {
                        "type": "question_opened",
                        "current": current_payload(),
                        "audio_url": current_audio_url(),
                    }
                )
                await broadcast_state()

            elif msg_type == "submit_final_answer" and role == "player":
                if state["final_round"]["phase"] != "answering" or conn.name is None:
                    continue
                if conn.name not in state["final_round"]["wagers"]:
                    continue
                answer = (data.get("answer") or "").strip()
                state["final_round"]["answers"][conn.name] = answer
                await broadcast_state()

            elif msg_type == "grade_final_answer" and role == "host":
                if not state["final_round"]["active"]:
                    continue
                target = data.get("name")
                correct = bool(data.get("correct"))
                wager = state["final_round"]["wagers"].get(target)
                if (
                    target in state["scores"]
                    and wager is not None
                    and target not in state["final_round"]["graded"]
                ):
                    delta = wager if correct else -wager
                    state["scores"][target] = sanitize_score(state["scores"][target] + delta)
                    state["final_round"]["graded"][target] = "correct" if correct else "wrong"
                    await broadcast_state()

            elif msg_type == "reveal_final_scores" and role == "host":
                state["public_scores_visible"] = True
                state["final_round"]["phase"] = "done"
                cancel_timer()
                await broadcast_state()

            elif msg_type == "reset_final_round" and role == "host":
                cancel_timer()
                state["current"] = None
                state["buzz"] = None
                state["buzz_open"] = False
                state["public_scores_visible"] = True
                reset_final_round()
                await broadcast_state()

    except WebSocketDisconnect:
        pass
    finally:
        if conn and conn in connections:
            connections.remove(conn)
