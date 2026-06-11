"use strict";

const STATE_KEY = "canvasSkkuVideoAutoplayerState";
const OPTIONS_KEY = "canvasSkkuVideoAutoplayerOptions";

const els = {
  pageStatus: document.getElementById("pageStatus"),
  runStatus: document.getElementById("runStatus"),
  progressText: document.getElementById("progressText"),
  queueCount: document.getElementById("queueCount"),
  queueList: document.getElementById("queueList"),
  message: document.getElementById("message"),
  startButton: document.getElementById("startButton"),
  nextButton: document.getElementById("nextButton"),
  stopButton: document.getElementById("stopButton"),
  includeCompleted: document.getElementById("includeCompleted"),
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  selectAllButton: document.getElementById("selectAllButton"),
  clearSelectionButton: document.getElementById("clearSelectionButton")
};

const selectedItemKeys = new Set();
let lastQueueSignature = "";

document.addEventListener("DOMContentLoaded", init);
els.startButton.addEventListener("click", start);
els.searchButton.addEventListener("click", search);
els.nextButton.addEventListener("click", next);
els.stopButton.addEventListener("click", stop);
els.selectAllButton.addEventListener("click", selectAllPreviewItems);
els.clearSelectionButton.addEventListener("click", clearPreviewSelection);
els.includeCompleted.addEventListener("change", saveOptions);
els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") search();
});

async function init() {
  const options = await chrome.storage.local.get(OPTIONS_KEY);
  els.includeCompleted.checked = Boolean(options[OPTIONS_KEY]?.includeCompleted);
  els.searchInput.value = options[OPTIONS_KEY]?.searchQuery || "";
  await refresh();
  setInterval(refreshStateOnly, 1000);
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isCanvas = Boolean(tab?.url?.startsWith("https://canvas.skku.edu/"));
  els.pageStatus.textContent = isCanvas ? "Canvas tab connected" : "Open canvas.skku.edu first.";
  setButtons(isCanvas);

  const stateResult = await chrome.storage.local.get(STATE_KEY);
  renderState(stateResult[STATE_KEY]);
}

async function refreshStateOnly() {
  const stateResult = await chrome.storage.local.get(STATE_KEY);
  renderState(stateResult[STATE_KEY]);
}

async function start() {
  await saveOptions();

  const stateResult = await chrome.storage.local.get(STATE_KEY);
  const previewState = stateResult[STATE_KEY];
  const previewQueue = Array.isArray(previewState?.queue) ? previewState.queue : [];
  if (!previewState?.enabled && previewQueue.length) {
    const selectedQueue = previewQueue.filter((item) => selectedItemKeys.has(itemKey(item)));
    if (!selectedQueue.length) {
      showMessage("시작할 항목을 하나 이상 선택하세요.");
      return;
    }

    const state = {
      ...previewState,
      enabled: true,
      statusText: "첫 영상 항목 여는 중",
      note: selectedQueue[0].url ? "" : "이 항목은 URL이 없어 표 행을 직접 클릭합니다.",
      queue: selectedQueue,
      currentIndex: 0,
      startedAt: Date.now(),
      navigatedAt: Date.now()
    };
    await chrome.storage.local.set({ [STATE_KEY]: state });
    syncSelectionToQueue(selectedQueue);
    const opened = await openItemInFrame(previewState.sourceFrameId ?? -1, selectedQueue[0]);
    showMessage(opened ? `선택한 동영상 ${selectedQueue.length}개 중 첫 항목을 열었습니다.` : "첫 항목을 자동으로 열지 못했습니다.");
    await refresh();
    return;
  }

  const allFrameScan = await scanAllFrames({ videoOnly: true });
  if (allFrameScan?.items?.length) {
    syncSelectionToQueue(allFrameScan.items);
    const state = {
      enabled: true,
      statusText: "첫 영상 항목 여는 중",
      note: allFrameScan.items[0].url ? "" : "이 항목은 URL이 없어 표 행을 직접 클릭합니다.",
      queue: allFrameScan.items,
      currentIndex: 0,
      sourceFrameId: allFrameScan.sourceFrameId,
      startedAt: Date.now(),
      navigatedAt: Date.now(),
      diagnostics: allFrameScan.diagnostics
    };
    await chrome.storage.local.set({ [STATE_KEY]: state });
    const opened = await openItemInFrame(allFrameScan.sourceFrameId, allFrameScan.items[0]);
    showMessage(opened ? `동영상 항목 ${allFrameScan.items.length}개 중 첫 항목을 열었습니다.` : "첫 항목을 자동으로 열지 못했습니다.");
    await refresh();
    return;
  }

  const response = await sendToActiveTab({
    type: "CANVAS_VIDEO_AUTOPLAYER_START",
    includeCompleted: els.includeCompleted.checked,
    searchQuery: els.searchInput.value.trim()
  });
  showMessage(response?.message || "Start request sent.");
  await refresh();
}

