const boardEl = document.getElementById("board");
const scoresEl = document.getElementById("scores");
const currentStatus = document.getElementById("currentStatus");
const currentQuestion = document.getElementById("currentQuestion");
const buzzEl = document.getElementById("buzz");
const audioEl = document.getElementById("audio");
const answerEl = document.getElementById("answer");
const scoresStatusEl = document.getElementById("scoresStatus");

let state = null;

function renderBoard(data) {
  boardEl.innerHTML = "";
  if (!data) return;

  const columns = data.categories.length;
  boardEl.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;

  data.categories.forEach((cat) => {
    const cell = document.createElement("div");
    cell.className = "board-cell category disabled";
    cell.textContent = cat.title;
    boardEl.appendChild(cell);
  });

  const rows = data.categories[0]?.questions.length || 0;
  for (let r = 0; r < rows; r += 1) {
    data.categories.forEach((cat) => {
      const q = cat.questions[r];
      const cell = document.createElement("div");
      cell.className = "board-cell";
      if (q.opened) cell.classList.add("disabled");
      cell.textContent = q.opened ? "" : q.points;
      boardEl.appendChild(cell);
    });
  }
}

function renderScores(scores, visible) {
  scoresEl.innerHTML = "";
  scoresStatusEl.textContent = visible ? "Очки видны игрокам" : "Очки скрыты до конца финала";
  const entries = Object.entries(scores || {});
  entries.forEach(([name, score]) => {
    const row = document.createElement("div");
    row.className = "score-item";
    row.innerHTML = `<span>${name}</span><span>${score ?? "???"}</span>`;
    scoresEl.appendChild(row);
  });
}

function updateCurrent(data) {
  if (!data || !data.current) {
    currentStatus.textContent = data?.final_round?.active ? "Финал в процессе" : "Ожидание выбора вопроса";
    currentQuestion.textContent = "-";
    answerEl.textContent = "Ответ: скрыт";
    audioEl.removeAttribute("src");
    audioEl.pause();
    return;
  }

  if (data.current.kind === "final") {
    currentStatus.textContent = "Финальный раунд";
    currentQuestion.textContent = data.current.title || "Финальный раунд";
  } else {
    currentStatus.textContent = `Идет вопрос за ${data.current.points}`;
    currentQuestion.textContent = `Категория ${data.current.cat + 1}, вопрос ${data.current.q + 1} (${data.current.points})`;
  }

  answerEl.textContent = "Ответ: скрыт";
}

function updateBuzz(name, buzzOpen, currentKind) {
  if (currentKind === "final") {
    buzzEl.textContent = "Финал: игроки отвечают скрыто";
    return;
  }
  if (name) {
    buzzEl.textContent = `Кто ответит первым: ${name}`;
    return;
  }
  buzzEl.textContent = buzzOpen ? "Кнопка активна" : "Кнопка заблокирована";
}

function syncFromState(data) {
  state = data;
  renderBoard(data);
  renderScores(data.scores, data.public_scores_visible);
  updateCurrent(data);
  updateBuzz(data.buzz, data.buzz_open, data.current?.kind);
}

const wsScheme = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsScheme}://${location.host}/ws`);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ role: "board" }));
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "state") {
    syncFromState(msg.data);
  }
  if (msg.type === "question_opened" && msg.audio_url) {
    audioEl.src = msg.audio_url;
    audioEl.load();
  }
  if (msg.type === "buzz") {
    updateBuzz(msg.name, false, state?.current?.kind);
  }
  if (msg.type === "answer") {
    answerEl.textContent = `Ответ: ${msg.answer || "-"}`;
  }
});
