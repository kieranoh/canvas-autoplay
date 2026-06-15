"use strict";

if (!globalThis.__canvasSkkuVideoAutoplayerLoaded) {
globalThis.__canvasSkkuVideoAutoplayerLoaded = true;

const STATE_KEY = "canvasSkkuVideoAutoplayerState";
const OPTIONS_KEY = "canvasSkkuVideoAutoplayerOptions";
const OVERLAY_ID = "canvas-skku-video-autoplayer-overlay";
const SHORT_CLIP_MAX_SECONDS = 6;
const PLAYBACK_RATE = 2;
const HANDLING_ENDED_MEDIA = new WeakSet();
const PLAY_BUTTON_CLICK_ATTEMPTS = new WeakMap();
let EXTENSION_CONTEXT_ALIVE = true;
let LAST_PLAYER_RESOURCE_ERROR = "";

const VIDEO_HINTS = [
  "video",
  "lecture",
  "동영상",
  "영상",
  "강의",
  "차시",
  "media",
  "kaltura",
  "commons",
  "panopto",
  "zoom"
];

if (extensionContextAvailable()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, message: String(error?.message || error) });
    });
    return true;
  });
}

boot();
installResourceErrorLogger();

async function handleMessage(message) {
  if (message?.type === "CANVAS_VIDEO_AUTOPLAYER_PING") {
    return { ok: true };
  }

  if (message?.type === "CANVAS_VIDEO_AUTOPLAYER_START") {
    return startAutoplayer({
      includeCompleted: Boolean(message.includeCompleted),
      searchQuery: normalizeText(message.searchQuery || "")
    });
  }

  if (message?.type === "CANVAS_VIDEO_AUTOPLAYER_SCAN") {
    return scanAutoplayer({
      includeCompleted: Boolean(message.includeCompleted),
      searchQuery: normalizeText(message.searchQuery || "")
    });
  }

  if (message?.type === "CANVAS_VIDEO_AUTOPLAYER_STOP") {
    await stopAutoplayer("정지됨");
    return { ok: true, message: "자동 재생을 정지했습니다." };
  }

  if (message?.type === "CANVAS_VIDEO_AUTOPLAYER_NEXT") {
    await goToNext("수동으로 다음 항목으로 이동합니다.");
    return { ok: true, message: "다음 항목으로 이동합니다." };
  }

  if (message?.type === "CANVAS_VIDEO_AUTOPLAYER_GET_FRAME_RECT") {
    return getFrameRectForUrl(message.frameUrl);
  }

  return { ok: false, message: "알 수 없는 요청입니다." };
}

async function boot() {
  const { [STATE_KEY]: state } = await storageGet(STATE_KEY);
  if (!state?.enabled) return;

  if (isTopFrame()) renderOverlay(state);

  const queue = Array.isArray(state.queue) ? state.queue : [];
  if (!queue.length) return;

  if (!isTopFrame()) {
    await processCurrentPage();
    return;
  }

  const current = queue[state.currentIndex];
  if (!current) {
    await stopAutoplayer("완료됨");
    return;
  }

  if (isAssignmentItem(current) || isAssignmentUrl(location.href)) {
    await goToNext("과제 항목이라 자동으로 건너뜁니다.");
    return;
  }

  const recentlyNavigated = Date.now() - Number(state.navigatedAt || 0) < 120000;
  if (current.url && !sameCanvasPage(location.href, current.url) && !recentlyNavigated) {
    await updateState({
      statusText: "현재 영상으로 다시 이동 중",
      navigatedAt: Date.now()
    });
    setTimeout(() => {
      openQueueItem(current);
    }, 800);
    return;
  }

  await processCurrentPage();
}

async function startAutoplayer(options) {
  await storageSet({ [OPTIONS_KEY]: options });

  const queue = options.searchQuery ? collectTodoPreviewLinks(options) : collectTodoVideoLinks(options);
  if (!queue.length) {
    const state = freshState({
      enabled: false,
      statusText: "영상 할 일 없음",
      queue: [],
      currentIndex: -1
    });
    await storageSet({ [STATE_KEY]: state });
    renderOverlay(state);
    return {
      ok: false,
      message: emptyQueueMessage(options)
    };
  }

  const state = freshState({
    enabled: true,
    statusText: "첫 영상으로 이동 중",
    queue,
    currentIndex: 0,
    navigatedAt: Date.now()
  });
  await storageSet({ [STATE_KEY]: state });
  renderOverlay(state);
  openQueueItem(queue[0]);
  return { ok: true, message: `${queue.length}개 영상 후보를 수집했습니다.` };
}

async function scanAutoplayer(options) {
  await storageSet({ [OPTIONS_KEY]: options });

  const queue = collectTodoPreviewLinks(options);
  const state = freshState({
    enabled: false,
    statusText: queue.length ? "할 일 미리보기 완료" : "할 일 없음",
    queue,
    currentIndex: queue.length ? 0 : -1
  });
  await storageSet({ [STATE_KEY]: state });
  renderOverlay(state);

  return {
    ok: queue.length > 0,
    message: queue.length ? `할 일 ${queue.length}개를 찾았습니다.` : emptyQueueMessage(options)
  };
}

async function processCurrentPage() {
  const state = await getState();
  if (!state?.enabled) return;

  await updateState({ statusText: "플레이어 찾는 중" });
  renderOverlay(await getState());

  await waitForPageSettled(2500);
  await acceptResumePrompt();

  const media = await waitForMediaElement(60000);
  if (!media) {
    await updateState({
      statusText: "플레이어 접근 제한",
      note: "플레이어를 직접 읽을 수 없습니다. 영상 종료 후 다음 버튼을 눌러주세요."
    });
    renderOverlay(await getState());
    return;
  }

  await watchMedia(media);
}