async function search() {
  await saveOptions();
  const allFrameScan = await scanAllFrames({ videoOnly: true });
  if (allFrameScan?.items?.length) {
    await chrome.storage.local.set({
      [STATE_KEY]: {
        enabled: false,
        statusText: "할 일 미리보기 완료",
        note: "",
        queue: allFrameScan.items,
        currentIndex: -1,
        sourceFrameId: allFrameScan.sourceFrameId,
        startedAt: Date.now(),
        diagnostics: allFrameScan.diagnostics
      }
    });
    syncSelectionToQueue(allFrameScan.items);
    showMessage(`동영상 할 일 ${allFrameScan.items.length}개를 찾았습니다. frame ${allFrameScan.sourceFrameId} 기준.`);
    await refresh();
    return;
  }

  const response = await sendToActiveTab({
    type: "CANVAS_VIDEO_AUTOPLAYER_SCAN",
    includeCompleted: els.includeCompleted.checked,
    searchQuery: els.searchInput.value.trim()
  });
  showMessage(response?.message || "Search complete.");
  await refresh();
}

async function next() {
  const response = await sendToActiveTab({ type: "CANVAS_VIDEO_AUTOPLAYER_NEXT" });
  showMessage(response?.message || "Moving to next item.");
  await refresh();
}

async function stop() {
  const response = await sendToActiveTab({ type: "CANVAS_VIDEO_AUTOPLAYER_STOP" });
  showMessage(response?.message || "Stopped.");
  await refresh();
}

async function saveOptions() {
  await chrome.storage.local.set({
    [OPTIONS_KEY]: {
      includeCompleted: els.includeCompleted.checked,
      searchQuery: els.searchInput.value.trim()
    }
  });
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://canvas.skku.edu/")) {
    showMessage("Open a canvas.skku.edu tab and try again.");
    return null;
  }

  try {
    await ensureContentScript(tab.id);
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    const detail = String(error?.message || error);
    showMessage(`Could not connect to the Canvas page. Reload the tab once. ${detail}`);
    return { ok: false, message: detail };
  }
}

async function scanAllFrames(options = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://canvas.skku.edu/")) return null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanFrameForTodos,
      args: [{
        searchQuery: els.searchInput.value.trim(),
        includeCompleted: els.includeCompleted.checked,
        includeRawText: Boolean(options.includeRawText),
        videoOnly: options.videoOnly !== false
      }]
    });

    const diagnostics = results.map((entry) => ({
      frameId: entry.frameId,
      ...entry.result
    }));
    const best = diagnostics
      .filter((frame) => Array.isArray(frame.items))
      .sort((a, b) => b.items.length - a.items.length || b.todoScore - a.todoScore)[0];

    return {
      items: best?.items || [],
      diagnostics,
      sourceFrameId: best?.frameId ?? -1
    };
  } catch (error) {
    showMessage(`all-frame scan failed: ${String(error?.message || error)}`);
    return null;
  }
}

async function openItemInFrame(frameId, item) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;

  if (item?.url) {
    await chrome.tabs.update(tab.id, { url: item.url });
    return true;
  }

  if (!Number.isInteger(frameId) || frameId < 0) {
    return false;
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      func: clickTodoItem,
      args: [item]
    });
    return Boolean(result?.result?.ok);
  } catch (error) {
    showMessage(`open failed: ${String(error?.message || error)}`);
    return false;
  }
}

