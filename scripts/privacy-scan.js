const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "workspace",
  ".cache",
  "tmp",
  "temp",
]);
const ignoredFiles = new Set([
  ".env.example",
  "scripts/privacy-scan.js",
]);

const forbiddenPathParts = [
  "workspace",
  "NapCat",
  "cache",
  "qrcode",
  "friend_",
  "chat-export",
  "api-settings.local",
  "process-state",
];

const secretPatterns = [
  { name: "OpenAI/DeepSeek style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "access token query", pattern: /wss?:\/\/[^\s"'`]+access_token=[^\s&"'`]+/i },
  { name: "saved API key field", pattern: /"apiKey"\s*:\s*"[^"]{8,}"/i },
  { name: "password assignment", pattern: /BOT_STUDIO_PASSWORD\s*=\s*(?!["']?(?:change-me|your-password|replace-with))["']?[^\s#]+/i },
  { name: "QQChatExporter transcript", pattern: /\[QQChatExporter|聊天记录导出文件|消息总数[:：]\s*\d+/ },
];

const findings = [];

walk(root);

if (findings.length > 0) {
  console.error("Privacy scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Privacy scan passed.");

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(root, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    scanFile(fullPath, rel);
  }
}

function scanFile(filePath, rel) {
  if (ignoredFiles.has(rel)) return;
  for (const part of forbiddenPathParts) {
    if (rel.toLowerCase().includes(part.toLowerCase())) {
      findings.push(`${rel}: suspicious private path segment "${part}"`);
    }
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 2 * 1024 * 1024) {
    findings.push(`${rel}: file is larger than 2MB`);
    return;
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  for (const rule of secretPatterns) {
    if (rule.pattern.test(text)) {
      findings.push(`${rel}: matched ${rule.name}`);
    }
  }
}