async function watchMedia(media) {
  const state = await getState();
  if (!state?.enabled) return;

  media.controls = true;
  applyPlaybackRate(media);
  media.addEventListener("ended", () => {
    handleMediaEnded(media);
  }, { once: true });

  await updateState({ statusText: "재생 시작 중", note: "" });
  renderOverlay(await getState());

  await acceptResumePrompt();
  await startMediaPlayback(media);

  await delay(1200);
  const playingMedia = findPlayingMediaElement(media);
  if (media.paused && playingMedia) {
    logDebug("watch media switched after start", getMediaSnapshot(media), getMediaSnapshot(playingMedia));
    media = playingMedia;
    media.controls = true;
    applyPlaybackRate(media);
    media.addEventListener("ended", () => {
      handleMediaEnded(media);
    }, { once: true });
  }

  if (media.paused && !media.ended) {
    await resumePausedMedia(media, 3);
  }

  await updateState({
    statusText: media.paused ? "재생 확인 필요" : "재생 중",
    note: media.paused ? "" : `${PLAYBACK_RATE}x 배속 적용 중`
  });
  renderOverlay(await getState());

  monitorMediaProgress(media);
}

function monitorMediaProgress(media) {
  let lastTime = media.currentTime || 0;
  let stagnantTicks = 0;
  let pausedTicks = 0;

  const timer = setInterval(async () => {
    const state = await getState();
    if (!state?.enabled || !document.contains(media)) {
      clearInterval(timer);
      return;
    }

    const playingMedia = findPlayingMediaElement(media);
    if (playingMedia && playingMedia !== media) {
      clearInterval(timer);
      logDebug("switch monitor media", getMediaSnapshot(media), getMediaSnapshot(playingMedia));
      await updateState({
        statusText: "재생 중",
        note: `${PLAYBACK_RATE}x 배속 적용 중`
      });
      renderOverlay(await getState());
      monitorMediaProgress(playingMedia);
      return;
    }

    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    const current = media.currentTime || 0;
    applyPlaybackRate(media);
    updateOverlayProgress(current, duration);
    await acceptResumePrompt();

    if (media.ended || (duration > 1 && current >= duration - 0.35)) {
      clearInterval(timer);
      await handleMediaEnded(media);
      return;
    }

    if (media.paused && !media.ended) {
      const replacement = await waitForPlayingMediaElement(media, 1500);
      if (replacement && replacement !== media) {
        clearInterval(timer);
        logDebug("paused media replaced", getMediaSnapshot(media), getMediaSnapshot(replacement));
        await updateState({
          statusText: "재생 중",
          note: `${PLAYBACK_RATE}x 배속 적용 중`
        });
        renderOverlay(await getState());
        monitorMediaProgress(replacement);
        return;
      }

      pausedTicks += 1;
      if (pausedTicks <= 5) {
        await resumePausedMedia(media, 1);
      }
      if (pausedTicks === 3) {
        await updateState({
          statusText: "자동재생 재시도 중",
          note: "재생이 바로 멈춰서 플레이어 재생 버튼을 다시 확인하고 있습니다."
        });
        renderOverlay(await getState());
      }
    } else {
      pausedTicks = 0;
    }

    if (!media.paused && Math.abs(current - lastTime) < 0.05) {
      stagnantTicks += 1;
    } else {
      stagnantTicks = 0;
    }
    lastTime = current;

    if (stagnantTicks >= 30) {
      await updateState({ statusText: "재생 확인 필요" });
      renderOverlay(await getState());
      stagnantTicks = 0;
    }
  }, 1000);
}

async function startMediaPlayback(media) {
  applyPlaybackRate(media);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await media.play();
      return true;
    } catch (_error) {
      if (!media.paused || media.ended) return true;
      if (!canClickPlayControl(media, attempt)) break;

      registerPlayControlClick(media);
      const clicked = await clickSafePlayControl(media);
      if (!clicked) {
        await updateState({
          statusText: "재생 버튼 탐색 실패",
          note: "플레이어 재생 버튼을 찾지 못했습니다. 페이지를 새로고침한 뒤 다시 시작해보세요."
        });
        renderOverlay(await getState());
        break;
      }
      await delay(900);
      if (!media.paused || media.ended) return true;
    }
  }

  await updateState({
    statusText: "재생 대기",
    note: LAST_PLAYER_RESOURCE_ERROR || "브라우저/플레이어가 자동재생을 막았습니다. 이 영상의 재생 버튼을 한 번 직접 눌러주세요."
  });
  renderOverlay(await getState());
  return false;
}

async function resumePausedMedia(media, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!media.paused || media.ended) return true;

    try {
      await media.play();
      await delay(600);
    } catch (_error) {
      if (canClickPlayControl(media, attempt)) {
        registerPlayControlClick(media);
        await clickSafePlayControl(media);
      }
      await delay(900);
    }
  }

  if (media.paused && !media.ended) {
    await delay(600);
  }

  return !media.paused;
}

function canClickPlayControl(media, attempt) {
  const count = PLAY_BUTTON_CLICK_ATTEMPTS.get(media) || 0;
  return attempt < 3 && count < 3;
}

function registerPlayControlClick(media) {
  const count = PLAY_BUTTON_CLICK_ATTEMPTS.get(media) || 0;
  PLAY_BUTTON_CLICK_ATTEMPTS.set(media, count + 1);
}

async function handleMediaEnded(media) {
  if (HANDLING_ENDED_MEDIA.has(media)) return;
  HANDLING_ENDED_MEDIA.add(media);

  if (isShortClip(media)) {
    await updateState({
      statusText: "짧은 인트로 종료",
      note: "2초짜리 앞 영상을 건너뛰고 본 영상을 기다리는 중입니다."
    });
    renderOverlay(await getState());

    const nextMedia = await waitForNextMainMedia(media, 35000);
    if (nextMedia) {
      HANDLING_ENDED_MEDIA.delete(media);
      await watchMedia(nextMedia);
      return;
    }

    await updateState({
      statusText: "본 영상 대기",
      note: "짧은 영상 다음의 본 영상을 자동으로 찾지 못했습니다. 재생 버튼을 한 번 눌러주세요."
    });
    renderOverlay(await getState());
    return;
  }

  await goToNext("영상 재생 종료");
  setTimeout(() => HANDLING_ENDED_MEDIA.delete(media), 3000);
}

function isShortClip(media) {
  const duration = Number.isFinite(media.duration) ? media.duration : 0;
  return duration > 0 && duration <= SHORT_CLIP_MAX_SECONDS;
}

