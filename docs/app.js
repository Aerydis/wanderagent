const connectionStatusElement =
  document.getElementById("connectionStatus");

const connectionLabelElement =
  connectionStatusElement?.querySelector(".connection-label");

const userModeToggleElement =
  document.getElementById("userModeToggle");

const statusMessageElement =
  document.getElementById("statusMessage");

const errorPanelElement =
  document.getElementById("errorPanel");

const feedElement =
  document.getElementById("feed");

const emptyStateElement =
  document.getElementById("emptyState");

const infoSectionElement =
  document.getElementById("infoSection");

const composerSectionElement =
  document.getElementById("composerSection");

const appShellElement =
  document.querySelector(".app-shell");

const formElement =
  document.getElementById("feedForm");

const promptElement =
  document.getElementById("prompt");

const DEFAULT_FETCH_AMOUNT = 3;
const DEFAULT_SOURCE = "all";
const API_BASE_URL = "https://wanderagent.onrender.com";

const submitButtonElement =
  document.getElementById("submitButton");

const debugOutputElement =
  document.getElementById("debugOutput");

const clearDebugButtonElement =
  document.getElementById("clearDebugButton");

let directLine = null;
let connected = false;
let waitingForFeedResponse = false;
let requestStartedAt = null;
let requestActivityCount = 0;
let requestProgressTimer = null;
const debugHistory = [];
const maximumDebugEntries = 100;
const userModeStorageKey = "wander-user-mode";

initializeUserMode();

startConnection();

function initializeUserMode() {
  const userModeEnabled =
    localStorage.getItem(userModeStorageKey) === "true";

  setUserMode(userModeEnabled);

  userModeToggleElement?.addEventListener(
    "change",
    () => {
      setUserMode(userModeToggleElement.checked);
      localStorage.setItem(
        userModeStorageKey,
        String(userModeToggleElement.checked)
      );
    }
  );
}

function setUserMode(enabled) {
  appShellElement?.classList.toggle(
    "user-mode",
    enabled
  );

  if (userModeToggleElement) {
    userModeToggleElement.checked = enabled;
  }
}

async function startConnection() {
  try {
    if (!window.DirectLine?.DirectLine) {
      throw new Error(
        "Direct Line 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인한 후 페이지를 새로 고침하세요."
      );
    }

    setConnectionStatus("토큰을 가져오는 중...", "normal");
    clearError();

    const tokenResponse = await fetch(
      `${API_BASE_URL}/api/directline/token`
    );

    const tokenResponseText =
      await tokenResponse.text();

    let tokenData;

    try {
      tokenData = JSON.parse(tokenResponseText);
    } catch {
      throw new Error(
        "백엔드 토큰 응답이 올바른 JSON 형식이 아닙니다."
      );
    }

    if (!tokenResponse.ok) {
      const message =
        tokenData.error ||
        `토큰 요청에 실패했습니다. 상태 코드: ${tokenResponse.status}`;

      throw new Error(message);
    }

    if (!tokenData.token) {
      throw new Error(
        "백엔드가 Direct Line 토큰을 반환하지 않았습니다."
      );
    }

    setDebugOutput({
      stage: "temporary_token_received",
      conversationId:
        tokenData.conversationId || null,
      expiresIn: tokenData.expiresIn || null,
      note: "토큰은 보안을 위해 표시하지 않습니다."
    });

    setConnectionStatus("연결하는 중...", "normal");

    directLine = new window.DirectLine.DirectLine({
      token: tokenData.token,
      domain:
        "https://directline.botframework.com/v3/directline",
      webSocket: true
    });

    subscribeToConnectionStatus();
    subscribeToAgentActivities();
  } catch (error) {
    console.error(error);

    connected = false;

    setConnectionStatus(
      "연결 실패",
      "error"
    );

    statusMessageElement.textContent =
      "웹사이트가 상위 에이전트에 연결하지 못했습니다.";

    showError(error.message);
  }
}

