const nameInput = document.getElementById("nameInput");
const connectBtn = document.getElementById("connect");
const playerStatus = document.getElementById("playerStatus");
const gamePanel = document.getElementById("gamePanel");
const questionStatus = document.getElementById("questionStatus");
const answerTimerEl = document.getElementById("answerTimer");
const buzzBtn = document.getElementById("buzz");
const buzzStatus = document.getElementById("buzzStatus");
const finalPanel = document.getElementById("finalPanel");
const finalPlayerStatus = document.getElementById("finalPlayerStatus");
const wagerInput = document.getElementById("wagerInput");
const submitWagerBtn = document.getElementById("submitWager");
const answerInput = document.getElementById("answerInput");
const submitAnswerBtn = document.getElementById("submitAnswer");

let ws = null;
let connected = false;
let currentOpen = false;
let playerName = null;
let answerTimerInterval = null;

function setStatus(text) {
  playerStatus.textContent = text;
}

function setQuestion(text) {
  questionStatus.textContent = text;
}

function setBuzz(text) {
  buzzStatus.textContent = text;
}

function setBuzzEnabled(enabled) {
  buzzBtn.disabled = !enabled;
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

function updateQuestion(current, buzzOpen, playerAnswered) {
  if (!current || current.kind === "final") {
    currentOpen = false;
    setQuestion(current?.kind === "final" ? "Финальный раунд идет" : "Ожидание вопроса");
    setBuzzEnabled(false);
    updateAnswerTimer(null);
    return;
  }
  currentOpen = true;
  setQuestion(`Идет вопрос за ${current.points}`);
  setBuzzEnabled(Boolean(buzzOpen) && !playerAnswered);
  updateAnswerTimer(stateCache?.answer_timer_deadline || null);
}

function updateFinal(finalRound, current) {
  if (!finalRound.active) {
    finalPanel.style.display = "none";
    return;
  }

  finalPanel.style.display = "grid";
  const wager = finalRound.wager;
  if (wager !== undefined) {
    wagerInput.value = wager;
  }
  if (finalRound.answer) {
    answerInput.value = finalRound.answer;
  }

  if (finalRound.phase === "wagering") {
    finalPlayerStatus.textContent = "Сделай ставку в пределах своих очков";
    wagerInput.disabled = false;
    submitWagerBtn.disabled = false;
    answerInput.disabled = true;
    submitAnswerBtn.disabled = true;
  } else if (finalRound.phase === "answering") {
    finalPlayerStatus.textContent = current?.title || "Отправь свой ответ";
    wagerInput.disabled = true;
    submitWagerBtn.disabled = true;
    answerInput.disabled = false;
    submitAnswerBtn.disabled = false;
  } else {
    finalPlayerStatus.textContent = "Финальный раунд завершен";
    wagerInput.disabled = true;
    submitWagerBtn.disabled = true;
    answerInput.disabled = true;
    submitAnswerBtn.disabled = true;
  }
}

let stateCache = null;

function updateState(data) {
  stateCache = data;
  updateQuestion(data.current, data.buzz_open && !data.buzz, data.player_answered);

  if (data.current?.kind === "final") {
    setBuzz("Финал: ответы скрыты");
  } else if (data.buzz) {
    setBuzz(data.buzz === playerName ? "Ты отвечаешь сейчас" : `Отвечает: ${data.buzz}`);
  } else if (data.player_answered) {
    setBuzz("Ты уже отвечала в этом вопросе");
  } else if (data.buzz_open) {
    setBuzz("Кнопка активна");
  } else {
    setBuzz("Кнопка заблокирована");
  }

  gamePanel.style.display = data.final_round.active ? "none" : "block";
  updateFinal(data.final_round, data.current);
}

connectBtn.addEventListener("click", () => {
  if (connected) return;
  const name = nameInput.value.trim() || "Player";
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsScheme}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ role: "player", name }));
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      connected = true;
      playerName = msg.name;
      nameInput.disabled = true;
      connectBtn.disabled = true;
      gamePanel.style.display = "block";
      setStatus(`Подключено как ${msg.name}`);
      updateState(msg.data);
    }
    if (msg.type === "question_opened" && msg.current?.kind === "board") {
      setBuzz("Кнопка активна");
      setBuzzEnabled(!stateCache?.player_answered);
    }
    if (msg.type === "question_reopened" && msg.current?.kind === "board") {
      setQuestion(`Идет вопрос за ${msg.current.points}`);
      if (!stateCache?.player_answered) {
        setBuzz("Кнопка активна");
        setBuzzEnabled(true);
      }
    }
    if (msg.type === "buzz" && msg.name) {
      setBuzz(msg.name === playerName ? "Ты отвечаешь сейчас" : `Отвечает: ${msg.name}`);
      setBuzzEnabled(false);
    }
    if (msg.type === "answer_timer_expired") {
      answerTimerEl.textContent = "Таймер ответа: время вышло";
    }
  });

  ws.addEventListener("close", () => {
    connected = false;
    setStatus("Соединение потеряно. Перезагрузите страницу.");
    setBuzzEnabled(false);
  });
});

buzzBtn.addEventListener("click", () => {
  if (!ws || !currentOpen) return;
  ws.send(JSON.stringify({ type: "buzz" }));
  setBuzzEnabled(false);
});

submitWagerBtn.addEventListener("click", () => {
  const wager = parseInt(wagerInput.value, 10);
  if (!ws || Number.isNaN(wager)) return;
  ws.send(JSON.stringify({ type: "submit_wager", wager }));
});

submitAnswerBtn.addEventListener("click", () => {
  const answer = answerInput.value.trim();
  if (!ws) return;
  ws.send(JSON.stringify({ type: "submit_final_answer", answer }));
});