async function waitForNextMainMedia(previousMedia, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await acceptResumePrompt();

    if (document.contains(previousMedia)) {
      const previousDuration = Number.isFinite(previousMedia.duration) ? previousMedia.duration : 0;
      if (!previousMedia.ended && (previousDuration === 0 || previousDuration > SHORT_CLIP_MAX_SECONDS)) {
        return previousMedia;
      }
    }

    const media = findBestMediaElement((candidate) => {
      if (candidate === previousMedia) return false;
      const duration = Number.isFinite(candidate.duration) ? candidate.duration : 0;
      return duration === 0 || duration > SHORT_CLIP_MAX_SECONDS;
    });

    if (media) return media;
    await delay(1000);
  }

  return null;
}

async function goToNext(reason) {
  const state = await getState();
  if (!state?.enabled) return;

  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.queue.length) {
    await storageSet({
      [STATE_KEY]: {
        ...state,
        enabled: false,
        currentIndex: state.queue.length - 1,
        statusText: "완료됨",
        note: reason || ""
      }
    });
    renderOverlay(await getState());
    return;
  }

  const next = state.queue[nextIndex];
  await storageSet({
    [STATE_KEY]: {
      ...state,
      currentIndex: nextIndex,
      statusText: "다음 영상으로 이동 중",
      note: reason || "",
      navigatedAt: Date.now()
    }
  });
  renderOverlay(await getState());
  setTimeout(() => openQueueItem(next), 900);
}

async function stopAutoplayer(statusText) {
  const state = await getState();
  await storageSet({
    [STATE_KEY]: {
      ...(state || freshState({})),
      enabled: false,
      statusText,
      note: ""
    }
  });
  renderOverlay(await getState());
}

function collectTodoVideoLinks(options) {
  const rowItems = collectTodoRowItems(options, { requireVideoHint: !options.searchQuery });
  if (rowItems.length) return rowItems;

  const textItems = collectTodoTextItems(options, { requireVideoHint: !options.searchQuery });
  if (textItems.length) return textItems;

  const anchors = collectTodoAnchors();
  const seen = new Set();
  const results = [];

  for (const anchor of anchors) {
    const url = new URL(anchor.href, location.href);
    const text = getLinkContextText(anchor);

    if (url.origin !== location.origin) continue;
    if (isAssignmentUrl(url.href)) continue;
    if (isIgnoredLink(anchor, url, text)) continue;
    if (!isLikelyTodoContext(anchor)) continue;

    if (!matchesSearchOrVideoHint(text, url.href, options.searchQuery)) continue;
    if (!options.includeCompleted && looksCompleted(anchor, text)) continue;
    if (seen.has(url.href)) continue;

    seen.add(url.href);
    results.push({
      title: cleanTitle(text) || url.pathname,
      url: url.href
    });
  }

  return results.slice(0, 100);
}

function collectTodoPreviewLinks(options) {
  const rowItems = collectTodoRowItems(options, { requireVideoHint: false });
  if (rowItems.length) return rowItems;

  const textItems = collectTodoTextItems(options, { requireVideoHint: false });
  if (textItems.length) return textItems;

  const anchors = collectTodoAnchors();
  const seen = new Set();
  const results = [];

  for (const anchor of anchors) {
    const url = new URL(anchor.href, location.href);
    const text = getLinkContextText(anchor);

    if (url.origin !== location.origin) continue;
    if (isAssignmentUrl(url.href)) continue;
    if (isIgnoredLink(anchor, url, text)) continue;
    if (options.searchQuery && !normalizeText(`${text} ${url.href}`).includes(options.searchQuery)) continue;
    if (!options.includeCompleted && looksCompleted(anchor, text)) continue;
    if (seen.has(url.href)) continue;

    seen.add(url.href);
    results.push({
      title: cleanTitle(text) || url.pathname,
      url: url.href
    });
  }

  return results.slice(0, 100);
}

function collectTodoTextItems(options, settings) {
  const lines = (document.body.innerText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) => {
    const text = normalizeText(line);
    return text.includes("유형") && text.includes("제목") && text.includes("과목명");
  });
  if (headerIndex < 0) return [];

  const results = [];
  const seen = new Set();

  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.includes("\t")) continue;

    const cells = line.split("\t").map(cleanTitle).filter(Boolean);
    if (cells.length < 2 || isTodoHeaderRow(cells)) continue;

    const item = buildTodoItemFromCells(cells, line, "");
    if (!item) continue;
    if (isAssignmentItem(item)) continue;

    const haystack = normalizeText(`${item.title} ${item.course || ""} ${item.rawText || ""}`);
    if (options.searchQuery && !haystack.includes(options.searchQuery)) continue;
    if (settings.requireVideoHint && !hasVideoHint(haystack, "")) continue;
    if (!options.includeCompleted && looksCompleted(document.body, item.rawText)) continue;

    const key = `${item.clickText}|${item.course || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
  }

  return results.slice(0, 100);
}

function collectTodoRowItems(options, settings) {
  const rows = [...document.querySelectorAll("tr, [role='row']")];
  const seen = new Set();
  const results = [];

  for (const row of rows) {
    if (!isVisibleEnough(row)) continue;

    const item = extractTodoRowItem(row);
    if (!item) continue;
    if (isAssignmentItem(item)) continue;

    const haystack = normalizeText(`${item.title} ${item.course || ""} ${item.rawText || ""} ${item.url || ""}`);
    if (options.searchQuery && !haystack.includes(options.searchQuery)) continue;
    if (settings.requireVideoHint && !hasVideoHint(haystack, item.url || "")) continue;
    if (!options.includeCompleted && looksCompleted(row, item.rawText)) continue;

    const key = item.url || `${item.clickText}|${item.course || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
  }

  return results.slice(0, 100);
}

function extractTodoRowItem(row) {
  const cells = [...row.querySelectorAll("td, th, [role='cell'], [role='gridcell'], [role='columnheader']")]
    .map((cell) => cleanTitle(cell.innerText || cell.textContent || ""))
    .filter(Boolean);

  if (cells.length < 2 || isTodoHeaderRow(cells)) return null;

  const rawText = cleanTitle(row.innerText || row.textContent || "");
  if (!rawText || isControlText(rawText)) return null;

  return buildTodoItemFromCells(cells, rawText, findFirstUsableUrl(row));
}

