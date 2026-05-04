const boardEl = document.getElementById("board");
const scoresEl = document.getElementById("scores");
const hostStatus = document.getElementById("hostStatus");
const currentQuestion = document.getElementById("currentQuestion");
const answerTimerEl = document.getElementById("answerTimer");
const buzzEl = document.getElementById("buzz");
const chooserStatusEl = document.getElementById("chooserStatus");
const audioEl = document.getElementById("audio");
const answerEl = document.getElementById("answer");
const playerSelect = document.getElementById("playerSelect");
const deltaInput = document.getElementById("delta");
const scoreValueInput = document.getElementById("scoreValue");
const finalStatus = document.getElementById("finalStatus");
const finalGrid = document.getElementById("finalGrid");
const playerLinkEl = document.getElementById("playerLink");
const playerQrEl = document.getElementById("playerQr");

const revealBtn = document.getElementById("reveal");
const resolveCorrectBtn = document.getElementById("resolveCorrect");
const resolveDoubleBtn = document.getElementById("resolveDouble");
const resolveWrongBtn = document.getElementById("resolveWrong");
const resolveNoPenaltyBtn = document.getElementById("resolveNoPenalty");
const closeQuestionBtn = document.getElementById("closeQuestion");
const awardBtn = document.getElementById("award");
const setScoreBtn = document.getElementById("setScore");
const startFinalBtn = document.getElementById("startFinal");
const openFinalBtn = document.getElementById("openFinal");
const revealFinalScoresBtn = document.getElementById("revealFinalScores");
const resetFinalBtn = document.getElementById("resetFinal");

let state = null;
let currentPoints = 0;
let answerTimerInterval = null;
const playerUrl = `${window.location.origin}/player`;

playerLinkEl.textContent = playerUrl;
playerQrEl.src = `/qr?data=${encodeURIComponent(playerUrl)}`;

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
    data.categories.forEach((cat, cIdx) => {
      const q = cat.questions[r];
      const cell = document.createElement("div");
      cell.className = "board-cell";
      if (q.opened || data.final_round.active) cell.classList.add("disabled");
      cell.textContent = q.opened ? "" : q.points;
      if (!q.opened && !data.final_round.active) {
        cell.addEventListener("click", () => openQuestion(cIdx, r));
      }
      boardEl.appendChild(cell);
    });
  }
}

function renderScores(scores) {
  scoresEl.innerHTML = "";
  playerSelect.innerHTML = "";
  const entries = Object.entries(scores || {});
  entries.sort((a, b) => b[1] - a[1]);
  entries.forEach(([name, score]) => {
    const row = document.createElement("div");
    row.className = "score-item";
    row.innerHTML = `<span>${name}</span><span>${score ?? "-"}</span>`;
    scoresEl.appendChild(row);

    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    playerSelect.appendChild(option);
  });
}

function updateAnswerTimer(deadline) {
  if (answerTimerInterval) {
    clearInterval(answerTimerInterval);
    answerTimerInterval = null;
  }

  if (!deadline) {
    answerTimerEl.textContent = "Таймер ответа: -";
    return;
  }

  const tick = () => {
    const remaining = Math.max(0, Math.ceil(deadline - Date.now() / 1000));
    answerTimerEl.textContent = `Таймер ответа: ${remaining} сек`;
    if (remaining <= 0 && answerTimerInterval) {
      clearInterval(answerTimerInterval);
      answerTimerInterval = null;
    }
  };

  tick();
  answerTimerInterval = setInterval(tick, 250);
}

function updateCurrent(data) {
  if (!data || !data.current) {
    if (data?.final_round?.active) {
      hostStatus.textContent = "Финал в процессе";
    } else if (data?.chooser) {
      hostStatus.textContent = `Следующий вопрос выбирает ${data.chooser}`;
    } else {
      hostStatus.textContent = "Ожидание выбора";
    }
    currentQuestion.textContent = "-";
    currentPoints = 0;
    answerEl.textContent = "Ответ: -";
    audioEl.removeAttribute("src");
    audioEl.pause();
    updateAnswerTimer(null);
    return;
  }

  if (data.current.kind === "final") {
    currentPoints = 0;
    hostStatus.textContent = "Идет финальный вопрос";
    currentQuestion.textContent = data.current.title || "Финальный раунд";
  } else {
    currentPoints = data.current.points;
    hostStatus.textContent = `Идет вопрос за ${data.current.points}`;
    currentQuestion.textContent = `Категория ${data.current.cat + 1}, вопрос ${data.current.q + 1} (${data.current.points})`;
  }

  answerEl.textContent = "Ответ: -";
  updateAnswerTimer(data.answer_timer_deadline);
}

function updateBuzz(name, buzzOpen, currentKind) {
  if (currentKind === "final") {
    buzzEl.textContent = "Финал: без кнопки ответа";
    return;
  }
  if (name) {
    buzzEl.textContent = `Отвечает: ${name}`;
    return;
  }
  buzzEl.textContent = buzzOpen ? "Кнопка ответа открыта" : "Кнопка ответа закрыта";
}

