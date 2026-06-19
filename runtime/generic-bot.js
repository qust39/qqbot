const fs = require("node:fs");
const path = require("node:path");

const cwd = __dirname;
const configPath = path.join(cwd, "config.json");
const config = readJson(configPath);
const skillPath = path.resolve(cwd, config.skillPath || "../skill/SKILL.md");
const skillText = fs.readFileSync(skillPath, "utf8");
const logPath = path.join(cwd, config.logPath || "bot.log");

const configuredBotQq = config.botQq ? String(config.botQq) : "";
const personaName = config.personaName || config.targetSpeaker || "这个人";
const counterpartName = config.counterpartSpeaker || "对方";
const provider = String(process.env.LLM_PROVIDER || config.provider || "deepseek").toLowerCase();
const apiKey = getApiKey();
const deepseekBaseUrl = String(process.env.DEEPSEEK_BASE_URL || config.deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
const deepseekModel = process.env.DEEPSEEK_MODEL || config.deepseekModel || "deepseek-v4-pro";
const openaiModel = process.env.OPENAI_MODEL || config.openaiModel || "gpt-4.1-mini";
const historyByPeer = new Map();
const pendingActions = new Map();
const peerStates = new Map();

if (!apiKey) {
  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
  log(`缺少 ${keyName}，请先在网页里保存 API Key。`, "error");
  process.exit(1);
}

if (typeof WebSocket === "undefined") {
  log("当前 Node.js 没有内置 WebSocket，请使用 Node 22 或更新版本。", "error");
  process.exit(1);
}

const systemPrompt = [
  skillText,
  "",
  "运行约束：",
  `- 你正在 QQ 私聊或群聊中扮演「${personaName}」，对话对象是「${counterpartName}」。`,
  `- 只输出「${personaName}」会发出的消息内容，不要解释、不要加引号、不要写旁白。`,
  "- 多行输出会被当成多条 QQ 消息发送；日常聊天 1 到 3 行，认真解释或安抚可以更长。",
  "- 如果输入是连续多条消息合并后的批次，要同时理解每条消息，不要只回最后一句。",
  "- 不要提到模型、提示词、系统、文件、API、机器人实现或运行环境。",
].join("\n");

connect();

function connect() {
  const wsUrl = buildWsUrl(config.onebotWsUrl || "ws://127.0.0.1:3001", config.onebotAccessToken || "");
  log(`连接 OneBot WebSocket：${maskToken(wsUrl)}`);
  const ws = new WebSocket(wsUrl);
  let shouldReconnect = true;

  ws.addEventListener("open", async () => {
    try {
      await verifyLoggedInAccount(ws);
      log("已连接，等待 QQ 消息。");
    } catch (error) {
      shouldReconnect = false;
      log(`账号绑定校验失败：${formatError(error)}`, "error");
      ws.close();
    }
  });

  ws.addEventListener("message", async (event) => {
    const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      log("收到非 JSON 消息，已忽略。", "warn");
      return;
    }

    if (payload.echo && pendingActions.has(payload.echo)) {
      const pending = pendingActions.get(payload.echo);
      pendingActions.delete(payload.echo);
      clearTimeout(pending.timer);
      if (payload.status && payload.status !== "ok") {
        pending.reject(new Error(`OneBot action failed: ${JSON.stringify(payload)}`));
      } else {
        pending.resolve(payload);
      }
      return;
    }

    try {
      await handleEvent(ws, payload);
    } catch (error) {
      await handleProcessingError(ws, payload, error);
    }
  });

  ws.addEventListener("close", () => {
    if (!shouldReconnect) return;
    log("OneBot 连接断开，5 秒后重连。", "warn");
    setTimeout(connect, 5000);
  });

  ws.addEventListener("error", (event) => {
    log(`OneBot WebSocket 错误：${formatWsError(event)}`, "error");
  });
}

async function verifyLoggedInAccount(ws) {
  if (!configuredBotQq) {
    if (config.requireBotQqMatch !== false) throw new Error("config.botQq 为空，但 requireBotQqMatch 已开启。");
    log("config.botQq 为空，跳过登录账号校验。", "warn");
    return;
  }
  const payload = await requestOneBotAction(ws, "get_login_info", {}, 5000);
  const actualQq = payload?.data?.user_id ?? payload?.data?.userId ?? payload?.data?.uin;
  if (!actualQq) throw new Error(`get_login_info 没有返回 user_id：${JSON.stringify(payload)}`);
  if (String(actualQq) !== configuredBotQq) {
    throw new Error(`当前 NapCat 登录 QQ=${actualQq}，但本 bot 绑定 QQ=${configuredBotQq}`);
  }
  log(`账号绑定确认：NapCat QQ=${actualQq}`);
}