function buildTodoItemFromCells(cells, rawText, url) {
  const usefulCells = cells.filter((cell) => !isTodoMetaCell(cell));
  const title = usefulCells[0] || cells[0];
  const course = usefulCells.find((cell) => cell !== title && isCourseLikeText(cell)) || usefulCells[1] || "";
  if (!title || isControlText(title)) return null;

  return {
    title: course && !title.includes(course) ? `${title} - ${course}` : title,
    course,
    url,
    clickText: title,
    rawText
  };
}

function isTodoHeaderRow(cells) {
  const text = normalizeText(cells.join(" "));
  return text.includes("유형") && text.includes("제목") && text.includes("과목명");
}

function isTodoMetaCell(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "유형" ||
    normalized === "제목" ||
    normalized === "과목명" ||
    /^d-\d+$/i.test(normalized) ||
    /^d\+\d+$/i.test(normalized) ||
    /^\d{2}\.\d{2}\.\d{2}/.test(normalized)
  );
}

function isCourseLikeText(text) {
  return /_[A-Z]{2,}\d{3,}/.test(text) || /\(.+\)$/.test(text);
}

function isControlText(text) {
  const normalized = normalizeText(text);
  return [
    "닫기",
    "필터",
    "보기",
    "정렬",
    "마감된 항목",
    "마감된 항목 숨김",
    "유형",
    "과목",
    "전체"
  ].includes(normalized);
}

function findFirstUsableUrl(root) {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const url = new URL(anchor.href, location.href);
    const text = getLinkContextText(anchor);
    if (url.origin !== location.origin) continue;
    if (isAssignmentUrl(url.href)) continue;
    if (isIgnoredLink(anchor, url, text)) continue;
    return url.href;
  }
  return "";
}

function collectTodoAnchors() {
  const scopes = findTodoScopes();
  const anchors = scopes.flatMap((scope) => [...scope.querySelectorAll("a[href]")]);

  if (anchors.length) {
    return uniqueAnchors(anchors);
  }

  const contextualAnchors = [...document.querySelectorAll("a[href]")].filter(isLikelyTodoContext);
  if (contextualAnchors.length) {
    return uniqueAnchors(contextualAnchors);
  }

  const main = document.querySelector("main, #content, [role='main']") || document.body;
  return uniqueAnchors([...main.querySelectorAll("a[href]")]);
}

function findTodoScopes() {
  const scopes = new Set();
  const selector = [
    "[id*='todo' i]",
    "[class*='todo' i]",
    "[aria-label*='todo' i]",
    "[data-testid*='todo' i]",
    "[id*='planner' i]",
    "[class*='planner' i]",
    "[data-testid*='planner' i]",
    "[aria-label*='할 일' i]"
  ].join(",");

  for (const element of document.querySelectorAll(selector)) {
    if (element.querySelector("a[href]")) scopes.add(element);
  }

  const headingSelector = "h1,h2,h3,h4,[role='heading'],summary,button,span,div";
  for (const element of document.querySelectorAll(headingSelector)) {
    const text = normalizeText(element.innerText || element.textContent || "");
    if (!text || text.length > 80 || !hasTodoHint(text)) continue;

    const scope = element.closest("section,aside,article,div,main");
    if (scope?.querySelector?.("a[href]")) scopes.add(scope);
  }

  return [...scopes].filter((scope) => isVisibleEnough(scope));
}

function uniqueAnchors(anchors) {
  const seen = new Set();
  const results = [];

  for (const anchor of anchors) {
    const key = anchor.href;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(anchor);
  }

  return results;
}

function isVisibleEnough(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function isAssignmentItem(item) {
  return isAssignmentUrl(item?.url || "");
}

function isAssignmentUrl(url) {
  if (!url) return false;
  try {
    return new URL(url, location.href).pathname.includes("/assignments/");
  } catch (_error) {
    return false;
  }
}

function openQueueItem(item) {
  if (item?.url) {
    navigateTop(item.url);
    return;
  }

  if (!isTopFrame()) {
    updateState({
      statusText: "전체 창 새로고침",
      note: "다음 항목 URL이 없어 iframe 안에서 열지 않고 전체 Canvas 창을 새로고침합니다."
    });
    navigateTop("");
    return;
  }

  const target = findTodoRowByItem(item);
  if (target) {
    target.click();
    return;
  }

  updateState({
    statusText: "항목 열기 실패",
    note: "표 행에 링크가 없어 자동으로 열 수 없습니다. Canvas에서 해당 항목을 직접 열어주세요."
  });
}

async function navigateTop(url) {
  if (extensionContextAvailable()) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CANVAS_VIDEO_AUTOPLAYER_NAVIGATE_TOP",
        url
      });
      if (response?.ok) return;
      logDebug("top navigate via background failed", response?.message || "");
    } catch (error) {
      logDebug("top navigate message failed", String(error?.message || error));
    }
  }

  try {
    if (!url) {
      window.top.location.reload();
      return;
    }
    window.top.location.assign(url);
  } catch (_error) {
    if (url) location.assign(url);
    else location.reload();
  }
}

function isTopFrame() {
  return window.top === window.self;
}

function findTodoRowByItem(item) {
  if (!item?.clickText) return null;

  const title = normalizeText(item.clickText);
  const course = normalizeText(item.course || "");
  for (const row of document.querySelectorAll("tr, [role='row']")) {
    if (!isVisibleEnough(row)) continue;

    const text = normalizeText(row.innerText || row.textContent || "");
    if (!text.includes(title)) continue;
    if (course && !text.includes(course)) continue;

    return row.querySelector("a[href], button, [role='button']") || row;
  }

  const clickableSelector = "a[href], button, [role='button'], [role='link'], [tabindex], [onclick]";
  for (const element of document.querySelectorAll(clickableSelector)) {
    if (!isVisibleEnough(element)) continue;

    const text = normalizeText(element.innerText || element.textContent || element.getAttribute("aria-label") || "");
    if (!text.includes(title)) continue;
    if (course && !text.includes(course)) continue;
    return element;
  }

  return null;
}

function matchesSearchOrVideoHint(text, url, searchQuery) {
  const haystack = normalizeText(`${text} ${url}`);
  if (searchQuery) {
    return haystack.includes(searchQuery);
  }
  return hasVideoHint(text, url);
}

