const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const appDir = __dirname;
const rootDir = path.resolve(appDir, "..");
const publicDir = path.join(appDir, "public");
const workspaceDir = process.env.BOT_STUDIO_WORKSPACE
  ? path.resolve(process.env.BOT_STUDIO_WORKSPACE)
  : path.join(appDir, "workspace");
const projectsDir = path.join(workspaceDir, "projects");
const projectsPath = path.join(workspaceDir, "projects.json");
const statePath = path.join(workspaceDir, "process-state.json");
const apiSettingsPath = path.join(workspaceDir, "api-settings.local.json");
const runtimeBotPath = path.join(appDir, "runtime", "generic-bot.js");
const port = Number(process.env.BOT_STUDIO_PORT || 8790);
const host = process.env.BOT_STUDIO_HOST || "127.0.0.1";
const adminPassword = String(process.env.BOT_STUDIO_PASSWORD || "");
const sessionSecret = crypto.randomBytes(24).toString("hex");
const sessionToken = adminPassword
  ? crypto.createHash("sha256").update(`${adminPassword}:${sessionSecret}`).digest("hex")
  : "";

const napcatDir = process.env.NAPCAT_DIR
  ? path.resolve(process.env.NAPCAT_DIR)
  : path.join(rootDir, "NapCat-QCE-Windows-x64");
const napcatLauncher = path.join(napcatDir, "launcher-user.bat");
const napcatQrPath = path.join(napcatDir, "cache", "qrcode.png");
const keepAwakeScript = process.env.KEEP_AWAKE_SCRIPT
  ? path.resolve(process.env.KEEP_AWAKE_SCRIPT)
  : path.join(rootDir, "bot-control", "enable-screen-off-keep-running.ps1");

const runtimeEnv = { ...process.env };

fs.mkdirSync(projectsDir, { recursive: true });
loadApiSettingsIntoRuntime();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/") return sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    if (req.method === "POST" && url.pathname === "/api/login") return sendJson(res, await login(req));
    if (requiresAuth(url.pathname) && !isAuthenticated(req)) {
      return sendJson(res, { ok: false, authRequired: true, error: "需要先输入访问密码。" }, 401);
    }
    if (req.method === "GET" && url.pathname === "/api/status") return sendJson(res, getStatus());
    if (req.method === "GET" && url.pathname === "/api/settings") return sendJson(res, getApiSettings());
    if (req.method === "POST" && url.pathname === "/api/settings") return sendJson(res, await saveApiSettings(req));
    if (req.method === "POST" && url.pathname === "/api/projects/analyze") return sendJson(res, await analyzeProjectRequest(req));
    if (req.method === "POST" && url.pathname === "/api/projects/create") return sendJson(res, await createProjectRequest(req));
    if (req.method === "POST" && url.pathname === "/api/napcat/start") return sendJson(res, startNapCat());
    if (req.method === "POST" && url.pathname === "/api/power/keep-awake") return sendJson(res, runKeepAwake());
    if (req.method === "GET" && url.pathname === "/napcat-qrcode.png") return sendQrcode(res);

    const projectAction = matchProjectAction(url.pathname);
    if (projectAction && req.method === "POST" && projectAction.action === "start") return sendJson(res, await startProject(projectAction.slug));
    if (projectAction && req.method === "POST" && projectAction.action === "stop") return sendJson(res, stopProject(projectAction.slug));
    if (projectAction && req.method === "GET" && projectAction.action === "logs") return sendJson(res, getProjectLogs(projectAction.slug));

    return sendText(res, 404, "Not found");
  } catch (error) {
    return sendJson(res, { ok: false, error: formatError(error) }, 500);
  }
});

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`QQ Bot Studio: http://${displayHost}:${port}`);
});

function getStatus() {
  const projects = readProjects();
  const state = readState();
  const normalizedProjects = projects.map((project) => {
    const pid = state[project.slug]?.pid || null;
    const running = Boolean(pid && isAlive(pid));
    if (!running && state[project.slug]) delete state[project.slug];
    return { ...project, running, pid: running ? pid : null };
  });
  writeState(state);
  return {
    ok: true,
    studio: { host, port, rootDir, workspaceDir, authRequired: Boolean(adminPassword) },
    apiSettings: getApiSettings(),
    apiKey: checkApiKey(),
    onebot: getOneBotStatusQuick(),
    qrcode: getQrcodeStatus(),
    projects: normalizedProjects,
  };
}