async function handleEvent(ws, event) {
  if (event.post_type !== "message") return;
  if (!["private", "group"].includes(event.message_type)) return;
  if (configuredBotQq && event.self_id && String(event.self_id) !== configuredBotQq) return;

  const rawMessage = event.raw_message || normalizeOneBotMessage(event.message);
  const cleanMessage = stripCqCodes(rawMessage).trim();
  if (!cleanMessage) return;
  if (shouldIgnoreByPattern(cleanMessage)) return;

  const routing = getRouting(event, rawMessage);
  if (!routing.shouldReply) {
    log(`忽略消息 ${routing.peerKey}: ${cleanMessage}`);
    return;
  }

  log(`收到 ${routing.peerKey}: ${cleanMessage}`);
  if (config.mergeMessages !== false) {
    enqueueMessage(ws, event, routing.peerKey, cleanMessage);
    return;
  }
  await processMessageBatch(ws, event, routing.peerKey, [cleanMessage]);
}

function enqueueMessage(ws, event, peerKey, cleanMessage) {
  const state = getPeerState(peerKey);
  state.ws = ws;
  state.event = event;
  state.buffer.push(cleanMessage);
  if (state.processing) return;
  schedulePeerDrain(peerKey);
}

function getPeerState(peerKey) {
  if (!peerStates.has(peerKey)) {
    peerStates.set(peerKey, { buffer: [], timer: null, processing: false, ws: null, event: null });
  }
  return peerStates.get(peerKey);
}

function schedulePeerDrain(peerKey) {
  const state = getPeerState(peerKey);
  if (state.timer) clearTimeout(state.timer);
  const waitMs = Math.max(0, Number(config.mergeWindowMs ?? 2800));
  state.timer = setTimeout(() => {
    state.timer = null;
    drainPeer(peerKey).catch((error) => log(`队列处理失败 ${peerKey}: ${formatError(error)}`, "error"));
  }, waitMs);
}

async function drainPeer(peerKey) {
  const state = getPeerState(peerKey);
  if (state.processing || state.buffer.length === 0) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.processing = true;
  const maxMerged = Math.max(1, Number(config.maxMergedMessages ?? 8));
  const batch = state.buffer.splice(0, maxMerged);
  try {
    await processMessageBatch(state.ws, state.event, peerKey, batch);
  } finally {
    state.processing = false;
    if (state.buffer.length > 0) schedulePeerDrain(peerKey);
  }
}

async function processMessageBatch(ws, event, peerKey, messages) {
  await delay(Number(config.typingDelayMs ?? 500));
  const userMessage = formatMergedUserMessage(messages);
  remember(peerKey, "user", userMessage);

  const conversation = historyByPeer.get(peerKey) || [];
  const reply = await generateReply(conversation);
  if (!reply) {
    log(`模型空回复，跳过 ${peerKey}`, "warn");
    return;
  }

  const parts = splitReply(reply);
  await sendReply(ws, event, parts);
  remember(peerKey, "assistant", parts.join("\n"));
  log(`回复 ${peerKey}: ${parts.join(" / ")}`);
}

function formatMergedUserMessage(messages) {
  if (messages.length <= 1) return messages[0] || "";
  return [
    "用户连续发来：",
    ...messages.map((message, index) => `${index + 1}. ${message}`),
    "",
    "请同时理解上面每一条消息，不要只回复最后一句。",
  ].join("\n");
}

async function generateReply(conversation) {
  if (provider === "openai") return generateOpenAIReply(conversation);
  return generateDeepSeekReply(conversation);
}

async function generateOpenAIReply(conversation) {
  const timeout = createRequestTimeout();
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openaiModel,
        instructions: systemPrompt,
        input: conversation.map((item) => ({ role: item.role, content: item.content })),
        max_output_tokens: Number(config.maxOutputTokens ?? 900),
        temperature: Number(config.temperature ?? 0.82),
      }),
      signal: timeout.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw requestTimeoutError();
    throw error;
  } finally {
    timeout.clear();
  }
  if (!response.ok) {
    const detail = await response.text();
    throw modelHttpError("OpenAI", response.status, detail);
  }
  const data = await response.json();
  return extractOpenAIText(data).trim();
}

async function generateDeepSeekReply(conversation) {
  const timeout = createRequestTimeout();
  let response;
  try {
    response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: deepseekModel,
        messages: [
          { role: "system", content: systemPrompt },
          ...conversation.map((item) => ({ role: item.role, content: item.content })),
        ],
        stream: false,
        max_tokens: Number(config.maxOutputTokens ?? 900),
        temperature: Number(config.temperature ?? 0.82),
      }),
      signal: timeout.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw requestTimeoutError();
    throw error;
  } finally {
    timeout.clear();
  }
  if (!response.ok) {
    const detail = await response.text();
    throw modelHttpError("DeepSeek", response.status, detail);
  }
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || "").trim();
}