function isIgnoredLink(anchor, url, text) {
  const normalizedText = normalizeText(text);
  const normalizedHref = normalizeText(anchor.getAttribute("href") || "");
  const normalizedClass = normalizeText(anchor.className || "");
  const normalizedId = normalizeText(anchor.id || "");

  if (!normalizedText) return true;
  if (url.hash && !url.pathname.replace(/\/+$/, "")) return true;
  if (normalizedHref === "#content" || normalizedHref === "#main" || normalizedHref === "#skip") return true;
  if (normalizedClass.includes("skip") || normalizedId.includes("skip")) return true;
  if (normalizedText === "콘텐츠로 건너 뛰기" || normalizedText === "콘텐츠로 건너뛰기") return true;
  if (normalizedText === "skip to content" || normalizedText === "skip navigation") return true;
  if (isControlText(normalizedText)) return true;
  if (anchor.closest("[role='navigation'], nav, header, footer")) return true;
  return false;
}

function isLikelyTodoContext(anchor) {
  for (let node = anchor; node && node !== document.body; node = node.parentElement) {
    const label = [
      node.id,
      node.className,
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("data-testid")
    ].join(" ");

    if (hasTodoHint(label)) return true;
    if (node.matches?.("section, aside, nav, main, ul, ol") && hasTodoHint(node.innerText || "")) return true;
  }

  const containers = [
    anchor.closest("li"),
    anchor.closest("tr"),
    anchor.closest("article")
  ].filter(Boolean);

  if (containers.some((el) => hasTodoHint(el.innerText || el.getAttribute("aria-label") || ""))) {
    return true;
  }

  const pageText = [
    document.title,
    location.pathname,
    document.querySelector("h1")?.innerText || ""
  ].join(" ");
  return hasTodoHint(pageText) || isDashboardLikePage();
}

function hasTodoHint(text) {
  const lower = String(text).toLowerCase();
  return lower.includes("todo") || lower.includes("to do") || lower.includes("할 일") || lower.includes("마이") || lower.includes("dashboard");
}

function isDashboardLikePage() {
  const path = location.pathname.replace(/\/+$/, "");
  return path === "" || path === "/" || path.includes("dashboard");
}

function hasVideoHint(text, url) {
  const haystack = normalizeText(`${text} ${url}`);
  return VIDEO_HINTS.some((hint) => haystack.includes(normalizeText(hint)));
}

function looksCompleted(anchor, text) {
  const haystack = `${text} ${anchor.closest("li,tr,article,section,div")?.innerText || ""}`.toLowerCase();
  return [
    "completed",
    "complete",
    "done",
    "제출 완료",
    "완료",
    "시청완료",
    "출석완료"
  ].some((word) => haystack.includes(word));
}

function getLinkContextText(anchor) {
  const parts = [
    anchor.innerText,
    anchor.getAttribute("aria-label"),
    anchor.getAttribute("title"),
    anchor.closest("li,tr,article")?.innerText
  ];
  return parts.filter(Boolean).join(" ");
}