function subscribeToConnectionStatus() {
  directLine.connectionStatus$.subscribe({
    next: (status) => {
      console.log(
        "Direct Line connection status:",
        status
      );

      if (status === 0) {
        setConnectionStatus(
          "연결 시작 중...",
          "normal"
        );
      }

      if (status === 1) {
        setConnectionStatus("연결하는 중...", "normal");
      }

      if (status === 2) {
        connected = true;

        setConnectionStatus(
          "연결됨",
          "connected"
        );

        statusMessageElement.textContent =
          "Wander에게 궁금한 것을 알려 주세요.";
      }

      if (status === 3) {
        connected = false;

        setConnectionStatus(
          "토큰 만료",
          "error"
        );

        showError(
          "임시 Direct Line 토큰이 만료되었습니다. 새 연결을 만들려면 페이지를 새로 고침하세요."
        );
      }

      if (status === 4) {
        connected = false;

        setConnectionStatus(
          "연결 실패",
          "error"
        );

        showError(
          "Direct Line이 에이전트에 연결하지 못했습니다. 시크릿, 웹 채널 보안 설정, 게시된 에이전트를 확인하세요."
        );
      }

      if (status === 5) {
        connected = false;

        setConnectionStatus(
          "연결 종료",
          "error"
        );
      }
    },

    error: (error) => {
      console.error(
        "Connection status error:",
        error
      );

      connected = false;

      setConnectionStatus(
        "연결 실패",
        "error"
      );

      showError(
        "Direct Line에 연결하는 동안 오류가 발생했습니다."
      );
    }
  });
}

function subscribeToAgentActivities() {
  directLine.activity$.subscribe({
    next: (activity) => {
      console.log(
        "Direct Line activity:",
        activity
      );

      if (waitingForFeedResponse) {
        requestActivityCount += 1;
      }

      setDebugOutput({
        stage: "agent_activity_received",
        activityCount: requestActivityCount,
        activityType: activity.type,
        elapsed: requestStartedAt
          ? formatElapsedTime(
            Date.now() - requestStartedAt
          )
          : null,
        lastActivityAt: new Date().toISOString(),
        activity
      });

      if (
        activity.from?.role === "user" ||
        activity.from?.id === getOrCreateUserId()
      ) {
        return;
      }

      if (activity.type === "typing") {
        if (waitingForFeedResponse) {
          updateRequestProgress(
            "상위 에이전트가 콘텐츠를 수집하는 중입니다"
          );
        }

        return;
      }

      if (activity.type !== "message") {
        return;
      }

      if (!activity.text) {
        return;
      }

      if (
        waitingForFeedResponse &&
        activity.text.toLowerCase().includes("don't have access to talk to this bot")
      ) {
        finishRequest();
        showError(
          "Copilot Studio가 상위 에이전트 접근을 거부했습니다. DIRECT_LINE_SECRET이 게시된 상위 에이전트의 Direct Line 채널에 해당하는지, 에이전트가 이 채널과 사용자를 허용하는지 확인하세요."
        );
        return;
      }

      setDebugOutput({
        stage: "agent_message_received",
        rawText: activity.text,
        activity
      });

      if (!waitingForFeedResponse) {
        return;
      }

      try {
        const agentOutput =
          parseAgentJson(activity.text);

        renderAgentOutput(agentOutput);

        finishRequest();
      } catch (error) {
        console.warn(
          "Received a bot message that was not valid feed JSON:",
          error
        );

        const appearsToBeFinalJson =
          activity.text.includes('"results"') ||
          activity.text.trim().startsWith("{");

        if (appearsToBeFinalJson) {
          finishRequest();

          showError(
            "상위 에이전트가 응답했지만 올바른 JSON 형식이 아닙니다. 응답을 확인하려면 디버그 정보를 펼치세요."
          );
        }
      }
    },

    error: (error) => {
      console.error(
        "Agent activity error:",
        error
      );

      finishRequest();

      showError(
        "상위 에이전트의 응답을 받는 동안 오류가 발생했습니다."
      );
    }
  });
}