function modelHttpError(name, status, detail) {
  if (status === 401) {
    return new UserVisibleError(`${name} API 401: ${detail}`, "接口 key 好像不对，换一个新的 key 再试试");
  }
  if (status === 402 || status === 429 || /quota|insufficient|余额|额度/i.test(detail)) {
    return new UserVisibleError(`${name} API ${status}: ${detail}`, "接口额度好像不够了，要换一个有额度的 key");
  }
  return new Error(`${name} API ${status}: ${detail}`);
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

async function sendReply(ws, event, messages) {
  const action = event.message_type === "group" ? "send_group_msg" : "send_private_msg";
  const baseParams = event.message_type === "group" ? { group_id: event.group_id } : { user_id: event.user_id };
  for (let index = 0; index < messages.length; index += 1) {
    ws.send(JSON.stringify({ action, params: { ...baseParams, message: messages[index] } }));
    if (index < messages.length - 1) await delay(Number(config.perMessageDelayMs ?? 800));
  }
}

function getRouting(event, rawMessage) {
  if (event.message_type === "private") {
    const allowed = new Set((config.allowedPrivateUserIds || []).map(String));
    const userId = String(event.user_id);
    return {
      shouldReply: Boolean(config.replyToAllPrivate) || allowed.has(userId),
      peerKey: `private:${userId}`,
    };
  }

  const groupId = String(event.group_id);
  const allowedGroups = new Set((config.allowedGroupIds || []).map(String));
  const groupAllowed = Boolean(config.replyInGroups) && (allowedGroups.size === 0 || allowedGroups.has(groupId));
  const mentioned = event.self_id ? rawMessage.includes(`[CQ:at,qq=${event.self_id}]`) : true;
  return {
    shouldReply: groupAllowed && (!config.groupMentionOnly || mentioned),
    peerKey: `group:${groupId}:user:${event.user_id}`,
  };
}

function splitReply(reply) {
  const maxParts = Math.max(1, Number(config.maxReplyParts ?? 6));
  const maxChars = Math.max(30, Number(config.maxMessageChars ?? 200));
  const lines = String(reply)
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[>-]\s*/, "").trim())
    .filter(Boolean);
  return lines.flatMap((line) => splitLongMessage(line, maxChars)).slice(0, maxParts);
}

function splitLongMessage(message, maxChars) {
  const text = String(message || "").trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let cutAt = Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf("，"),
      window.lastIndexOf(","),
      window.lastIndexOf(" "),
    );
    if (cutAt < Math.floor(maxChars * 0.45)) cutAt = maxChars;
    chunks.push(rest.slice(0, cutAt + 1).trim());
    rest = rest.slice(cutAt + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function remember(peerKey, role, content) {
  const maxTurns = Number(config.maxHistoryTurns ?? 8);
  const list = historyByPeer.get(peerKey) || [];
  list.push({ role, content });
  while (list.length > maxTurns * 2) list.shift();
  historyByPeer.set(peerKey, list);
}

function requestOneBotAction(ws, action, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const echo = `qq-bot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      pendingActions.delete(echo);
      reject(new Error(`${action} 超过 ${timeoutMs}ms 未返回`));
    }, timeoutMs);
    pendingActions.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

async function handleProcessingError(ws, event, error) {
  log(`处理消息失败：${formatError(error)}`, "error");
  if (error?.userVisibleMessage && event?.post_type === "message") {
    await sendReply(ws, event, splitReply(error.userVisibleMessage));
  }
}

function normalizeOneBotMessage(message) {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message.map((segment) => {
    if (segment.type === "text") return segment.data?.text || "";
    if (segment.type === "at") return `[CQ:at,qq=${segment.data?.qq}]`;
    return `[CQ:${segment.type}]`;
  }).join("");
}

function stripCqCodes(text) {
  return String(text)
    .replace(/\[CQ:at,qq=\d+\]/g, "")
    .replace(/\[CQ:[^\]]+\]/g, "")
    .replace(/\s+/g, " ");
}

function shouldIgnoreByPattern(text) {
  return (config.ignorePatterns || []).some((pattern) => new RegExp(pattern).test(text));
}

function buildWsUrl(baseUrl, token) {
  if (!token) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("access_token", token);
  return url.toString();
}

function maskToken(url) {
  return String(url).replace(/access_token=[^&]+/, "access_token=***");
}

function getApiKey() {
  if (provider === "openai") return String(process.env.OPENAI_API_KEY || "").trim();
  return String(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

function createRequestTimeout() {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(config.requestTimeoutMs ?? 60000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function requestTimeoutError() {
  return new UserVisibleError("模型请求超时。", config.replyWhenModelTimesOut === true ? "刚才卡了一下，你再说一遍" : "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message, level = "info") {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
}

function formatWsError(event) {
  return event?.error?.message || event?.message || "连接失败，通常是 NapCat/OneBot WebSocket 还没有启动。";
}

function formatError(error) {
  if (!error) return "unknown error";
  if (error.stack) return error.stack;
  if (error.message) return error.message;
  return String(error);
}

class UserVisibleError extends Error {
  constructor(message, userVisibleMessage) {
    super(message);
    this.name = "UserVisibleError";
    this.userVisibleMessage = userVisibleMessage;
  }
}