function cleanTitle(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function normalizeText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function emptyQueueMessage(options) {
  if (options.searchQuery) {
    return `"${options.searchQuery}"와 일치하는 할 일을 찾지 못했습니다. 마이 페이지의 할 일 목록이 펼쳐져 있는지 확인해보세요.`;
  }
  return "할 일 목록을 찾지 못했습니다. 마이 페이지에서 할 일 영역이 보이는 상태로 검색해보세요.";
}

async function waitForMediaElement(timeoutMs) {
  const immediate = findBestMediaElement();
  if (immediate) return immediate;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(findBestMediaElement());
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const media = findBestMediaElement();
      if (media) {
        clearTimeout(timeout);
        observer.disconnect();
        resolve(media);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function findBestMediaElement(predicate = () => true) {
  const media = collectMediaElements(document).filter(predicate);
  if (!media.length) return null;

  return media
    .filter((element) => !element.disableRemotePlayback)
    .sort((a, b) => mediaScore(b) - mediaScore(a))[0] || media[0];
}

function findPlayingMediaElement(exclude) {
  const media = collectMediaElements(document).filter((element) => {
    if (element === exclude) return false;
    if (!document.contains(element)) return false;
    if (element.paused || element.ended) return false;
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    return duration === 0 || duration > SHORT_CLIP_MAX_SECONDS || element.currentTime < duration;
  });

  return media.sort((a, b) => mediaScore(b) - mediaScore(a))[0] || null;
}

async function waitForPlayingMediaElement(exclude, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const media = findPlayingMediaElement(exclude);
    if (media) return media;
    await delay(250);
  }
  return null;
}

function collectMediaElements(rootDocument) {
  const media = collectDeepElements(rootDocument, "video, audio");
  for (const element of media) applyPlaybackRate(element);
  for (const iframe of rootDocument.querySelectorAll("iframe")) {
    try {
      if (iframe.contentDocument) {
        media.push(...collectMediaElements(iframe.contentDocument));
      }
    } catch (_error) {
      // Cross-origin players cannot be inspected by a content script.
    }
  }
  return media;
}

function applyPlaybackRate(media) {
  if (!media || typeof media.playbackRate !== "number") return false;

  try {
    media.defaultPlaybackRate = PLAYBACK_RATE;
    media.playbackRate = PLAYBACK_RATE;
    media.preservesPitch = true;
    media.mozPreservesPitch = true;
    media.webkitPreservesPitch = true;
    return Math.abs(media.playbackRate - PLAYBACK_RATE) < 0.01;
  } catch (_error) {
    return false;
  }
}

function mediaScore(element) {
  const rect = element.getBoundingClientRect();
  const area = Math.max(0, rect.width) * Math.max(0, rect.height);
  const duration = Number.isFinite(element.duration) ? element.duration : 0;
  return area + duration * 10 + (element.tagName === "VIDEO" ? 1000 : 0);
}

async function tryClickPlayButtons() {
  if (await acceptResumePrompt()) return true;
  return clickSafePlayControl();
}

async function clickSafePlayControl(media) {
  await revealPlayerControls(media);

  const targets = uniqueElements([
    media,
    ...findPlayCandidates(media)
  ].filter(Boolean));

  for (const target of targets) {
    if (!isVisible(target)) continue;

    const before = getMediaSnapshot(media);
    logDebug("click target", describeElement(target), before);

    activateElement(target);
    await delay(900);

    const after = getMediaSnapshot(media);
    logDebug("click result", "dom", after);

    if (!media || hasMediaStarted(before, after)) return true;

    const trustedClicked = await trustedClickElement(target);
    await delay(900);

    const afterTrusted = getMediaSnapshot(media);
    logDebug("click result", trustedClicked ? "trusted" : "trusted-failed", afterTrusted);

    if (!media || hasMediaStarted(before, afterTrusted)) return true;
  }

  if (media && isVisible(media)) {
    const points = getMediaFallbackClickPoints(media);
    for (const point of points) {
      const before = getMediaSnapshot(media);
      logDebug("click point target", point, before);
      const clicked = await trustedClickPoint(point, "media fallback");
      await delay(900);
      const after = getMediaSnapshot(media);
      logDebug("click point result", clicked ? "trusted" : "failed", after);
      if (hasMediaStarted(before, after)) return true;
    }
  }

  return false;
}

function getMediaSnapshot(media) {
  if (!media) return null;
  return {
    paused: Boolean(media.paused),
    ended: Boolean(media.ended),
    currentTime: Number(media.currentTime || 0),
    duration: Number.isFinite(media.duration) ? Number(media.duration) : 0,
    readyState: Number(media.readyState || 0),
    playbackRate: Number(media.playbackRate || 0)
  };
}

function hasMediaStarted(before, after) {
  if (!after) return true;
  if (!after.paused && !after.ended) return true;
  if (before && after.currentTime > before.currentTime + 0.2) return true;
  return false;
}

async function acceptResumePrompt() {
  const candidates = findResumeCandidates();
  for (const element of candidates) {
    if (!isVisible(element)) continue;
    logDebug("resume candidate", describeElement(element));
    activateElement(element);
    await delay(250);
    if (isPromptDismissed(element)) {
      await updateState({ statusText: "이어보기 선택", note: "이전 시청 위치에서 이어보기를 선택했습니다." });
      renderOverlay(await getState());
      await delay(350);
      return true;
    }

    await trustedClickElement(element);
    await updateState({ statusText: "이어보기 선택", note: "이전 시청 위치에서 이어보기를 선택했습니다." });
    renderOverlay(await getState());
    await delay(600);
    return true;
  }
  return false;
}

function findResumeCandidates() {
  const dialogSelectors = [
    "[role='dialog']",
    "[aria-modal='true']",
    ".modal",
    ".modal-dialog",
    ".MuiDialog-root",
    ".ant-modal",
    ".swal2-popup",
    ".bootbox",
    ".v-dialog",
    ".el-dialog",
    "[class*='popup' i]",
    "[class*='dialog' i]",
    "[class*='confirm' i]",
    "[class*='resume' i]",
    "[class*='continue' i]",
    "[class*='bookmark' i]",
    "[class*='last' i]",
    "[style*='z-index']"
  ];
  const dialogs = dialogSelectors.flatMap((selector) => collectDeepElements(document, selector));
  const playerScopes = collectDeepElements(document, ".vc-player, .vc-container, .uni-player, .vjs, .video-js");
  const scopes = uniqueElements([...dialogs, ...playerScopes, document.body]).filter(isVisible);
  const positiveWords = [
    "이어보기",
    "이어 보기",
    "이어서",
    "계속",
    "계속하기",
    "계속 학습",
    "이어 학습",
    "예",
    "네",
    "확인",
    "resume",
    "continue",
    "yes",
    "ok"
  ];
  const promptWords = [
    "이어",
    "시청",
    "재생",
    "이전",
    "마지막",
    "학습",
    "위치",
    "resume",
    "continue",
    "where you left",
    "last position"
  ];
  const negativeWords = ["아니", "취소", "처음", "처음부터", "닫기", "cancel", "no", "close", "restart", "start over"];
  const candidates = [];

  for (const scope of scopes) {
    const scopeText = normalizeText(scope.innerText || scope.textContent || "");
    const looksLikeResumePrompt = promptWords.some((word) => scopeText.includes(normalizeText(word)));
    if (!looksLikeResumePrompt) continue;

    const buttons = collectDeepElements(scope, [
      "button",
      "[role='button']",
      "a",
      "input[type='button']",
      "input[type='submit']",
      ".btn",
      "[onclick]",
      "[tabindex]"
    ].join(","));
    for (const button of buttons) {
      if (!isVisible(button)) continue;
      const text = normalizeText([
        button.innerText,
        button.textContent,
        button.value,
        button.getAttribute?.("aria-label"),
        button.getAttribute?.("title"),
        button.className
      ].filter(Boolean).join(" "));

      if (!text) continue;
      if (negativeWords.some((word) => text.includes(normalizeText(word)))) continue;
      if (positiveWords.some((word) => text.includes(normalizeText(word)))) {
        candidates.push(button);
      }
    }
  }

  return uniqueElements(candidates).sort((a, b) => elementScore(b) - elementScore(a));
}

function isPromptDismissed(element) {
  const scope = element.closest("[role='dialog'], [aria-modal='true'], .modal, .modal-dialog, .swal2-popup, .bootbox, [class*='popup' i], [class*='dialog' i], [class*='confirm' i]");
  return Boolean(scope && !isVisible(scope));
}

async function waitAndClickPlayButton(timeoutMs) {
  await delay(Math.min(timeoutMs, 1000));
  return false;
}

function findPlayCandidates(media) {
  const selectors = [
    "button[aria-label*='Play' i]",
    "button[title*='Play' i]",
    "button[aria-label*='Start' i]",
    "button[title*='Start' i]",
    "button[aria-label*='재생' i]",
    "button[title*='재생' i]",
    "button[aria-label*='시작' i]",
    "button[title*='시작' i]",
    "button[class*='play' i]",
    "[class*='play-button' i]",
    "[class*='play_btn' i]",
    "[class*='btn-play' i]",
    ".vjs-big-play-button",
    ".vjs-play-control",
    ".plyr__control[data-plyr='play']",
    ".mejs__play button",
    ".jw-icon-playback",
    ".jw-display-icon-container",
    ".fp-play",
    ".kWidgetPlayBtn",
    ".playkit-center-playback-control",
    ".playkit-playback-controls button",
    ".vc-pctrl-play-pause-btn",
    "[role='button'][aria-label*='Play' i]",
    "[role='button'][aria-label*='재생' i]",
    "[role='button'][title*='Play' i]",
    "[role='button'][title*='재생' i]",
    "input[type='button'][aria-label*='Play' i]",
    "input[type='button'][title*='Play' i]"
  ];

  return uniqueElements(selectors.flatMap((selector) => collectDeepElements(document, selector)))
    .filter((element) => {
      if (!element.matches?.("button, [role='button'], input[type='button'], .vjs-big-play-button, .vjs-play-control, .jw-icon-playback, .fp-play, .kWidgetPlayBtn, .playkit-center-playback-control, .vc-pctrl-play-pause-btn")) {
        return false;
      }

      const text = normalizeText([
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.className
      ].filter(Boolean).join(" "));
      if (isVcPlayPauseButton(element)) {
        const labelText = normalizeText([
          element.innerText,
          element.textContent,
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title")
        ].filter(Boolean).join(" "));
        if (media?.paused) {
          return !labelText.includes("download") && !labelText.includes("다운로드") && !labelText.includes("새 창");
        }
        return !element.classList.contains("vc-pctrl-on-playing") &&
          !labelText.includes("pause") &&
          !labelText.includes("일시") &&
          !labelText.includes("정지");
      }
      if (text.includes("pause") || text.includes("일시") || text.includes("정지")) return false;
      if (text.includes("download") || text.includes("다운로드") || text.includes("새 창")) return false;
      return text.includes("play") || text.includes("재생") || text.includes("start") || text.includes("시작");
    })
    .sort((a, b) => elementScore(b) - elementScore(a));
}

async function revealPlayerControls(media) {
  const targets = uniqueElements([
    media,
    media?.closest?.(".vc-player, .vc-container, .uni-player, .video-js, .vjs, .jwplayer, .plyr, .kWidgetIframeContainer"),
    ...collectDeepElements(document, ".vc-player, .vc-container, .uni-player, .video-js, .vjs, .jwplayer, .plyr, .kWidgetIframeContainer")
  ].filter(Boolean));

  for (const target of targets) {
    if (!isVisible(target)) continue;
    hoverElement(target);
  }

  await delay(250);
}

function isVcPlayPauseButton(element) {
  return element.classList?.contains("vc-pctrl-play-pause-btn");
}

function collectDeepElements(root, selector) {
  const results = [];
  const visit = (node) => {
    if (!node) return;

    if (node.querySelectorAll) {
      results.push(...node.querySelectorAll(selector));
      for (const child of node.querySelectorAll("*")) {
        if (child.shadowRoot) visit(child.shadowRoot);
      }
    }
  };

  visit(root);
  return results;
}

function uniqueElements(elements) {
  const seen = new Set();
  const output = [];
  for (const element of elements) {
    if (!element || seen.has(element)) continue;
    seen.add(element);
    output.push(element);
  }
  return output;
}

function hoverElement(element) {
  element.scrollIntoView?.({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y
  };

  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
    const EventCtor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    element.dispatchEvent(new EventCtor(type, eventInit));
  }
}

async function trustedClickElement(element) {
  if (!extensionContextAvailable()) return false;

  const point = getTopViewportPoint(element);
  if (!point) return false;

  return trustedClickPoint(point, describeElement(element));
}

async function trustedClickPoint(point, label) {
  if (!extensionContextAvailable()) return false;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CANVAS_VIDEO_AUTOPLAYER_TRUSTED_CLICK",
      point,
      frameUrl: location.href,
      topAdjusted: Boolean(point.topAdjusted)
    });
    logDebug("trusted click", response?.ok ? "ok" : "failed", label, point, response?.message || "");
    return Boolean(response?.ok);
  } catch (_error) {
    logDebug("trusted click error", String(_error?.message || _error));
    return false;
  }
}