formElement.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();

    if (!connected || !directLine) {
      showError(
        "웹사이트가 상위 에이전트에 연결되지 않았습니다. 페이지를 새로 고침하고 '연결됨'이 표시될 때까지 기다리세요."
      );

      return;
    }

    const message =
      promptElement.value.trim();

    if (!message) {
      showError("Wander에게 궁금한 것을 알려 주세요.");
      return;
    }

    clearError();
    feedElement.replaceChildren();
    appShellElement?.classList.remove("onboarding-state");
    updateEmptyState(false);

    waitingForFeedResponse = true;
    requestStartedAt = Date.now();
    requestActivityCount = 0;
    submitButtonElement.disabled = true;
    startRequestProgress();

    statusMessageElement.textContent =
      "상위 에이전트에 요청을 보내는 중...";

    const requestObject = {
      message,
      fetch_amount: DEFAULT_FETCH_AMOUNT,
      source: DEFAULT_SOURCE,
      output_format: "wander_feed_json"
    };

    const messageText =
      JSON.stringify(requestObject);

    setDebugOutput({
      stage: "sending_agent_request",
      request: requestObject
    });

    directLine
      .postActivity({
        type: "message",
        from: {
          id: getOrCreateUserId(),
          role: "user"
        },
        text: messageText
      })
      .subscribe({
        next: (activityId) => {
          console.log(
            "Message sent:",
            activityId
          );

          statusMessageElement.textContent =
            "상위 에이전트가 요청을 처리하는 중입니다.";
        },

        error: (error) => {
          console.error(
            "Message send error:",
            error
          );

          finishRequest();

          showError(
            "상위 에이전트에 요청을 보내지 못했습니다."
          );
        }
      });
  }
);

function parseAgentJson(rawText) {
  let cleaned = rawText.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (
    firstBrace === -1 ||
    lastBrace === -1 ||
    lastBrace < firstBrace
  ) {
    throw new Error(
      "No JSON object was found."
    );
  }

  cleaned = cleaned.slice(
    firstBrace,
    lastBrace + 1
  );

  const parsed = JSON.parse(cleaned);

  validateAgentOutput(parsed);

  return parsed;
}

function validateAgentOutput(data) {
  if (!data || typeof data !== "object") {
    throw new Error(
      "The agent response is not an object."
    );
  }

  if (!Array.isArray(data.results)) {
    throw new Error(
      'The agent response does not contain a "results" array.'
    );
  }

  if (
    data.errors !== undefined &&
    !Array.isArray(data.errors)
  ) {
    throw new Error(
      'The "errors" field must be an array.'
    );
  }
}

function renderAgentOutput(data) {
  setDebugOutput({
    stage: "valid_agent_json_received",
    data
  });

  const validItems = data.results.filter(
    isValidFeedItem
  );

  feedElement.replaceChildren();

  for (const item of validItems) {
    feedElement.appendChild(
      createFeedCard(item)
    );
  }

  updateEmptyState(validItems.length > 0);

  if (validItems.length === 0) {
    statusMessageElement.textContent =
      "에이전트가 일치하는 콘텐츠를 찾지 못했습니다.";
  } else {
    statusMessageElement.textContent =
      `${validItems.length}개의 피드 항목을 불러왔습니다.`;
  }

  if (
    Array.isArray(data.errors) &&
    data.errors.length > 0
  ) {
    const messages = data.errors.map(
      (error) => {
        const source =
          error.source || "알 수 없는 소스";

        const message =
          error.message || "알 수 없는 오류";

        return `${source}: ${message}`;
      }
    );

    showError(
      `일부 콘텐츠 소스에 문제가 발생했습니다. ${messages.join(
        " "
      )}`
    );
  }
}

function isValidFeedItem(item) {
  const allowedSources = new Set([
    "youtube",
    "hackernews",
    "news",
    "cardnews"
  ]);

  if (!item || typeof item !== "object") {
    return false;
  }

  if (!allowedSources.has(item.source)) {
    return false;
  }

  if (
    typeof item.id !== "string" ||
    !item.id.trim()
  ) {
    return false;
  }

  if (
    typeof item.title !== "string" ||
    !item.title.trim()
  ) {
    return false;
  }

  if (
    item.url &&
    !isSafeHttpUrl(item.url)
  ) {
    return false;
  }

  return true;
}

const ICONS = {
  eye:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/></svg>',
  comment:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  duration:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  upvote:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5l4 6H8l4-6z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  book:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 0-2 2V4z" stroke="currentColor" stroke-width="1.7"/><path d="M7 20h11" stroke="currentColor" stroke-width="1.7"/></svg>',
  share:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M16 8l-8 4 8 4V8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M16 5h3v14h-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
};