function updateChooser(chooser) {
  chooserStatusEl.textContent = chooser ? `Следующий вопрос выбирает: ${chooser}` : "Следующий вопрос пока не выбран.";
}

function renderFinal(finalRound) {
  if (!finalRound.active) {
    finalStatus.textContent = "Финал еще не запущен";
    finalGrid.innerHTML = "";
    return;
  }

  const phaseMap = {
    wagering: "Игроки делают ставки",
    answering: "Игроки отправляют ответы",
    done: "Финал завершен",
  };
  finalStatus.textContent = phaseMap[finalRound.phase] || "Финал активен";

  const allPlayers = Object.keys(state.scores || {});
  finalGrid.innerHTML = "";
  allPlayers.forEach((name) => {
    const card = document.createElement("div");
    card.className = "final-card";
    const wager = finalRound.wagers?.[name];
    const answer = finalRound.answers?.[name];
    const graded = finalRound.graded?.[name];
    card.innerHTML = `
      <div class="final-card-title">${name}</div>
      <div class="status">Ставка: ${wager ?? "-"}</div>
      <div class="status">Ответ: ${answer ? "получен" : "-"}</div>
      <div class="status">Статус: ${graded || "-"}</div>
    `;
    if (finalRound.phase !== "wagering" && wager !== undefined && !graded) {
      const actions = document.createElement("div");
      actions.className = "controls";

      const correctBtn = document.createElement("button");
      correctBtn.className = "button";
      correctBtn.textContent = "Верно";
      correctBtn.addEventListener("click", () => gradeFinalAnswer(name, true));

      const wrongBtn = document.createElement("button");
      wrongBtn.className = "button danger";
      wrongBtn.textContent = "Неверно";
      wrongBtn.addEventListener("click", () => gradeFinalAnswer(name, false));

      actions.appendChild(correctBtn);
      actions.appendChild(wrongBtn);
      card.appendChild(actions);
    }
    finalGrid.appendChild(card);
  });
}

function syncFromState(data) {
  state = data;
  renderBoard(data);
  renderScores(data.scores);
  updateCurrent(data);
  updateBuzz(data.buzz, data.buzz_open, data.current?.kind);
  updateChooser(data.chooser);
  renderFinal(data.final_round);
}

const wsScheme = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsScheme}://${location.host}/ws`);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ role: "host" }));
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "state") {
    syncFromState(msg.data);
  }
  if (msg.type === "question_opened" && msg.audio_url) {
    audioEl.src = msg.audio_url;
    audioEl.load();
    audioEl.play().catch(() => {});
  }
  if (msg.type === "question_reopened" && msg.current?.kind === "board") {
    currentQuestion.textContent = `Категория ${msg.current.cat + 1}, вопрос ${msg.current.q + 1} (${msg.current.points})`;
  }
  if (msg.type === "buzz") {
    audioEl.pause();
    updateBuzz(msg.name, false, state?.current?.kind);
  }
  if (msg.type === "answer") {
    answerEl.textContent = `Ответ: ${msg.answer || "-"}`;
  }
  if (msg.type === "answer_timer_expired") {
    answerTimerEl.textContent = "Таймер ответа: время вышло";
  }
});

function openQuestion(cat, q) {
  ws.send(JSON.stringify({ type: "open_question", cat, q }));
}

function resolveBuzz(result) {
  ws.send(JSON.stringify({ type: "resolve_buzz", result }));
}

function gradeFinalAnswer(name, correct) {
  ws.send(JSON.stringify({ type: "grade_final_answer", name, correct }));
}

resolveCorrectBtn.addEventListener("click", () => resolveBuzz("correct"));
resolveDoubleBtn.addEventListener("click", () => resolveBuzz("double"));
resolveWrongBtn.addEventListener("click", () => resolveBuzz("wrong"));
resolveNoPenaltyBtn.addEventListener("click", () => resolveBuzz("no_penalty"));

revealBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "reveal_answer" }));
});

closeQuestionBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "close_question" }));
});

awardBtn.addEventListener("click", () => {
  const name = playerSelect.value;
  const delta = parseInt(deltaInput.value, 10);
  if (!name || Number.isNaN(delta)) return;
  ws.send(JSON.stringify({ type: "award", name, delta }));
  deltaInput.value = "";
});

setScoreBtn.addEventListener("click", () => {
  const name = playerSelect.value;
  const score = parseInt(scoreValueInput.value, 10);
  if (!name || Number.isNaN(score)) return;
  ws.send(JSON.stringify({ type: "set_score", name, score }));
  scoreValueInput.value = "";
});

deltaInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") awardBtn.click();
});

scoreValueInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") setScoreBtn.click();
});

startFinalBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "start_final_round" }));
});

openFinalBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "open_final_question" }));
});

revealFinalScoresBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "reveal_final_scores" }));
});

resetFinalBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "reset_final_round" }));
});
