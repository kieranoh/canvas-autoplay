"use strict";

const DEBUGGER_VERSION = "1.3";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CANVAS_VIDEO_AUTOPLAYER_NAVIGATE_TOP") {
    navigateTopTab(sender.tab?.id, message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));

    return true;
  }

  if (message?.type !== "CANVAS_VIDEO_AUTOPLAYER_TRUSTED_CLICK") return false;

  dispatchTrustedClick(sender, message)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));

  return true;
});

async function navigateTopTab(tabId, url) {
  if (!tabId) throw new Error("No tab id for top navigation.");
  if (!url) {
    await chrome.tabs.reload(tabId);
    return;
  }

  await chrome.tabs.update(tabId, { url });
}

async function dispatchTrustedClick(sender, message) {
  const tabId = sender.tab?.id;
  const point = await getClickPoint(sender, message);

  if (!tabId) throw new Error("No tab id for trusted click.");
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("Invalid click point.");
  }

  const target = { tabId };
  const x = Math.max(0, Math.round(point.x));
  const y = Math.max(0, Math.round(point.y));

  await attachDebugger(target);
  try {
    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      clickCount: 0
    });
    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  } finally {
    await detachDebugger(target);
  }
}

async function getClickPoint(sender, message) {
  const point = {
    x: Number(message.point?.x),
    y: Number(message.point?.y)
  };

  if (message.topAdjusted || !sender.frameId) return point;

  const rect = await getFrameRect(sender.tab?.id, message.frameUrl);
  if (!rect) return point;

  return {
    x: rect.left + point.x,
    y: rect.top + point.y
  };
}

function getFrameRect(tabId, frameUrl) {
  if (!tabId) return Promise.resolve(null);

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: "CANVAS_VIDEO_AUTOPLAYER_GET_FRAME_RECT",
        frameUrl
      },
      { frameId: 0 },
      (response) => {
        const error = chrome.runtime.lastError;
        if (error || !response?.ok || !response.rect) {
          resolve(null);
          return;
        }
        resolve(response.rect);
      }
    );
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error && !String(error.message || "").includes("Another debugger is already attached")) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

function sendDebuggerCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}