function createFeedCard(item) {
  const postLayout = document.createElement("div");
  postLayout.className = "post-layout";

  const article = document.createElement("article");
  article.className = "post";

  const header = document.createElement("div");
  header.className = "post-header";
  header.appendChild(createPostAvatar(item.source));

  const meta = document.createElement("div");
  meta.className = "post-meta";

  const creatorLine = document.createElement("p");
  creatorLine.className = "post-creator";
  creatorLine.textContent =
    item.creator || getSourceLabel(item.source);

  const subLine = document.createElement("p");
  subLine.className = "post-subline";
  subLine.textContent = `${getSourceLabel(item.source)} · ${formatRelativeDate(item.publish_date)}`;

  meta.append(creatorLine, subLine);
  header.appendChild(meta);
  article.appendChild(header);

  if (
    item.thumbnail_url &&
    isSafeHttpUrl(item.thumbnail_url)
  ) {
    const mediaWrap = document.createElement("div");
    mediaWrap.className = "post-media-wrap";

    const image = document.createElement("img");
    image.className = "post-media";
    image.src = item.thumbnail_url;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => mediaWrap.remove());

    mediaWrap.appendChild(image);

    if (item.source === "youtube") {
      const playBadge = document.createElement("span");
      playBadge.className = "post-play-badge";
      playBadge.setAttribute("aria-hidden", "true");
      mediaWrap.appendChild(playBadge);
    }

    article.appendChild(mediaWrap);
  }

  article.appendChild(createPostActions(item, postLayout));

  const caption = document.createElement("div");
  caption.className = "post-caption";

  const title = document.createElement("strong");
  title.className = "post-title";
  title.textContent = item.title;
  caption.appendChild(title);

  if (item.description) {
    const description = document.createElement("p");
    description.className = "post-description";
    description.textContent = stripHtml(item.description);
    caption.appendChild(description);
  }

  article.appendChild(caption);

  const links = createPostLinks(item);
  if (links.childElementCount > 0) {
    article.appendChild(links);
  }

  postLayout.appendChild(article);
  return postLayout;
}

function createPostAvatar(source) {
  const initials = {
    youtube: "Y",
    hackernews: "HN",
    news: "N",
    cardnews: "C"
  };

  const avatar = document.createElement("div");
  avatar.className = `post-avatar source-${source}`;
  avatar.textContent = initials[source] || "?";
  avatar.setAttribute("aria-hidden", "true");

  return avatar;
}

function createPostActions(item, postLayout) {
  const actions = document.createElement("div");
  actions.className = "post-actions";

  for (const stat of getPostStats(item)) {
    const statElement = document.createElement("span");
    statElement.className = "action-stat";
    statElement.innerHTML = `${stat.icon}<span>${stat.label}</span>`;
    actions.appendChild(statElement);
  }

  const explainButton = document.createElement("button");
  explainButton.type = "button";
  explainButton.className = "action-btn explain-btn";
  explainButton.setAttribute("aria-label", "설명 보기");
  explainButton.title = "설명 보기";
  explainButton.innerHTML = ICONS.book;
  explainButton.addEventListener("click", () => {
    openExplanationWorkspace(item, postLayout);
  });
  actions.appendChild(explainButton);

  if (item.url && isSafeHttpUrl(item.url)) {
    const linkButton = document.createElement("a");
    linkButton.className = "action-btn link-btn";
    linkButton.href = item.url;
    linkButton.target = "_blank";
    linkButton.rel = "noopener noreferrer";
    linkButton.setAttribute(
      "aria-label",
      getPrimaryLinkLabel(item.source)
    );
    linkButton.title = getPrimaryLinkLabel(item.source);
    linkButton.innerHTML = ICONS.share;
    actions.appendChild(linkButton);
  }

  return actions;
}