async function login(req) {
  if (!adminPassword) return { ok: true, authRequired: false, message: "本机模式不需要访问密码。" };
  const body = await readRequestJson(req);
  const password = String(body.password || "");
  if (password !== adminPassword) return { ok: false, authRequired: true, error: "访问密码不正确。" };
  return {
    ok: true,
    authRequired: true,
    setCookie: `bot_studio_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`,
    message: "已登录。",
  };
}

function requiresAuth(pathname) {
  if (!adminPassword) return false;
  if (pathname === "/api/login") return false;
  return pathname.startsWith("/api/") || pathname === "/napcat-qrcode.png";
}

function isAuthenticated(req) {
  if (!adminPassword) return true;
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies.bot_studio_session === sessionToken;
}

async function analyzeProjectRequest(req) {
  const body = await readRequestJson(req, 80 * 1024 * 1024);
  const chatText = String(body.chatText || "");
  if (chatText.trim().length < 20) return { ok: false, error: "请先选择或粘贴聊天记录 txt。" };
  const records = parseQqChat(chatText);
  if (records.length === 0) return { ok: false, error: "没有解析到 QQChatExporter 消息块。请确认导出的 txt 格式包含“时间:”和“内容:”。" };
  const analysis = analyzeRecords(records, {
    sourceName: body.sourceName || "",
    targetSpeaker: body.targetSpeaker || "",
    counterpartSpeaker: body.counterpartSpeaker || "",
  });
  return { ok: true, analysis };
}

async function createProjectRequest(req) {
  const body = await readRequestJson(req, 80 * 1024 * 1024);
  const chatText = String(body.chatText || "");
  const customProfile = getCustomProfile(body);
  const hasChatText = chatText.trim().length >= 20;
  const hasCustomProfile = customProfile.hasAny;
  if (!hasChatText && !hasCustomProfile) {
    return { ok: false, error: "请导入聊天记录，或者填写自定义性格/关键信息。" };
  }

  const records = hasChatText ? parseQqChat(chatText) : [];
  if (hasChatText && records.length === 0) return { ok: false, error: "没有解析到聊天记录。也可以清空聊天记录，只用自定义信息生成。" };

  const botQq = normalizeQq(body.botQq);
  const allowedPrivateUserIds = normalizeQqList(body.allowedPrivateUserIds);
  if (!botQq) return { ok: false, error: "请填写 bot 登录 QQ 号。" };
  if (allowedPrivateUserIds.length === 0) return { ok: false, error: "请填写至少一个“只回复 QQ”。" };

  const targetSpeaker = String(body.targetSpeaker || "").trim();
  if (!targetSpeaker) return { ok: false, error: "请填写要模拟的聊天昵称。" };

  const analysis = records.length > 0
    ? analyzeRecords(records, {
      sourceName: body.sourceName || "",
      targetSpeaker,
      counterpartSpeaker: body.counterpartSpeaker || "",
    })
    : emptyAnalysis({
      sourceName: body.sourceName || "manual-profile",
      targetSpeaker,
      counterpartSpeaker: body.counterpartSpeaker || "",
    });

  const slug = uniqueSlug(String(body.slug || body.name || targetSpeaker || "bot"), Boolean(body.overwrite));
  const projectDir = path.join(projectsDir, slug);
  const skillDir = path.join(projectDir, "skill");
  const botDir = path.join(projectDir, "bot");
  const sourceDir = path.join(projectDir, "source");

  if (fs.existsSync(projectDir) && body.overwrite !== true) {
    return { ok: false, error: `项目 ${slug} 已存在。勾选覆盖后再生成。` };
  }
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  const sourceName = hasChatText ? String(body.sourceName || "chat-export.txt") : "manual-profile.md";
  const docs = buildSkillDocs({
    name: String(body.name || targetSpeaker || slug).trim(),
    slug,
    sourceName,
    targetSpeaker,
    counterpartSpeaker: analysis.counterpartSpeaker,
    analysis,
    customProfile,
  });

  if (hasChatText) {
    writeText(path.join(sourceDir, sanitizeFileName(body.sourceName || "chat-export.txt")), chatText);
  } else {
    writeText(path.join(sourceDir, "manual-profile.md"), formatCustomProfileForSource(customProfile));
  }
  writeText(path.join(skillDir, "memories.md"), docs.memories);
  writeText(path.join(skillDir, "persona.md"), docs.persona);
  writeText(path.join(skillDir, "SKILL.md"), docs.skill);
  writeJson(path.join(skillDir, "meta.json"), docs.meta);
  fs.copyFileSync(runtimeBotPath, path.join(botDir, "bot.js"));
  writeJson(path.join(botDir, "config.json"), buildBotConfig({
    ...body,
    botQq,
    allowedPrivateUserIds,
    targetSpeaker,
    counterpartSpeaker: analysis.counterpartSpeaker,
  }));

  const now = new Date().toISOString();
  const project = {
    slug,
    name: docs.meta.name,
    createdAt: now,
    updatedAt: now,
    sourceName: docs.meta.sourceName,
    targetSpeaker,
    counterpartSpeaker: analysis.counterpartSpeaker,
    botQq,
    allowedPrivateUserIds,
    onebotWsUrl: String(body.onebotWsUrl || "ws://127.0.0.1:3001").trim(),
    messageCount: analysis.totalMessages,
    customProfile: customProfile.summary,
    timeRange: analysis.timeRange,
    projectDir,
    skillDir,
    botDir,
  };

  const projects = readProjects().filter((item) => item.slug !== slug);
  projects.unshift(project);
  writeProjects(projects);

  return { ok: true, message: `已生成项目 ${project.name}`, project, analysis };
}