function getTopViewportPoint(element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  return convertLocalViewportPointToTop({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  });
}

function convertLocalViewportPointToTop(point) {
  let x = point.x;
  let y = point.y;
  let currentWindow = window;

  try {
    while (currentWindow !== currentWindow.top) {
      const frame = currentWindow.frameElement;
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.left;
      y += frameRect.top;
      currentWindow = currentWindow.parent;
    }
  } catch (_error) {
    return { x, y, topAdjusted: false };
  }

  return { x, y, topAdjusted: currentWindow === currentWindow.top };
}

function getMediaFallbackClickPoints(media) {
  const rect = media.getBoundingClientRect();
  if (!rect.width || !rect.height) return [];

  const rawPoints = [
    { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, name: "center" },
    { x: rect.left + Math.min(56, rect.width * 0.12), y: rect.top + rect.height - Math.min(34, rect.height * 0.18), name: "bottom-left-control" },
    { x: rect.left + rect.width / 2, y: rect.top + rect.height - Math.min(34, rect.height * 0.18), name: "bottom-center-control" }
  ];

  return rawPoints.map((point) => ({
    ...convertLocalViewportPointToTop(point),
    name: point.name
  }));
}

function getFrameRectForUrl(frameUrl) {
  if (!isTopFrame()) return { ok: false, message: "Not top frame." };

  const frames = [...document.querySelectorAll("iframe")].filter(isVisible);
  const normalizedTarget = normalizeFrameUrl(frameUrl);
  const exact = frames.find((frame) => normalizeFrameUrl(frame.src) === normalizedTarget);
  const samePath = frames.find((frame) => {
    const source = normalizeFrameUrl(frame.src);
    return source && normalizedTarget && (source.includes(normalizedTarget) || normalizedTarget.includes(source));
  });
  const target = exact || samePath || frames.sort((a, b) => elementScore(b) - elementScore(a))[0];
  if (!target) return { ok: false, message: "Frame not found." };

  const rect = target.getBoundingClientRect();
  return {
    ok: true,
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    },
    frameSrc: target.src || ""
  };
}

function normalizeFrameUrl(value) {
  try {
    const url = new URL(value, location.href);
    url.hash = "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

function logDebug(...args) {
  try {
    const normalized = args.map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch (_error) {
        return String(arg);
      }
    });
    console.info("[SKKU Lecture Runner]", ...normalized);
  } catch (_error) {
    // Console logging should never affect playback.
  }
}