function getPostStats(item) {
  const stats = [];

  if (item.source === "youtube") {
    if (item.metadata?.video_length) {
      stats.push({
        icon: ICONS.duration,
        label: formatDuration(item.metadata.video_length)
      });
    }

    if (isUsableNumber(item.metadata?.view_count)) {
      stats.push({
        icon: ICONS.eye,
        label: `${formatNumber(item.metadata.view_count)}회`
      });
    }
  }

  if (item.source === "hackernews") {
    if (isUsableNumber(item.metadata?.upvote_count)) {
      stats.push({
        icon: ICONS.upvote,
        label: formatNumber(item.metadata.upvote_count)
      });
    }

    if (isUsableNumber(item.metadata?.comment_count)) {
      stats.push({
        icon: ICONS.comment,
        label: formatNumber(item.metadata.comment_count)
      });
    }
  }

  if (
    item.source === "cardnews" &&
    isUsableNumber(item.metadata?.view_count)
  ) {
    stats.push({
      icon: ICONS.eye,
      label: `${formatNumber(item.metadata.view_count)}회`
    });
  }

  return stats;
}

function createPostLinks(item) {
  const links = document.createElement("div");
  links.className = "post-links";

  if (item.url && isSafeHttpUrl(item.url)) {
    links.appendChild(
      createExternalLink(
        item.url,
        getPrimaryLinkLabel(item.source),
        false
      )
    );
  }

  const discussionUrl = item.metadata?.discussion_url;

  if (
    item.source === "hackernews" &&
    discussionUrl &&
    isSafeHttpUrl(discussionUrl)
  ) {
    links.appendChild(
      createExternalLink(
        discussionUrl,
        "토론 열기",
        true
      )
    );
  }

  return links;
}

function openExplanationWorkspace(item, cardLayout) {
  document.querySelector(".explanation-workspace")?.remove();

  const workspace = document.createElement("section");
  workspace.className = "explanation-workspace";
  workspace.addEventListener("click", (event) => {
    if (event.target === workspace) {
      workspace.remove();
    }
  });

  const panel = document.createElement("div");
  panel.className = "explanation-panel";

  const postPanel = document.createElement("div");
  postPanel.className = "explanation-post-panel";
  const post = cardLayout.querySelector(".post").cloneNode(true);
  post.querySelector(".post-actions")?.remove();
  postPanel.appendChild(post);

  const chatPanel = document.createElement("div");
  chatPanel.className = "explanation-chat-panel";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "explanation-close";
  closeButton.textContent = "X";
  closeButton.setAttribute("aria-label", "설명 창 닫기");
  closeButton.title = "설명 창 닫기";
  closeButton.addEventListener("click", () => workspace.remove());

  chatPanel.append(closeButton, createExplanationChat(item));
  panel.append(postPanel, chatPanel);
  workspace.appendChild(panel);
  document.body.appendChild(workspace);
}

function createExplanationChat(item) {
  const sidebar = document.createElement("div");
  sidebar.className = "explanation-chat";
  const explanationLinePromise = createExplanationAgentConnection();

  const heading = document.createElement("div");
  heading.className = "explanation-heading";
  heading.innerHTML = "<span>설명 에이전트</span><small>이 게시물에 대해 질문하세요</small>";

  const messages = document.createElement("div");
  messages.className = "explanation-messages";
  messages.setAttribute("aria-live", "polite");
  appendExplanationMessage(messages, "agent", `"${item.title}"의 내용을 풀어 설명하고, 핵심 아이디어를 명확히 하거나, 다음에 무엇을 살펴볼지 결정하는 데 도움을 드릴 수 있어요.`);

  const form = document.createElement("form");
  form.className = "explanation-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "무엇을 설명해 드릴까요?";
  input.required = true;
  input.maxLength = 500;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "보내기";
  form.append(input, submit);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    appendExplanationMessage(messages, "user", question);
    input.value = "";
    input.disabled = true;
    submit.disabled = true;
    appendExplanationMessage(messages, "agent", "생각하는 중...", "pending");
    try {
      const explanationLine = await explanationLinePromise;
      const answer = await askExplanationAgent(explanationLine, item, question);
      messages.lastElementChild.remove();
      appendExplanationMessage(messages, "agent", answer);
    } catch (error) {
      messages.lastElementChild.remove();
      appendExplanationMessage(messages, "agent", error.message || "설명 에이전트를 사용할 수 없습니다.");
    } finally {
      input.disabled = false;
      submit.disabled = false;
      input.focus();
    }
  });

  sidebar.append(heading, messages, form);
  return sidebar;
}

