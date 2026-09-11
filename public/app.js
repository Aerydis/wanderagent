const connectionStatusElement =
  document.getElementById("connectionStatus");

const statusMessageElement =
  document.getElementById("statusMessage");

const errorPanelElement =
  document.getElementById("errorPanel");

const feedElement =
  document.getElementById("feed");

const formElement =
  document.getElementById("feedForm");

const keywordElement =
  document.getElementById("keyword");

const fetchAmountElement =
  document.getElementById("fetchAmount");

const sourceElement =
  document.getElementById("source");

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

startConnection();

async function startConnection() {
  try {
    if (!window.DirectLine?.DirectLine) {
      throw new Error(
        "The Direct Line library could not be loaded. Check the internet connection and refresh the page."
      );
    }

    setConnectionStatus("Getting token...", "normal");
    clearError();

    const tokenResponse = await fetch(
      "/api/directline/token"
    );

    const tokenResponseText =
      await tokenResponse.text();

    let tokenData;

    try {
      tokenData = JSON.parse(tokenResponseText);
    } catch {
      throw new Error(
        "The backend token response was not valid JSON."
      );
    }

    if (!tokenResponse.ok) {
      const message =
        tokenData.error ||
        `Token request failed with status ${tokenResponse.status}.`;

      throw new Error(message);
    }

    if (!tokenData.token) {
      throw new Error(
        "The backend did not return a Direct Line token."
      );
    }

    setDebugOutput({
      stage: "temporary_token_received",
      conversationId:
        tokenData.conversationId || null,
      expiresIn: tokenData.expiresIn || null,
      note: "The token is deliberately not displayed."
    });

    setConnectionStatus("Connecting...", "normal");

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
      "Connection failed",
      "error"
    );

    statusMessageElement.textContent =
      "The website could not connect to the API Agent.";

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
          "Starting connection...",
          "normal"
        );
      }

      if (status === 1) {
        setConnectionStatus("Connecting...", "normal");
      }

      if (status === 2) {
        connected = true;

        setConnectionStatus(
          "Connected",
          "connected"
        );

        statusMessageElement.textContent =
          "Enter a topic and create your feed.";
      }

      if (status === 3) {
        connected = false;

        setConnectionStatus(
          "Token expired",
          "error"
        );

        showError(
          "The temporary Direct Line token expired. Refresh the page to create a new connection."
        );
      }

      if (status === 4) {
        connected = false;

        setConnectionStatus(
          "Connection failed",
          "error"
        );

        showError(
          "Direct Line could not connect to the agent. Confirm the secret, web-channel security setting, and published agent."
        );
      }

      if (status === 5) {
        connected = false;

        setConnectionStatus(
          "Connection ended",
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
        "Connection failed",
        "error"
      );

      showError(
        "An error occurred while connecting to Direct Line."
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
            "The API Agent is collecting content"
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
            "The API Agent responded, but its response was not valid JSON. Expand Debug information to inspect the response."
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
        "An error occurred while receiving the API Agent response."
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
        "The website is not connected to the API Agent. Refresh the page and wait for Connected to appear."
      );

      return;
    }

    const keyword =
      keywordElement.value.trim();

    const source =
      sourceElement.value;

    const rawAmount =
      Number(fetchAmountElement.value);

    const fetchAmount = Math.min(
      Math.max(
        Number.isFinite(rawAmount)
          ? Math.floor(rawAmount)
          : 10,
        1
      ),
      50
    );

    if (!keyword) {
      showError("Enter a topic or keyword.");
      return;
    }

    clearError();
    feedElement.replaceChildren();

    waitingForFeedResponse = true;
    requestStartedAt = Date.now();
    requestActivityCount = 0;
    submitButtonElement.disabled = true;
    startRequestProgress();

    statusMessageElement.textContent =
      "Sending the request to the API Agent...";

    const requestObject = {
      action: "collect_feed",
      keyword,
      fetch_amount: fetchAmount,
      source,
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
            "The API Agent is processing the request.";
        },

        error: (error) => {
          console.error(
            "Message send error:",
            error
          );

          finishRequest();

          showError(
            "The request could not be sent to the API Agent."
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

  if (validItems.length === 0) {
    statusMessageElement.textContent =
      "The agent returned no matching content.";
  } else {
    statusMessageElement.textContent =
      `${validItems.length} feed item${
        validItems.length === 1 ? "" : "s"
      } loaded.`;
  }

  if (
    Array.isArray(data.errors) &&
    data.errors.length > 0
  ) {
    const messages = data.errors.map(
      (error) => {
        const source =
          error.source || "unknown source";

        const message =
          error.message || "Unknown error";

        return `${source}: ${message}`;
      }
    );

    showError(
      `Some content sources failed. ${messages.join(
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

function createFeedCard(item) {
  const article =
    document.createElement("article");

  article.className = "card";

  if (
    item.thumbnail_url &&
    isSafeHttpUrl(item.thumbnail_url)
  ) {
    const image =
      document.createElement("img");

    image.className = "card-image";
    image.src = item.thumbnail_url;
    image.alt = "";
    image.loading = "lazy";

    image.addEventListener(
      "error",
      () => image.remove()
    );

    article.appendChild(image);
  }

  const body =
    document.createElement("div");

  body.className = "card-body";

  const topLine =
    document.createElement("div");

  topLine.className = "card-topline";

  const sourceBadge =
    document.createElement("span");

  sourceBadge.className =
    `source-badge source-${item.source}`;

  sourceBadge.textContent =
    getSourceLabel(item.source);

  const date =
    document.createElement("span");

  date.className = "card-date";
  date.textContent =
    formatDate(item.publish_date);

  topLine.append(
    sourceBadge,
    date
  );

  body.appendChild(topLine);

  const title =
    document.createElement("h2");

  title.textContent = item.title;
  body.appendChild(title);

  if (item.creator) {
    const creator =
      document.createElement("p");

    creator.className = "creator";
    creator.textContent = item.creator;

    body.appendChild(creator);
  }

  if (item.description) {
    const description =
      document.createElement("p");

    description.className = "description";
    description.textContent =
      stripHtml(item.description);

    body.appendChild(description);
  }

  const statistics =
    createStatistics(item);

  if (
    statistics.childElementCount > 0
  ) {
    body.appendChild(statistics);
  }

  const links =
    document.createElement("div");

  links.className = "card-links";

  if (
    item.url &&
    isSafeHttpUrl(item.url)
  ) {
    links.appendChild(
      createExternalLink(
        item.url,
        getPrimaryLinkLabel(item.source),
        false
      )
    );
  }

  const discussionUrl =
    item.metadata?.discussion_url;

  if (
    item.source === "hackernews" &&
    discussionUrl &&
    isSafeHttpUrl(discussionUrl)
  ) {
    links.appendChild(
      createExternalLink(
        discussionUrl,
        "Open discussion",
        true
      )
    );
  }

  if (links.childElementCount > 0) {
    body.appendChild(links);
  }

  article.appendChild(body);

  return article;
}

function createStatistics(item) {
  const container =
    document.createElement("div");

  container.className = "statistics";

  const statistics = [];

  if (item.source === "youtube") {
    if (item.metadata?.video_length) {
      statistics.push(
        `Length: ${formatDuration(
          item.metadata.video_length
        )}`
      );
    }

    if (
      isUsableNumber(
        item.metadata?.view_count
      )
    ) {
      statistics.push(
        `${formatNumber(
          item.metadata.view_count
        )} views`
      );
    }
  }

  if (item.source === "hackernews") {
    if (
      isUsableNumber(
        item.metadata?.upvote_count
      )
    ) {
      statistics.push(
        `${formatNumber(
          item.metadata.upvote_count
        )} points`
      );
    }

    if (
      isUsableNumber(
        item.metadata?.comment_count
      )
    ) {
      statistics.push(
        `${formatNumber(
          item.metadata.comment_count
        )} comments`
      );
    }
  }

  if (
    item.source === "cardnews" &&
    isUsableNumber(
      item.metadata?.view_count
    )
  ) {
    statistics.push(
      `${formatNumber(
        item.metadata.view_count
      )} views`
    );
  }

  for (const text of statistics) {
    const statistic =
      document.createElement("span");

    statistic.className = "statistic";
    statistic.textContent = text;

    container.appendChild(statistic);
  }

  return container;
}

function createExternalLink(
  url,
  label,
  secondary
) {
  const link =
    document.createElement("a");

  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;

  link.className = secondary
    ? "card-link secondary"
    : "card-link";

  return link;
}

function getSourceLabel(source) {
  const labels = {
    youtube: "YouTube",
    hackernews: "Hacker News",
    news: "News",
    cardnews: "Card News"
  };

  return labels[source] || source;
}

function getPrimaryLinkLabel(source) {
  const labels = {
    youtube: "Watch video",
    hackernews: "Read article",
    news: "Read original article",
    cardnews: "Open card news"
  };

  return labels[source] || "Open";
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
    "en",
    {
      year: "numeric",
      month: "short",
      day: "numeric"
    }
  ).format(date);
}

function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "";
  }

  return new Intl.NumberFormat(
    "en",
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
  connectionStatusElement.textContent =
    text;

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
      : "No response received yet.";
}

clearDebugButtonElement.addEventListener(
  "click",
  () => {
    debugHistory.length = 0;
    renderDebugHistory();
  }
);

function startRequestProgress() {
  clearInterval(requestProgressTimer);

  requestProgressTimer = setInterval(() => {
    if (!waitingForFeedResponse) {
      return;
    }

    updateRequestProgress(
      "The API Agent is processing the request"
    );
  }, 1000);
}

function updateRequestProgress(message) {
  const elapsed = requestStartedAt
    ? formatElapsedTime(Date.now() - requestStartedAt)
    : "0s";

  statusMessageElement.textContent =
    `${message} (${elapsed}; ${requestActivityCount} activities received).`;
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
    ? `${minutes}m ${seconds}s`
    : `${seconds}s`;
}