function installResourceErrorLogger() {
  window.addEventListener("error", (event) => {
    const target = event.target;
    const url = target?.src || target?.href || "";
    if (!url || !/uni-player|lcms|media_script|contents/i.test(url)) return;

    LAST_PLAYER_RESOURCE_ERROR = `플레이어 리소스 로드 실패: ${url}`;
    logDebug("player resource error", url);
  }, true);
}

function describeElement(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName,
    id: element.id || "",
    className: String(element.className || ""),
    title: element.getAttribute?.("title") || "",
    ariaLabel: element.getAttribute?.("aria-label") || "",
    text: cleanTitle(element.innerText || element.textContent || ""),
    rect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function activateElement(element) {
  element.scrollIntoView?.({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y
  };

  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const EventCtor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    element.dispatchEvent(new EventCtor(type, eventInit));
  }

  element.click?.();
}

function elementScore(element) {
  const rect = element.getBoundingClientRect();
  const area = Math.max(0, rect.width) * Math.max(0, rect.height);
  const text = normalizeText([
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("title"),
    element.className,
    element.innerText
  ].filter(Boolean).join(" "));
  let score = area;
  if (isVcPlayPauseButton(element)) {
    score += 12000;
    if (element.classList.contains("vc-pctrl-on-playing")) score -= 25000;
    return score;
  }
  if (text.includes("big")) score += 10000;
  if (text.includes("play") || text.includes("재생")) score += 8000;
  if (text.includes("pause") || text.includes("일시")) score -= 20000;
  return score;
}

function waitForPageSettled(ms) {
  if (document.readyState === "complete") return delay(ms);
  return new Promise((resolve) => {
    window.addEventListener("load", () => delay(ms).then(resolve), { once: true });
    setTimeout(resolve, ms + 3000);
  });
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function renderOverlay(state) {
  if (!isTopFrame()) return;

  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="cva-title">SKKU Lecture Runner</div>
      <div class="cva-status"></div>
      <div class="cva-progress"></div>
      <div class="cva-note"></div>
      <div class="cva-actions">
        <button type="button" data-cva-action="next">다음</button>
        <button type="button" data-cva-action="stop">정지</button>
      </div>
    `;
    document.documentElement.append(overlay);
    injectOverlayStyle();
    overlay.addEventListener("click", (event) => {
      const action = event.target?.getAttribute?.("data-cva-action");
      if (action === "next") goToNext("오버레이에서 다음 클릭");
      if (action === "stop") stopAutoplayer("정지됨");
    });
  }

  const queue = Array.isArray(state?.queue) ? state.queue : [];
  const current = Number.isInteger(state?.currentIndex) ? state.currentIndex + 1 : 0;
  overlay.hidden = !state?.enabled && state?.statusText !== "완료됨";
  overlay.querySelector(".cva-status").textContent = state?.statusText || "대기 중";
  overlay.querySelector(".cva-progress").textContent = `${Math.min(current, queue.length)} / ${queue.length}`;
  overlay.querySelector(".cva-note").textContent = state?.note || "";
}

function updateOverlayProgress(current, duration) {
  if (!isTopFrame()) return;

  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay || !duration) return;

  const progress = overlay.querySelector(".cva-progress");
  const base = progress.textContent.split(" | ")[0];
  progress.textContent = `${base} | ${formatTime(current)} / ${formatTime(duration)}`;
}

function injectOverlayStyle() {
  if (document.getElementById(`${OVERLAY_ID}-style`)) return;

  const style = document.createElement("style");
  style.id = `${OVERLAY_ID}-style`;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      width: 260px;
      padding: 12px;
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      background: #fff;
      color: #1f2933;
      box-shadow: 0 12px 28px rgba(16, 24, 40, 0.22);
      font: 13px/1.4 Arial, "Malgun Gothic", sans-serif;
    }
    #${OVERLAY_ID} .cva-title {
      margin-bottom: 6px;
      font-weight: 700;
      font-size: 13px;
    }
    #${OVERLAY_ID} .cva-status {
      font-weight: 700;
    }
    #${OVERLAY_ID} .cva-progress,
    #${OVERLAY_ID} .cva-note {
      margin-top: 4px;
      color: #667085;
      word-break: keep-all;
    }
    #${OVERLAY_ID} .cva-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }
    #${OVERLAY_ID} button {
      min-height: 30px;
      border: 0;
      border-radius: 6px;
      background: #475467;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    #${OVERLAY_ID} button:last-child {
      background: #b42318;
    }
  `;
  document.documentElement.append(style);
}

async function getState() {
  const result = await storageGet(STATE_KEY);
  return result[STATE_KEY];
}

async function updateState(patch) {
  const state = await getState();
  if (!EXTENSION_CONTEXT_ALIVE) return false;

  return storageSet({
    [STATE_KEY]: {
      ...(state || freshState({})),
      ...patch
    }
  });
}

async function storageGet(keys) {
  if (!extensionContextAvailable()) return {};

  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    handleExtensionContextError(error);
    return {};
  }
}

async function storageSet(values) {
  if (!extensionContextAvailable()) return false;

  try {
    await chrome.storage.local.set(values);
    return true;
  } catch (error) {
    handleExtensionContextError(error);
    return false;
  }
}

function extensionContextAvailable() {
  return Boolean(
    EXTENSION_CONTEXT_ALIVE &&
    globalThis.chrome &&
    chrome.runtime?.id &&
    chrome.storage?.local
  );
}

function handleExtensionContextError(error) {
  const message = String(error?.message || error || "");
  if (
    message.includes("Extension context invalidated") ||
    message.includes("Cannot read properties of undefined") ||
    message.includes("context invalidated")
  ) {
    EXTENSION_CONTEXT_ALIVE = false;
  }
}

function freshState(overrides) {
  return {
    enabled: false,
    statusText: "대기 중",
    note: "",
    queue: [],
    currentIndex: -1,
    startedAt: Date.now(),
    ...overrides
  };
}

function sameCanvasPage(a, b) {
  const urlA = new URL(a, location.href);
  const urlB = new URL(b, location.href);
  urlA.hash = "";
  urlB.hash = "";
  return urlA.href === urlB.href;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

}