function appendExplanationMessage(container, role, text, extraClass = "") {
  const message = document.createElement("p");
  message.className = `explanation-message ${role} ${extraClass}`.trim();
  message.textContent = text;
  container.appendChild(message);
  container.scrollTop = container.scrollHeight;
}

async function createExplanationAgentConnection() {
  const tokenResponse = await fetch(
    `${API_BASE_URL}/api/explanation/token`
  );
  const responseText = await tokenResponse.text();
  let tokenData;

  try {
    tokenData = JSON.parse(responseText);
  } catch {
    throw new Error(
      `설명 토큰 엔드포인트가 예상하지 못한 응답을 반환했습니다(${tokenResponse.status}). 백엔드 서버를 다시 시작하세요.`
    );
  }

  if (!tokenResponse.ok || !tokenData.token) {
    throw new Error(
      tokenData.error || "설명 에이전트를 사용할 수 없습니다."
    );
  }

  return new window.DirectLine.DirectLine({
    token: tokenData.token,
    domain: "https://directline.botframework.com/v3/directline",
    webSocket: true
  });
}

async function askExplanationAgent(explanationLine, item, question) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("설명 에이전트의 응답 시간이 너무 오래 걸립니다."));
      }
    }, 45000);

    explanationLine.activity$.subscribe({
      next: (activity) => {
        if (settled || activity.type !== "message" || !activity.text) {
          return;
        }

        if (
          activity.from?.role === "user" ||
          activity.from?.id === getOrCreateUserId()
        ) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolve(activity.text.trim());
      },
      error: () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("설명 에이전트 연결에 실패했습니다."));
        }
      }
    });

    explanationLine.postActivity({
      type: "message",
      from: {
        id: getOrCreateUserId(),
        role: "user"
      },
      text: JSON.stringify({
        message: question,
        context: {
          title: item.title,
          description: stripHtml(item.description || ""),
          source: getSourceLabel(item.source),
          url: item.url || ""
        },
        output_format: "explanation_text"
      })
    }).subscribe({
      error: () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("설명 질문을 보내지 못했습니다."));
        }
      }
    });
  });
}

function createExternalLink(
  url,
  label,
  secondary
) {
  const link = document.createElement("a");

  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  link.className = secondary
    ? "post-link secondary"
    : "post-link";

  return link;
}

function getSourceLabel(source) {
  const labels = {
    youtube: "YouTube",
    hackernews: "Hacker News",
    news: "뉴스",
    cardnews: "카드 뉴스"
  };

  return labels[source] || source;
}

function getPrimaryLinkLabel(source) {
  const labels = {
    youtube: "동영상 보기",
    hackernews: "기사 읽기",
    news: "원문 기사 읽기",
    cardnews: "카드 뉴스 열기"
  };

  return labels[source] || "열기";
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "ko-KR",
    {
      year: "numeric",
      month: "short",
      day: "numeric"
    }
  ).format(date);
}

function formatRelativeDate(value) {
  if (!value) {
    return "방금";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "방금";
  }

  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) {
    return "방금";
  }

  if (diffMins < 60) {
    return `${diffMins}분 전`;
  }

  const diffHours = Math.floor(diffMins / 60);

  if (diffHours < 24) {
    return `${diffHours}시간 전`;
  }

  const diffDays = Math.floor(diffHours / 24);

  if (diffDays < 7) {
    return `${diffDays}일 전`;
  }

  return formatDate(value);
}

function updateEmptyState(hasItems) {
  if (!emptyStateElement) {
    return;
  }

  emptyStateElement.classList.toggle("hidden", hasItems);
}

function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "";
  }

  return new Intl.NumberFormat(
    "ko-KR",
    {
      notation: "compact",
      maximumFractionDigits: 1
    }
  ).format(number);
}

function formatDuration(value) {
  const duration = String(value || "");

  const match = duration.match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
  );

  if (!match) {
    return duration;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(
      2,
      "0"
    )}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function isUsableNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return false;
  }

  return Number.isFinite(Number(value));
}

function stripHtml(value) {
  const temporary =
    document.createElement("div");

  temporary.innerHTML = String(value);

  return temporary.textContent || "";
}

function isSafeHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function getOrCreateUserId() {
  const key = "wander-user-id";

  let userId =
    localStorage.getItem(key);

  if (!userId) {
    userId =
      `wander-user-${crypto.randomUUID()}`;

    localStorage.setItem(
      key,
      userId
    );
  }

  return userId;
}

function setConnectionStatus(
  text,
  state
) {
  connectionStatusElement.title = text;

  if (connectionLabelElement) {
    connectionLabelElement.textContent = text;
  }

  connectionStatusElement.className =
    "connection-status";

  if (state === "connected") {
    connectionStatusElement.classList.add(
      "connected"
    );
  }

  if (state === "error") {
    connectionStatusElement.classList.add(
      "error"
    );
  }
}

function showError(message) {
  errorPanelElement.textContent =
    message;

  errorPanelElement.classList.remove(
    "hidden"
  );
}

function clearError() {
  errorPanelElement.textContent = "";

  errorPanelElement.classList.add(
    "hidden"
  );
}

function setDebugOutput(value) {
  debugHistory.push({
    recordedAt: new Date().toISOString(),
    ...value
  });

  if (debugHistory.length > maximumDebugEntries) {
    debugHistory.splice(
      0,
      debugHistory.length - maximumDebugEntries
    );
  }

  renderDebugHistory();
}

function renderDebugHistory() {
  debugOutputElement.textContent =
    debugHistory.length > 0
      ? debugHistory
        .map((entry, index) => {
          return `--- Debug entry ${index + 1} ---\n${JSON.stringify(
            entry,
            null,
            2
          )}`;
        })
        .join("\n\n")
      : "아직 받은 응답이 없습니다.";
}

clearDebugButtonElement.addEventListener(
  "click",
  (event) => {
    event.preventDefault();
    event.stopPropagation();
    debugHistory.length = 0;
    renderDebugHistory();
  }
);

const bottomNavItems =
  document.querySelectorAll(".bottom-nav-item");

function setActiveNav(navName) {
  bottomNavItems.forEach((item) => {
    item.classList.toggle(
      "active",
      item.dataset.nav === navName
    );
  });
}

bottomNavItems.forEach((item) => {
  item.addEventListener("click", () => {
    const navName = item.dataset.nav;
    setActiveNav(navName);

    if (navName === "home") {
      infoSectionElement?.classList.add("hidden");
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
      return;
    }

    if (navName === "create") {
      infoSectionElement?.classList.add("hidden");
      composerSectionElement?.classList.add("composer-expanded");
      promptElement?.focus();
      composerSectionElement?.scrollIntoView({
        behavior: "smooth",
        block: "nearest"
      });
      return;
    }

    if (navName === "info") {
      infoSectionElement?.classList.toggle("hidden");

      if (
        infoSectionElement &&
        !infoSectionElement.classList.contains("hidden")
      ) {
        infoSectionElement.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }
    }
  });
});

promptElement?.addEventListener("focus", () => {
  composerSectionElement?.classList.add("composer-expanded");
});

promptElement?.addEventListener("blur", () => {
  if (!promptElement.value.trim()) {
    composerSectionElement?.classList.remove("composer-expanded");
  }
});

formElement?.addEventListener("submit", () => {
  composerSectionElement?.classList.remove("composer-expanded");
});

function startRequestProgress() {
  clearInterval(requestProgressTimer);

  requestProgressTimer = setInterval(() => {
    if (!waitingForFeedResponse) {
      return;
    }

    updateRequestProgress(
      "상위 에이전트가 요청을 처리하는 중입니다"
    );
  }, 1000);
}

function updateRequestProgress(message) {
  const elapsed = requestStartedAt
    ? formatElapsedTime(Date.now() - requestStartedAt)
    : "0초";

  statusMessageElement.textContent =
    `${message} (${elapsed}, 활동 ${requestActivityCount}개 수신).`;
}

function finishRequest() {
  waitingForFeedResponse = false;
  submitButtonElement.disabled = false;
  clearInterval(requestProgressTimer);
  requestProgressTimer = null;
}

function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes > 0
    ? `${minutes}분 ${seconds}초`
    : `${seconds}초`;
}