function buildBotConfig(input) {
  const provider = String(input.provider || getApiSettings().provider || "deepseek").toLowerCase() === "openai" ? "openai" : "deepseek";
  return {
    personaName: String(input.targetSpeaker || input.name || ""),
    targetSpeaker: String(input.targetSpeaker || ""),
    counterpartSpeaker: String(input.counterpartSpeaker || ""),
    botQq: String(input.botQq || ""),
    requireBotQqMatch: true,
    onebotWsUrl: String(input.onebotWsUrl || "ws://127.0.0.1:3001").trim(),
    onebotAccessToken: String(input.onebotAccessToken || ""),
    skillPath: "../skill/SKILL.md",
    logPath: "bot.log",
    provider,
    deepseekBaseUrl: String(input.deepseekBaseUrl || getApiSettings().deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, ""),
    deepseekModel: String(input.deepseekModel || getApiSettings().deepseekModel || "deepseek-v4-pro"),
    openaiModel: String(input.openaiModel || getApiSettings().openaiModel || "gpt-4.1-mini"),
    replyToAllPrivate: false,
    allowedPrivateUserIds: input.allowedPrivateUserIds || [],
    replyInGroups: false,
    allowedGroupIds: [],
    groupMentionOnly: true,
    maxHistoryTurns: 8,
    maxOutputTokens: 1314,
    temperature: 0.82,
    requestTimeoutMs: 60000,
    typingDelayMs: 650,
    mergeMessages: true,
    mergeWindowMs: 2800,
    maxMergedMessages: 8,
    replyWhenModelReturnsEmpty: false,
    replyWhenModelTimesOut: false,
    splitMultilineReplies: true,
    perMessageDelayMs: 800,
    maxReplyParts: 8,
    maxMessageChars: 200,
    ignorePatterns: ["^/", "^#"],
  };
}

