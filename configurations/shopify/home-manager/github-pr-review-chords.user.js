// ==UserScript==
// @name         GitHub pull request review chords
// @namespace    https://github.com/DWSR/nix-config
// @version      1.0.2
// @description  Review a pull request from any PR page with r y, r n, or r c.
// @match        https://github.com/*/*/pull/*
// @grant        none
// @run-at       document-end
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const CHORD_TIMEOUT_MS = 1500;
  const DIALOG_ID = "nix-github-pr-review-dialog";
  const ACTIONS = {
    y: {
      event: "approve",
      title: "Approve pull request",
      submitLabel: "Approve",
      bodyLabel: "Review comment (optional)",
      placeholder: "Leave an optional review comment",
      bodyRequired: false,
    },
    n: {
      event: "request changes",
      title: "Request changes",
      submitLabel: "Request changes",
      bodyLabel: "Review comment",
      placeholder: "Describe the changes that are required",
      bodyRequired: true,
    },
    c: {
      event: "comment",
      title: "Comment without a verdict",
      submitLabel: "Comment",
      bodyLabel: "Review comment",
      placeholder: "Leave a review comment",
      bodyRequired: true,
    },
  };

  let chordTimer;
  let activeAction;

  const pullRequestFromPage = () => {
    const match = location.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/,
    );

    if (!match) {
      return null;
    }

    return {
      number: match[3],
      path: `/${match[1]}/${match[2]}/pull/${match[3]}`,
    };
  };

  const resetChord = () => {
    clearTimeout(chordTimer);
    chordTimer = undefined;
  };

  const consumeKey = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const isEditable = (target) =>
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="textbox"]',
      ),
    );

  const headShaFromJson = (root, pullRequest) => {
    const stack = [root];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") {
        continue;
      }

      const number = node.number ?? node.pullRequestNumber;
      const headSha = node.headSha ?? node.headRefOid;
      if (
        String(number) === pullRequest.number &&
        typeof headSha === "string"
      ) {
        return headSha;
      }

      stack.push(...Object.values(node));
    }

    return null;
  };

  const headShaFromDocument = (documentRoot, pullRequest) => {
    for (const script of documentRoot.querySelectorAll(
      'script[type="application/json"]',
    )) {
      try {
        const headSha = headShaFromJson(
          JSON.parse(script.textContent),
          pullRequest,
        );
        if (headSha) {
          return headSha;
        }
      } catch {
        // GitHub has unrelated application/json script tags on PR pages.
      }
    }

    return null;
  };

  const getHeadSha = async (pullRequest) => {
    const currentPageHeadSha = headShaFromDocument(document, pullRequest);
    if (currentPageHeadSha) {
      return currentPageHeadSha;
    }

    const response = await fetch(pullRequest.path, { credentials: "include" });
    if (!response.ok) {
      throw new Error("GitHub's pull request summary is unavailable");
    }

    const summaryDocument = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    const summaryHeadSha = headShaFromDocument(summaryDocument, pullRequest);
    if (!summaryHeadSha) {
      throw new Error("GitHub's pull request head SHA is unavailable");
    }

    return summaryHeadSha;
  };

  const verifiedFetchHeaders = () => {
    const clientVersion = document.querySelector(
      'meta[name="release"]',
    )?.content;
    const fetchNonce = document.querySelector(
      'meta[name="fetch-nonce"]',
    )?.content;

    if (!clientVersion || !fetchNonce) {
      throw new Error("GitHub's verified-fetch metadata is unavailable");
    }

    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "GitHub-Is-React": "true",
      "GitHub-Verified-Fetch": "true",
      "X-Fetch-Nonce": fetchNonce,
      "X-GitHub-Client-Version": clientVersion,
      "X-Requested-With": "XMLHttpRequest",
    };
  };

  const submitReview = async (pullRequest, action, body) => {
    const headSha = await getHeadSha(pullRequest);
    const response = await fetch(
      `${pullRequest.path}/page_data/submit_review`,
      {
        method: "PUT",
        mode: "same-origin",
        credentials: "include",
        headers: verifiedFetchHeaders(),
        body: JSON.stringify({
          body,
          event: action.event,
          headSha,
        }),
      },
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        result.error ?? `GitHub rejected the review (${response.status})`,
      );
    }

    return result;
  };

  const ensureDialog = () => {
    const existing = document.getElementById(DIALOG_ID);
    if (existing) {
      return existing;
    }

    const style = document.createElement("style");
    style.textContent = `
      #${DIALOG_ID} {
        width: min(36rem, calc(100vw - 2rem));
        padding: 0;
        color: var(--fgColor-default, #1f2328);
        background: var(--bgColor-default, #ffffff);
        border: 1px solid var(--borderColor-default, #d0d7de);
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(1, 4, 9, 0.35);
      }
      #${DIALOG_ID}::backdrop { background: rgba(1, 4, 9, 0.55); }
      #${DIALOG_ID} form { padding: 20px; }
      #${DIALOG_ID} h2 { margin: 0 0 16px; font-size: 20px; }
      #${DIALOG_ID} label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
      }
      #${DIALOG_ID} textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 9rem;
        padding: 8px 12px;
        resize: vertical;
        color: inherit;
        background: var(--bgColor-muted, #f6f8fa);
        border: 1px solid var(--borderColor-default, #d0d7de);
        border-radius: 6px;
        font: inherit;
      }
      #${DIALOG_ID} [data-status] {
        min-height: 20px;
        margin: 8px 0;
        color: var(--fgColor-muted, #656d76);
      }
      #${DIALOG_ID} [data-status="error"] {
        color: var(--fgColor-danger, #d1242f);
      }
      #${DIALOG_ID} footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      #${DIALOG_ID} button {
        padding: 6px 12px;
        color: var(--button-default-fgColor-rest, #25292e);
        background: var(--button-default-bgColor-rest, #f6f8fa);
        border: 1px solid var(--button-default-borderColor-rest, #d1d9e0);
        border-radius: 6px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      #${DIALOG_ID} button[type="submit"] {
        color: var(--button-primary-fgColor-rest, #ffffff);
        background: var(--button-primary-bgColor-rest, #1f883d);
        border-color: var(--button-primary-borderColor-rest, #1f883d);
      }
      #${DIALOG_ID} button:disabled { cursor: wait; opacity: 0.6; }
    `;
    document.head.appendChild(style);

    const dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.innerHTML = `
      <form>
        <h2></h2>
        <label for="${DIALOG_ID}-body"></label>
        <textarea id="${DIALOG_ID}-body" rows="7"></textarea>
        <p data-status=""></p>
        <footer>
          <button type="button" data-cancel>Cancel</button>
          <button type="submit" data-submit></button>
        </footer>
      </form>
    `;

    const form = dialog.querySelector("form");
    const textarea = dialog.querySelector("textarea");
    const status = dialog.querySelector("[data-status]");
    const cancelButton = dialog.querySelector("[data-cancel]");
    const submitButton = dialog.querySelector("[data-submit]");

    cancelButton.addEventListener("click", () => dialog.close());
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const pullRequest = pullRequestFromPage();
      const body = textarea.value.trim();
      if (!pullRequest || !activeAction) {
        dialog.close();
        return;
      }

      if (activeAction.bodyRequired && !body) {
        status.dataset.status = "error";
        status.textContent = "A review comment is required for this action.";
        textarea.focus();
        return;
      }

      textarea.disabled = true;
      cancelButton.disabled = true;
      submitButton.disabled = true;
      status.dataset.status = "busy";
      status.textContent = "Submitting review...";

      try {
        const result = await submitReview(pullRequest, activeAction, body);
        status.dataset.status = "success";
        status.textContent = "Review submitted.";
        dialog.close();
        const redirect = new URL(
          result.redirectUrl ?? pullRequest.path,
          location.origin,
        );
        const target =
          redirect.origin === location.origin ? redirect.href : pullRequest.path;
        location.assign(target);
      } catch (error) {
        status.dataset.status = "error";
        status.textContent =
          error instanceof Error ? error.message : "Review submission failed";
        textarea.disabled = false;
        cancelButton.disabled = false;
        submitButton.disabled = false;
        textarea.focus();
      }
    });

    document.body.appendChild(dialog);
    return dialog;
  };

  const openReviewDialog = (action) => {
    activeAction = action;
    const dialog = ensureDialog();
    const textarea = dialog.querySelector("textarea");
    const status = dialog.querySelector("[data-status]");

    dialog.querySelector("h2").textContent = action.title;
    dialog.querySelector("label").textContent = action.bodyLabel;
    dialog.querySelector("[data-submit]").textContent = action.submitLabel;
    textarea.placeholder = action.placeholder;
    textarea.required = action.bodyRequired;
    textarea.value = "";
    textarea.disabled = false;
    dialog.querySelector("[data-cancel]").disabled = false;
    dialog.querySelector("[data-submit]").disabled = false;
    status.dataset.status = "";
    status.textContent = "Cmd+Enter or Ctrl+Enter submits the review.";

    if (!dialog.open) {
      dialog.showModal();
    }

    if (action.bodyRequired) {
      textarea.focus();
    } else {
      dialog.querySelector("[data-submit]").focus();
    }
  };

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditable(event.target) ||
        !pullRequestFromPage()
      ) {
        resetChord();
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "r") {
        resetChord();
        chordTimer = setTimeout(resetChord, CHORD_TIMEOUT_MS);
        consumeKey(event);
        return;
      }

      if (!chordTimer) {
        return;
      }

      resetChord();
      const action = ACTIONS[key];
      if (!action) {
        return;
      }

      consumeKey(event);
      openReviewDialog(action);
    },
    true,
  );
})();