function scanFrameForTodos(options) {
  const searchQuery = normalize(options.searchQuery || "");
  const includeCompleted = Boolean(options.includeCompleted);
  const videoOnly = Boolean(options.videoOnly);
  const text = document.body?.innerText || "";
  const rows = collectRowsFromDom();
  const textRows = collectRowsFromText(text);
  const courseVideoCounts = parseCourseVideoCounts(text);
  const sourceRows = textRows.length ? mergeTextRowsWithDomUrls(textRows, rows) : rows;
  let items = dedupeItems(sourceRows)
    .filter((item) => {
      const haystack = normalize(`${item.title} ${item.course || ""} ${item.rawText || ""} ${item.url || ""}`);
      if (searchQuery && !haystack.includes(searchQuery)) return false;
      if (!includeCompleted && looksDone(haystack)) return false;
      return true;
    })
    .slice(0, 100);

  if (videoOnly) {
    items = filterVideoItems(items, courseVideoCounts);
  }

  const iframes = [...document.querySelectorAll("iframe")].map((frame) => ({
    src: frame.src || "",
    title: frame.title || "",
    id: frame.id || "",
    className: String(frame.className || "")
  })).slice(0, 20);

  const lowerText = normalize(text);
  return {
    url: location.href,
    title: document.title,
    todoScore: scoreText(lowerText),
    textLength: text.length,
    hasTodoHeader: lowerText.includes("유형") && lowerText.includes("제목") && lowerText.includes("과목명"),
    rowCount: rows.length,
    textRowCount: textRows.length,
    itemCount: items.length,
    courseVideoCounts,
    items,
    iframes,
    rawTextSample: options.includeRawText ? text.slice(0, 5000) : text.slice(0, 500)
  };

  function collectRowsFromDom() {
    return [...document.querySelectorAll("tr, [role='row']")]
      .map((row) => {
        const cells = [...row.querySelectorAll("td, th, [role='cell'], [role='gridcell'], [role='columnheader']")]
          .map(cellText)
          .filter(Boolean);
        if (cells.length < 2 || isHeader(cells)) return null;
        const rawText = clean(row.innerText || row.textContent || "");
        const url = firstUrl(row);
        return buildItem(cells, rawText, url);
      })
      .filter(Boolean);
  }

  function collectRowsFromText(bodyText) {
    const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const header = lines.findIndex((line) => {
      const value = normalize(line);
      return value.includes("유형") && value.includes("제목") && value.includes("과목명");
    });
    if (header < 0) return [];

    return lines.slice(header + 1)
      .filter((line) => line.includes("\t"))
      .map((line) => {
        const cells = line.split("\t").map(clean).filter(Boolean);
        if (cells.length < 2 || isHeader(cells)) return null;
        return buildItem(cells, line, "");
      })
      .filter(Boolean);
  }

  function mergeTextRowsWithDomUrls(textItems, domItems) {
    return textItems.map((item) => {
      const match = domItems.find((candidate) => sameTodoItem(candidate, item));
      return match?.url ? { ...item, url: match.url } : item;
    });
  }

  function buildItem(cells, rawText, url) {
    const type = detectType(cells, rawText);
    const useful = cells.filter((cell) => !isMeta(cell));
    const title = useful.find((cell) => !isTypeCell(cell)) || useful[0] || cells[0];
    const course = useful.find((cell) => cell !== title && isCourse(cell)) || useful[1] || "";
    if (!title || isControl(title)) return null;
    return {
      title: course && !title.includes(course) ? `${title} - ${course}` : title,
      type,
      course,
      url,
      clickText: title,
      rawText
    };
  }

  function firstUrl(root) {
    for (const anchor of root.querySelectorAll("a[href]")) {
      const label = clean(anchor.innerText || anchor.getAttribute("aria-label") || "");
      if (isControl(label)) continue;
      try {
        const url = new URL(anchor.href, location.href);
        if (url.origin === location.origin) return url.href;
      } catch (_error) {
        continue;
      }
    }
    return "";
  }

  function dedupeItems(values) {
    const seen = new Set();
    const output = [];
    for (const item of values) {
      const key = `${compactRepeatedText(item.clickText || item.title || "")}|${compactRepeatedText(item.course || "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
    }
    return output;
  }

  function isHeader(cells) {
    const value = normalize(cells.join(" "));
    return value.includes("유형") && value.includes("제목") && value.includes("과목명");
  }

  function isMeta(value) {
    const text = normalize(value);
    return text === "유형" || text === "제목" || text === "과목명" || /^d[-+]\d+$/i.test(text) || /^\d{2}\.\d{2}\.\d{2}/.test(text);
  }

  function isTypeCell(value) {
    const text = normalize(value);
    return text.length <= 80 && ["동영상", "영상", "video", "media", "movie", "icon-video"].some((word) => text.includes(normalize(word)));
  }

  function detectType(cells, rawText) {
    const candidate = cells.find(isTypeCell);
    if (candidate) return candidate;
    const raw = normalize(rawText);
    if (raw.includes("동영상")) return "동영상";
    if (raw.includes("영상")) return "영상";
    if (raw.includes("video")) return "video";
    return "";
  }

  function isVideoItem(item) {
    const type = normalize(item.type || "");
    if (type) {
      return ["동영상", "영상", "video", "media", "movie", "icon-video"].some((word) => type.includes(normalize(word)));
    }

    const value = normalize(`${item.title || ""} ${item.rawText || ""}`);
    return ["동영상", "영상", "video", "media", "lecture", "차시"].some((word) => value.includes(normalize(word)));
  }

  function filterVideoItems(values, counts) {
    if (Object.keys(counts).length) {
      const usedByCourse = {};
      return values.filter((item) => {
        const courseKey = findCourseKey(item.course, counts);
        if (!courseKey) return false;

        const used = usedByCourse[courseKey] || 0;
        if (used >= counts[courseKey]) return false;

        usedByCourse[courseKey] = used + 1;
        return true;
      });
    }

    return values.filter(isVideoItem);
  }

  function parseCourseVideoCounts(bodyText) {
    const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const counts = {};

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!isCourse(line)) continue;

      const windowText = lines.slice(index + 1, index + 16);
      const todoIndex = windowText.findIndex((entry) => normalize(entry) === "남은 할 일");
      if (todoIndex < 0) continue;

      const videoLabelIndex = windowText.findIndex((entry, offset) => offset > todoIndex && normalize(entry) === "동영상");
      if (videoLabelIndex < 0) continue;

      const count = Number.parseInt(windowText[videoLabelIndex + 1], 10);
      if (Number.isFinite(count) && count > 0) {
        counts[normalizeCourse(line)] = count;
      }
    }

    return counts;
  }

  function findCourseKey(course, counts) {
    const target = normalizeCourse(course);
    return Object.keys(counts).find((key) => target.includes(key) || key.includes(target));
  }

  function sameTodoItem(left, right) {
    const leftTitle = normalize(compactRepeatedText(left.clickText || left.title || ""));
    const rightTitle = normalize(compactRepeatedText(right.clickText || right.title || ""));
    const leftCourse = normalizeCourse(left.course || "");
    const rightCourse = normalizeCourse(right.course || "");
    return leftTitle.includes(rightTitle) && (!rightCourse || leftCourse.includes(rightCourse));
  }

  function cellText(cell) {
    return clean(unique([
      cell.innerText,
      cell.textContent,
      cell.getAttribute("aria-label"),
      cell.getAttribute("title"),
      cell.querySelector("[aria-label]")?.getAttribute("aria-label"),
      cell.querySelector("[title]")?.getAttribute("title"),
      cell.querySelector("svg title")?.textContent,
      cell.className
    ].filter(Boolean)).join(" "));
  }

  function unique(values) {
    const seen = new Set();
    return values.filter((value) => {
      const key = normalize(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function compactRepeatedText(value) {
    const text = clean(value);
    const half = Math.floor(text.length / 2);
    if (half > 4 && text.length % 2 === 0 && text.slice(0, half).trim() === text.slice(half).trim()) {
      return text.slice(0, half).trim();
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizeCourse(value) {
    return compactRepeatedText(value)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isCourse(value) {
    return /_[A-Z]{2,}\d{3,}/.test(value) || /\(.+\)$/.test(value);
  }

  function isControl(value) {
    return ["닫기", "필터", "보기", "정렬", "마감된 항목", "마감된 항목 숨김", "유형", "과목", "전체"].includes(normalize(value));
  }

  function looksDone(value) {
    return ["completed", "complete", "done", "완료", "시청완료", "출석완료"].some((word) => value.includes(normalize(word)));
  }

  function scoreText(value) {
    let score = 0;
    for (const word of ["할 일", "todo", "마감된 항목", "유형", "제목", "과목명", "동영상"]) {
      if (value.includes(normalize(word))) score += 1;
    }
    return score;
  }

  function clean(value) {
    return String(value).replace(/\s+/g, " ").trim().slice(0, 180);
  }

  function normalize(value) {
    return String(value).replace(/\s+/g, " ").trim().toLowerCase();
  }
}

function clickTodoItem(item) {
  if (item?.url) {
    location.assign(item.url);
    return { ok: true, method: "url" };
  }

  const title = normalize(item?.clickText || item?.title || "");
  const course = normalize(item?.course || "");
  if (!title) return { ok: false, method: "missing-title" };

  const candidates = [...document.querySelectorAll("tr, [role='row'], a[href], button, [role='button'], [role='link'], [tabindex], [onclick], div, span")]
    .filter(isVisible)
    .map((element) => ({ element, text: normalize(element.innerText || element.textContent || element.getAttribute("aria-label") || "") }))
    .filter((entry) => entry.text.includes(title) && (!course || entry.text.includes(course)))
    .sort((a, b) => scoreClickable(b.element) - scoreClickable(a.element));

  const target = candidates[0]?.element;
  if (!target) return { ok: false, method: "not-found" };

  const clickable = target.closest("a[href], button, [role='button'], [role='link'], [tabindex], [onclick]") || target.querySelector?.("a[href], button, [role='button'], [role='link'], [tabindex], [onclick]") || target;
  clickable.click();
  return { ok: true, method: "click" };

  function scoreClickable(element) {
    let score = 0;
    if (element.matches?.("tr, [role='row']")) score += 5;
    if (element.matches?.("a[href], button, [role='button'], [role='link'], [tabindex], [onclick]")) score += 3;
    score -= Math.min(50, (element.innerText || element.textContent || "").length) / 100;
    return score;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function normalize(value) {
    return String(value).replace(/\s+/g, " ").trim().toLowerCase();
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CANVAS_VIDEO_AUTOPLAYER_PING" });
    return;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        globalThis.__canvasSkkuVideoAutoplayerLoaded = false;
      }
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await delay(150);
  }
}

function renderState(state) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  const currentIndex = Number.isInteger(state?.currentIndex) ? state.currentIndex : -1;
  const done = state?.enabled && queue.length ? Math.min(currentIndex + 1, queue.length) : 0;
  reconcileSelection(queue, Boolean(state?.enabled));

  els.runStatus.textContent = state?.statusText || (state?.enabled ? "Running" : "Idle");
  els.progressText.textContent = `${done} / ${queue.length}`;
  const selectedCount = queue.filter((item) => selectedItemKeys.has(itemKey(item))).length;
  els.queueCount.textContent = state?.enabled ? `${queue.length}개` : `${selectedCount} / ${queue.length}개 선택`;
  els.nextButton.disabled = !state?.enabled || queue.length === 0;
  els.stopButton.disabled = !state?.enabled;
  els.selectAllButton.disabled = Boolean(state?.enabled) || queue.length === 0;
  els.clearSelectionButton.disabled = Boolean(state?.enabled) || queue.length === 0;

  els.queueList.replaceChildren();
  for (const [index, item] of queue.entries()) {
    const li = document.createElement("li");
    const key = itemKey(item);
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const text = document.createElement("span");

    checkbox.type = "checkbox";
    checkbox.checked = selectedItemKeys.has(key);
    checkbox.disabled = Boolean(state?.enabled);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedItemKeys.add(key);
      else selectedItemKeys.delete(key);
      renderState(state);
    });

    text.textContent = item.type ? `[${item.type}] ${item.title || item.url}` : item.title || item.url;
    label.append(checkbox, text);
    li.append(label);
    li.title = item.url || item.title || "";
    if (index < currentIndex) li.className = "done";
    if (index === currentIndex) li.className = "current";
    els.queueList.append(li);
  }
}

function setButtons(isCanvas) {
  els.startButton.disabled = !isCanvas;
  els.searchButton.disabled = !isCanvas;
  els.nextButton.disabled = !isCanvas;
  els.stopButton.disabled = !isCanvas;
}

function showMessage(message) {
  els.message.textContent = message;
}

function itemKey(item) {
  return [
    item?.url || "",
    item?.clickText || item?.title || "",
    item?.course || "",
    item?.type || ""
  ].join("|");
}

function queueSignature(queue) {
  return queue.map(itemKey).join("\n");
}

function reconcileSelection(queue, isRunning) {
  const signature = queueSignature(queue);
  if (!queue.length) {
    selectedItemKeys.clear();
    lastQueueSignature = "";
    return;
  }

  if (signature !== lastQueueSignature) {
    selectedItemKeys.clear();
    for (const item of queue) selectedItemKeys.add(itemKey(item));
    lastQueueSignature = signature;
    return;
  }

  if (isRunning) {
    selectedItemKeys.clear();
    for (const item of queue) selectedItemKeys.add(itemKey(item));
  }
}

function syncSelectionToQueue(queue) {
  selectedItemKeys.clear();
  for (const item of queue) selectedItemKeys.add(itemKey(item));
  lastQueueSignature = queueSignature(queue);
}

async function selectAllPreviewItems() {
  const stateResult = await chrome.storage.local.get(STATE_KEY);
  const queue = Array.isArray(stateResult[STATE_KEY]?.queue) ? stateResult[STATE_KEY].queue : [];
  syncSelectionToQueue(queue);
  renderState(stateResult[STATE_KEY]);
}

async function clearPreviewSelection() {
  selectedItemKeys.clear();
  const stateResult = await chrome.storage.local.get(STATE_KEY);
  lastQueueSignature = queueSignature(Array.isArray(stateResult[STATE_KEY]?.queue) ? stateResult[STATE_KEY].queue : []);
  renderState(stateResult[STATE_KEY]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