async function startProject(slug) {
  const project = getProject(slug);
  if (!project) return { ok: false, error: `找不到项目 ${slug}` };
  const keyCheck = checkApiKey();
  if (!keyCheck.ok) return keyCheck;
  const config = readJsonSafe(path.join(project.botDir, "config.json"), {});
  const endpoint = parseOneBotEndpoint(config.onebotWsUrl || project.onebotWsUrl || "ws://127.0.0.1:3001");
  if (!endpoint) return { ok: false, error: "OneBot WebSocket 地址格式不正确。" };
  const onebot = await checkTcpPort(endpoint.host, endpoint.port, 800);
  if (!onebot.open) {
    return { ok: false, error: `OneBot WebSocket 还没启动：${endpoint.host}:${endpoint.port}。请先启动 NapCat 并扫码登录。` };
  }

  const state = readState();
  const existingPid = state[slug]?.pid;
  if (existingPid && isAlive(existingPid)) return { ok: true, message: `${project.name} 已在运行`, pid: existingPid };

  const logFile = path.join(project.botDir, "process.log");
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["bot.js"], {
    cwd: project.botDir,
    env: { ...process.env, ...runtimeEnv },
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  state[slug] = { pid: child.pid, startedAt: new Date().toISOString() };
  writeState(state);
  return { ok: true, message: `${project.name} 已启动`, pid: child.pid };
}

function stopProject(slug) {
  const project = getProject(slug);
  if (!project) return { ok: false, error: `找不到项目 ${slug}` };
  const state = readState();
  const pid = state[slug]?.pid;
  if (!pid || !isAlive(pid)) {
    delete state[slug];
    writeState(state);
    return { ok: true, message: `${project.name} 未运行` };
  }
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
  if (result.status === 0 || !isAlive(pid)) {
    delete state[slug];
    writeState(state);
    return { ok: true, message: `${project.name} 已停止` };
  }
  return { ok: false, error: result.stderr || result.stdout || `停止 ${pid} 失败` };
}

function getProjectLogs(slug) {
  const project = getProject(slug);
  if (!project) return { ok: false, error: `找不到项目 ${slug}` };
  return {
    ok: true,
    bot: tail(path.join(project.botDir, "bot.log"), 160),
    process: tail(path.join(project.botDir, "process.log"), 120),
  };
}

function startNapCat() {
  if (!fs.existsSync(napcatLauncher)) return { ok: false, error: `找不到 NapCat 启动器：${napcatLauncher}` };
  const child = spawn("cmd.exe", ["/c", napcatLauncher], {
    cwd: napcatDir,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { ok: true, message: "已启动 NapCat。二维码会显示在网页右侧。" };
}

function runKeepAwake() {
  if (!fs.existsSync(keepAwakeScript)) return { ok: false, error: `找不到电源脚本：${keepAwakeScript}` };
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", keepAwakeScript], {
    cwd: appDir,
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseQqChat(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const records = [];
  let current = null;
  let mode = "";

  const flush = () => {
    if (!current) return;
    const content = current.contentLines.join("\n").trim();
    if (current.speaker && current.time && content) {
      records.push({ speaker: current.speaker, time: current.time, content });
    }
    current = null;
    mode = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    const speakerHeader = parseSpeakerHeader(trimmed, lines[index + 1]);
    if (speakerHeader) {
      flush();
      current = { speaker: speakerHeader, time: "", contentLines: [] };
      mode = "speaker";
      continue;
    }
    if (/^发送人[:：]/.test(trimmed)) {
      flush();
      current = { speaker: trimmed.replace(/^发送人[:：]\s*/, "").trim(), time: "", contentLines: [] };
      mode = "speaker";
      continue;
    }
    if (!current) continue;
    if (/^时间[:：]/.test(trimmed)) {
      current.time = trimmed.replace(/^时间[:：]\s*/, "").trim();
      mode = "time";
      continue;
    }
    if (/^内容[:：]/.test(trimmed)) {
      current.contentLines.push(trimmed.replace(/^内容[:：]\s*/, ""));
      mode = "content";
      continue;
    }
    if (/^资源[:：]/.test(trimmed)) {
      mode = "resource";
      continue;
    }
    if (mode === "content") current.contentLines.push(raw);
  }
  flush();
  return records;
}

function parseSpeakerHeader(trimmed, nextLine) {
  if (!trimmed || (!trimmed.endsWith(":") && !trimmed.endsWith("："))) return "";
  const speaker = trimmed.slice(0, -1).trim();
  if (!speaker || /^(时间|内容|资源|聊天名称|聊天类型|导出时间|消息总数|时间范围)$/.test(speaker)) return "";
  if (/^时间[:：]/.test(String(nextLine || "").trim())) return speaker;
  return "";
}

function analyzeRecords(records, input = {}) {
  const speakerCounts = countBy(records.map((record) => record.speaker));
  const speakers = Object.entries(speakerCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const targetSpeaker = String(input.targetSpeaker || speakers[0]?.name || "").trim();
  const counterpartSpeaker = String(input.counterpartSpeaker || speakers.find((speaker) => speaker.name !== targetSpeaker)?.name || "").trim();
  const targetRecords = records.filter((record) => record.speaker === targetSpeaker);
  const textRecords = targetRecords.filter((record) => !isMediaOnly(record.content));
  const targetTexts = textRecords.map((record) => normalizeChatText(record.content)).filter(Boolean);
  const mediaCount = targetRecords.length - textRecords.length;
  const avgChars = targetTexts.length ? Math.round(targetTexts.join("").length / targetTexts.length) : 0;
  const phraseCounts = countBy(targetTexts.filter((text) => text.length <= 18));
  const topPhrases = Object.entries(phraseCounts)
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([text, count]) => ({ text, count }));
  const sampleQuotes = unique(targetTexts.filter((text) => text.length >= 1 && text.length <= 32)).slice(0, 16);
  const keywordSignals = collectKeywordSignals(targetTexts);

  return {
    sourceName: String(input.sourceName || ""),
    totalMessages: records.length,
    timeRange: {
      start: records[0]?.time || "",
      end: records[records.length - 1]?.time || "",
    },
    speakers,
    targetSpeaker,
    counterpartSpeaker,
    targetMessageCount: targetRecords.length,
    targetTextMessageCount: textRecords.length,
    targetMediaMessageCount: mediaCount,
    avgChars,
    punctuation: {
      question: countMatches(targetTexts, /[?？]/g),
      exclamation: countMatches(targetTexts, /[!！]/g),
      tilde: countMatches(targetTexts, /[~～]/g),
      ellipsis: countMatches(targetTexts, /…|\.{2,}/g),
    },
    topPhrases,
    sampleQuotes,
    keywordSignals,
  };
}

function emptyAnalysis(input = {}) {
  return {
    sourceName: String(input.sourceName || "manual-profile"),
    totalMessages: 0,
    timeRange: { start: "", end: "" },
    speakers: [],
    targetSpeaker: String(input.targetSpeaker || "").trim(),
    counterpartSpeaker: String(input.counterpartSpeaker || "").trim(),
    targetMessageCount: 0,
    targetTextMessageCount: 0,
    targetMediaMessageCount: 0,
    avgChars: 0,
    punctuation: { question: 0, exclamation: 0, tilde: 0, ellipsis: 0 },
    topPhrases: [],
    sampleQuotes: [],
    keywordSignals: {
      care: { label: "关心吃饭/睡觉/日常", count: 0 },
      miss: { label: "想念/喜欢/贴近", count: 0 },
      repair: { label: "解释/道歉/修复", count: 0 },
      play: { label: "游戏/出门/共同活动", count: 0 },
    },
  };
}

function getCustomProfile(body) {
  const fields = {
    characterNotes: cleanLongText(body.characterNotes, 5000),
    keyFacts: cleanLongText(body.keyFacts, 5000),
    relationshipNotes: cleanLongText(body.relationshipNotes, 4000),
    speakingStyle: cleanLongText(body.speakingStyle, 4000),
    responseRules: cleanLongText(body.responseRules, 4000),
    forbiddenRules: cleanLongText(body.forbiddenRules, 4000),
  };
  const hasAny = Object.values(fields).some(Boolean);
  const summary = {
    hasAny,
    characterNotes: Boolean(fields.characterNotes),
    keyFacts: Boolean(fields.keyFacts),
    relationshipNotes: Boolean(fields.relationshipNotes),
    speakingStyle: Boolean(fields.speakingStyle),
    responseRules: Boolean(fields.responseRules),
    forbiddenRules: Boolean(fields.forbiddenRules),
  };
  return { ...fields, hasAny, summary };
}

function cleanLongText(value, maxLength) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function formatCustomProfileForSkill(profile) {
  const sections = [
    ["性格补充", profile.characterNotes],
    ["关键信息", profile.keyFacts],
    ["关系与共同记忆", profile.relationshipNotes],
    ["说话风格", profile.speakingStyle],
    ["回复规则", profile.responseRules],
    ["禁忌与不要做", profile.forbiddenRules],
  ].filter(([, value]) => value);
  if (sections.length === 0) return "- 原材料不足";
  return sections.map(([title, value]) => `### ${title}\n${asBulletList(value)}`).join("\n\n");
}

function formatCustomProfileForSource(profile) {
  return [
    "# Manual Profile",
    "",
    formatCustomProfileForSkill(profile),
    "",
  ].join("\n");
}

function asBulletList(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "- 原材料不足";
  return lines.map((line) => /^[-*]\s+/.test(line) ? line : `- ${line}`).join("\n");
}

function buildSkillDocs(input) {
  const createdAt = new Date().toISOString();
  const analysis = input.analysis;
  const customProfile = input.customProfile || getCustomProfile({});
  const name = input.name || input.targetSpeaker || input.slug;
  const topPhrases = analysis.topPhrases.length
    ? analysis.topPhrases.map((item) => `- ${item.text}（${item.count} 次）`).join("\n")
    : "- 原材料不足";
  const quotes = analysis.sampleQuotes.length
    ? analysis.sampleQuotes.slice(0, 10).map((quote) => `- “${quote}”`).join("\n")
    : "- 原材料不足";
  const keywordLines = Object.entries(analysis.keywordSignals)
    .map(([key, value]) => `- ${value.label}: ${value.count} 条`)
    .join("\n");
  const customMemorySection = customProfile.hasAny ? `
## 手动补充资料
${formatCustomProfileForSkill(customProfile)}
` : "";
  const customPersonaSection = customProfile.hasAny ? `
## 手动设定
这些内容是创建者在网页里手动补充的目标设定。它们优先作为 bot 的性格和事实边界；聊天记录统计只作为语气证据。

${formatCustomProfileForSkill(customProfile)}
` : "";
  const customSkillSection = customProfile.hasAny ? `
## 手动补充设定
以下内容由创建者手动填写，优先级高于自动统计摘要。不要把这些内容说成“系统设定”，只把它自然体现在聊天里。

${formatCustomProfileForSkill(customProfile)}
` : "";

  const memories = `# Memories

## 数据边界
- 来源文件：${input.sourceName || "chat-export.txt"}
- 目标说话人：${input.targetSpeaker}
- 对话对象：${input.counterpartSpeaker || "原材料不足"}
- 时间范围：${analysis.timeRange.start || "原材料不足"} - ${analysis.timeRange.end || "原材料不足"}
- 总消息数：${analysis.totalMessages}
- 目标说话人消息数：${analysis.targetMessageCount}

## 可支持的共同记忆
- 这份自动蒸馏只根据聊天记录生成，不补写聊天记录没有支撑的背景、职业、关系标签或时间线。
- 需要更细的具体事件记忆时，应继续用人工或模型复核聊天记录后补充。

## 互动信号
${keywordLines || "- 原材料不足"}
${customMemorySection}

## 高频短句
${topPhrases}

## 证据摘录
${quotes}
`;

  const persona = `# Persona

## 表层语气
- 平均单条文本长度约 ${analysis.avgChars || 0} 字。
- 问号使用 ${analysis.punctuation.question} 次，感叹号使用 ${analysis.punctuation.exclamation} 次，波浪号使用 ${analysis.punctuation.tilde} 次，省略号使用 ${analysis.punctuation.ellipsis} 次。
- 图片/表情/媒体类消息约 ${analysis.targetMediaMessageCount} 条，可作为会用图片或表情回应的风格信号，但不要凭空编造具体表情包。

## 关系姿态
- 默认把对方当作熟悉的私聊对象，语气自然、短句、即时。
- 遇到情绪问题时先给明确态度，再解释，不要装作系统或机器人。

## 深层设定边界
- 年龄、职业、学校、MBTI、现实身份、关系名分：原材料不足时不要主动编造。
- 只能复用这份记录支持的说话方式和互动习惯。
${customPersonaSection}

## 常见短句材料
${topPhrases}
`;

  const skill = `# ${name} QQ Companion Persona

你要在 QQ 私聊里模拟「${input.targetSpeaker}」的说话方式。对话对象通常是「${input.counterpartSpeaker || "对方"}」。

## 最高优先级
- 只输出「${input.targetSpeaker}」会发出的聊天内容。
- 不要说自己是 AI、bot、模型、系统、提示词或文件。
- 不要复制大段原聊天记录。
- 不要编造原材料没有支持的人设背景；不确定的地方保持含糊和日常。
- 日常聊天短一点，严肃情绪问题可以多说几行。

## 数据摘要
- 来源：${input.sourceName || "chat-export.txt"}
- 时间范围：${analysis.timeRange.start || "原材料不足"} - ${analysis.timeRange.end || "原材料不足"}
- 目标消息数：${analysis.targetMessageCount}
- 文本消息数：${analysis.targetTextMessageCount}
- 媒体/图片类消息数：${analysis.targetMediaMessageCount}

## 语气规则
- 平均长度约 ${analysis.avgChars || 0} 字，优先保持 QQ 私聊的短句感。
- 多行输出代表连续发多条 QQ 消息。
- 如果对方连发多条消息，要照顾到每条消息里的重点。
- 如果对方质问、难过、吃醋或等很久，先回应情绪，再解释原因。
${customSkillSection}

## 高频短句
${topPhrases}

## 风格证据摘录
${quotes}

## 不能做的事
- 不能输出分析、括号旁白、舞台说明。
- 不能说“根据聊天记录”“作为机器人”“我无法”。
- 不能为了像而复读证据摘录；证据只用来把握语气。
`;

  return {
    memories,
    persona,
    skill,
    meta: {
      name,
      slug: input.slug,
      version: "1.0.0",
      sourceName: input.sourceName,
      targetSpeaker: input.targetSpeaker,
      counterpartSpeaker: input.counterpartSpeaker,
      createdAt,
      parser: "qq-bot-studio qq-chat-exporter parser",
      totalMessages: analysis.totalMessages,
      targetMessageCount: analysis.targetMessageCount,
      timeRange: analysis.timeRange,
      customProfile: customProfile.summary,
      filters: ["pure media placeholders excluded from text phrase samples"],
    },
  };
}

function getApiSettings() {
  const saved = readJsonSafe(apiSettingsPath, {});
  const provider = String(saved.provider || "deepseek").toLowerCase() === "openai" ? "openai" : "deepseek";
  const apiKey = String(saved.apiKey || runtimeEnv.DEEPSEEK_API_KEY || runtimeEnv.OPENAI_API_KEY || "");
  return {
    ok: true,
    provider,
    deepseekBaseUrl: String(saved.deepseekBaseUrl || "https://api.deepseek.com"),
    deepseekModel: String(saved.deepseekModel || "deepseek-v4-pro"),
    openaiModel: String(saved.openaiModel || "gpt-4.1-mini"),
    keySaved: Boolean(saved.apiKey),
    keyReady: Boolean(apiKey.trim()),
    maskedKey: apiKey ? maskKey(apiKey) : "",
  };
}

async function saveApiSettings(req) {
  const body = await readRequestJson(req);
  const provider = String(body.provider || "deepseek").toLowerCase() === "openai" ? "openai" : "deepseek";
  const apiKey = String(body.apiKey || "").trim();
  const deepseekBaseUrl = String(body.deepseekBaseUrl || "https://api.deepseek.com").trim().replace(/\/+$/, "");
  const deepseekModel = String(body.deepseekModel || "deepseek-v4-pro").trim();
  const openaiModel = String(body.openaiModel || "gpt-4.1-mini").trim();
  if (apiKey && apiKey.length < 8) return { ok: false, error: "API Key 太短了。" };
  if (apiKey) applyApiKey(provider, apiKey);
  const previous = readJsonSafe(apiSettingsPath, {});
  const saved = { provider, deepseekBaseUrl, deepseekModel, openaiModel };
  if (body.rememberKey === true && (apiKey || previous.apiKey)) saved.apiKey = apiKey || previous.apiKey;
  writeJson(apiSettingsPath, saved);
  return { ok: true, message: "API 配置已保存。", settings: getApiSettings() };
}

function checkApiKey() {
  const settings = getApiSettings();
  const hasKey = settings.provider === "openai"
    ? Boolean(String(runtimeEnv.OPENAI_API_KEY || "").trim())
    : Boolean(String(runtimeEnv.DEEPSEEK_API_KEY || runtimeEnv.OPENAI_API_KEY || "").trim());
  if (hasKey) return { ok: true, provider: settings.provider };
  return { ok: false, provider: settings.provider, error: "还没有 API Key。请先在网页里保存。" };
}

function loadApiSettingsIntoRuntime() {
  const settings = readJsonSafe(apiSettingsPath, {});
  if (settings.apiKey) applyApiKey(settings.provider || "deepseek", settings.apiKey);
}

function applyApiKey(provider, apiKey) {
  if (provider === "openai") {
    runtimeEnv.OPENAI_API_KEY = apiKey;
    delete runtimeEnv.DEEPSEEK_API_KEY;
  } else {
    runtimeEnv.DEEPSEEK_API_KEY = apiKey;
    delete runtimeEnv.OPENAI_API_KEY;
  }
}

function readProjects() {
  const value = readJsonSafe(projectsPath, []);
  return Array.isArray(value) ? value : [];
}

function writeProjects(projects) {
  writeJson(projectsPath, projects);
}

function getProject(slug) {
  return readProjects().find((project) => project.slug === slug) || null;
}

function readState() {
  return readJsonSafe(statePath, {});
}

function writeState(state) {
  writeJson(statePath, state);
}

function matchProjectAction(pathname) {
  const match = /^\/api\/projects\/([^/]+)\/(start|stop|logs)$/.exec(pathname);
  if (!match) return null;
  return { slug: decodeURIComponent(match[1]), action: match[2] };
}

function uniqueSlug(value, overwrite) {
  const base = slugify(value);
  if (overwrite) return base;
  const existing = new Set(readProjects().map((project) => project.slug));
  if (!existing.has(base) && !fs.existsSync(path.join(projectsDir, base))) return base;
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${base}-${stamp}`;
}

function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `bot-${Date.now()}`;
}

function sanitizeFileName(value) {
  const name = String(value || "chat-export.txt").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return name || "chat-export.txt";
}

function normalizeQq(value) {
  const match = String(value || "").match(/\d{5,12}/);
  return match ? match[0] : "";
}

function normalizeQqList(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  return [...new Set(raw.split(/[,\s，、]+/).map(normalizeQq).filter(Boolean))];
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function countMatches(texts, pattern) {
  let count = 0;
  for (const text of texts) count += (text.match(pattern) || []).length;
  return count;
}

function collectKeywordSignals(texts) {
  const groups = {
    care: { label: "关心吃饭/睡觉/日常", words: ["吃饭", "睡觉", "晚安", "早安", "困", "醒"] },
    miss: { label: "想念/喜欢/贴近", words: ["想你", "想我", "喜欢", "爱你", "亲", "抱"] },
    repair: { label: "解释/道歉/修复", words: ["对不起", "抱歉", "我错", "别生气", "不是", "没有"] },
    play: { label: "游戏/出门/共同活动", words: ["游戏", "vrc", "VRChat", "maimai", "mai", "舞萌", "出去"] },
  };
  const result = {};
  for (const [key, group] of Object.entries(groups)) {
    result[key] = {
      label: group.label,
      count: texts.filter((text) => group.words.some((word) => text.toLowerCase().includes(word.toLowerCase()))).length,
    };
  }
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeChatText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isMediaOnly(content) {
  const text = normalizeChatText(content);
  if (!text) return true;
  return /^(\[[^\]]*(图片|表情|语音|视频|文件|动画|闪照|红包|位置|链接|合并转发)[^\]]*\]\s*)+$/.test(text);
}

function readRequestJson(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data, "utf8") > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) return sendText(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

function sendQrcode(res) {
  if (!fs.existsSync(napcatQrPath)) return sendText(res, 404, "QR code not found");
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  fs.createReadStream(napcatQrPath).pipe(res);
}

function sendJson(res, payload, status = 200) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  const body = { ...payload };
  if (body.setCookie) {
    headers["Set-Cookie"] = body.setCookie;
    delete body.setCookie;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, String(text), "utf8");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function tail(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(-maxLines).join("\n");
}

function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function getQrcodeStatus() {
  if (!fs.existsSync(napcatQrPath)) return { exists: false };
  const stat = fs.statSync(napcatQrPath);
  return { exists: true, updatedAt: stat.mtime.toISOString(), size: stat.size, url: `/napcat-qrcode.png?t=${stat.mtimeMs}` };
}

function getOneBotStatusQuick() {
  const result = spawnSync("netstat.exe", ["-ano"], { encoding: "utf8", windowsHide: true });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return {
    host: "127.0.0.1",
    port: 3001,
    listening: /127\.0\.0\.1:3001\s+0\.0\.0\.0:0\s+LISTENING/.test(text)
      || /0\.0\.0\.0:3001\s+0\.0\.0\.0:0\s+LISTENING/.test(text),
  };
}

function checkTcpPort(host, portNumber, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: portNumber });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ open });
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

function parseOneBotEndpoint(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["ws:", "wss:"].includes(url.protocol)) return null;
    const portNumber = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
    if (!url.hostname || !Number.isInteger(portNumber)) return null;
    return { host: url.hostname, port: portNumber };
  } catch {
    return null;
  }
}

function maskKey(key) {
  const text = String(key || "");
  if (text.length <= 12) return "已设置";
  return `${text.slice(0, 7)}...${text.slice(-4)}`;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function formatError(error) {
  if (!error) return "unknown error";
  if (error.stack) return error.stack;
  if (error.message) return error.message;
  return String(error);
}
