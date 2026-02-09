const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function requireAnyEnv(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v && String(v).trim() !== "") return v;
  }
  throw new Error(`Missing required environment variable (any of): ${names.join(", ")}`);
}

function getOptionalEnv(name, fallback) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") return fallback;
  return v;
}

async function codeGithubRequest(apiPath, options) {
  const url = `https://api.github.com${apiPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${CODE_GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options && options.headers ? options.headers : {})
    }
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = (json && (json.message || json.error)) ? (json.message || json.error) : text;
    throw new Error(`Code GitHub API error ${res.status}: ${msg}`);
  }
  return json;
}

function requireCodeGithubEnv() {
  if (!CODE_GITHUB_TOKEN) throw new Error("Missing required environment variable: CODE_GITHUB_TOKEN");
  if (!CODE_GITHUB_OWNER) throw new Error("Missing required environment variable: CODE_GITHUB_OWNER");
  if (!CODE_GITHUB_REPO) throw new Error("Missing required environment variable: CODE_GITHUB_REPO");
}

async function codeGithubGetFileSha(repoPath) {
  try {
    const data = await codeGithubRequest(
      `/repos/${encodeURIComponent(CODE_GITHUB_OWNER)}/${encodeURIComponent(CODE_GITHUB_REPO)}/contents/${repoPath}?ref=${encodeURIComponent(CODE_GITHUB_BRANCH)}`,
      { method: "GET" }
    );
    return data && data.sha ? data.sha : null;
  } catch (e) {
    if (String(e?.message || e).includes("404")) return null;
    throw e;
  }
}

async function codeGithubUpsertFile(repoPath, contentUtf8, commitMessage) {
  const sha = await codeGithubGetFileSha(repoPath);
  const body = {
    message: commitMessage,
    content: Buffer.from(contentUtf8, "utf8").toString("base64"),
    branch: CODE_GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  await codeGithubRequest(
    `/repos/${encodeURIComponent(CODE_GITHUB_OWNER)}/${encodeURIComponent(CODE_GITHUB_REPO)}/contents/${repoPath}`,
    {
      method: "PUT",
      body: JSON.stringify(body)
    }
  );
}

function readLocalFileSafe(rel) {
  const abs = path.join(__dirname, rel);
  return fs.readFileSync(abs, "utf8");
}

function writeLocalFileSafe(rel, content) {
  const abs = path.join(__dirname, rel);
  fs.writeFileSync(abs, content, "utf8");
}

function summarizeProposal(p) {
  const files = Object.keys(p.files || {});
  const lines = [];
  lines.push(`Reason: ${p.reason || "(none)"}`);
  lines.push(`Files: ${files.join(", ") || "(none)"}`);
  for (const f of files) {
    const n = String(p.files[f] || "").length;
    lines.push(`${f}: ${n} chars`);
  }
  return lines.join("\n");
}

const TELEGRAM_BOT_TOKEN = requireAnyEnv([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_TOKEN",
  "BOT_TOKEN"
]);

const AI_PROVIDER = String(getOptionalEnv("AI_PROVIDER", "openai")).toLowerCase();

const AI_API_KEY = getOptionalEnv("AI_API_KEY", "");
const AI_BASE_URL = getOptionalEnv("AI_BASE_URL", "https://api.openai.com/v1");
const AI_MODEL = getOptionalEnv("AI_MODEL", "gpt-4o-mini");

const ANTHROPIC_API_KEY = getOptionalEnv("ANTHROPIC_API_KEY", "");
const ANTHROPIC_MODEL = getOptionalEnv("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022");

const GEMINI_API_KEY = getOptionalEnv("GEMINI_API_KEY", "");
const GEMINI_MODEL = getOptionalEnv("GEMINI_MODEL", "gemini-flash-latest");
const AI_SYSTEM_PROMPT = getOptionalEnv(
  "AI_SYSTEM_PROMPT",
  "Ты OpenClaw — полезный AI ассистент. Отвечай кратко и по делу."
);

const GOOGLE_SHEET_ID = getOptionalEnv("GOOGLE_SHEET_ID", "");
const GOOGLE_SERVICE_ACCOUNT_JSON_B64 = getOptionalEnv(
  "GOOGLE_SERVICE_ACCOUNT_JSON_B64",
  ""
);

const GITHUB_TOKEN = getOptionalEnv("GITHUB_TOKEN", "");
const GITHUB_OWNER = getOptionalEnv("GITHUB_OWNER", "");
const GITHUB_REPO = getOptionalEnv("GITHUB_REPO", "");
const GITHUB_BRANCH = getOptionalEnv("GITHUB_BRANCH", "main");
const GITHUB_PAGES_BASE_URL = getOptionalEnv("GITHUB_PAGES_BASE_URL", "");

const CODE_GITHUB_TOKEN = getOptionalEnv("CODE_GITHUB_TOKEN", "");
const CODE_GITHUB_OWNER = getOptionalEnv("CODE_GITHUB_OWNER", "");
const CODE_GITHUB_REPO = getOptionalEnv("CODE_GITHUB_REPO", "");
const CODE_GITHUB_BRANCH = getOptionalEnv("CODE_GITHUB_BRANCH", "main");

const TELEGRAM_ALLOWED_USER_IDS = getOptionalEnv("TELEGRAM_ALLOWED_USER_IDS", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });



bot.onText(/^\/my_id$/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;
  const id = msg?.from?.id;
  await bot.sendMessage(chatId, String(id || ""));
});
bot.onText(/^\/dev_bootstrap$/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;

  try {
    requireCodeGithubEnv();
    await bot.sendChatAction(chatId, "typing");

    const indexJs = readLocalFileSafe("index.js");
    const pkg = readLocalFileSafe("package.json");

    await codeGithubUpsertFile("index.js", indexJs, "Bootstrap index.js");
    await codeGithubUpsertFile("package.json", pkg, "Bootstrap package.json");

    await bot.sendMessage(
      chatId,
      `Bootstrapped code repo: https://github.com/${CODE_GITHUB_OWNER}/${CODE_GITHUB_REPO}`
    );
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/dev_bootstrap error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.onText(/^\/dev_request(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;
  const req = (match && match[1] ? String(match[1]) : "").trim();
  if (!req) {
    await bot.sendMessage(chatId, "Usage: /dev_request <what to change>");
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");

    const currentIndex = readLocalFileSafe("index.js");
    const currentPkg = readLocalFileSafe("package.json");

    if (/\/(my_id)\b/i.test(req)) {
      const nextIndex = insertMyIdCommand(currentIndex);
      devProposal = {
        created_at: nowIso(),
        reason: "Add /my_id command",
        files: {
          "index.js": nextIndex,
          "package.json": currentPkg
        }
      };

      await appendRowIfReady("Tasks", [
        nowIso(),
        "dev_proposal",
        devProposal.reason,
        JSON.stringify({ files: Object.keys(devProposal.files) }),
        "pending",
        "builtin_generator"
      ]);

      await bot.sendMessage(chatId, "Dev proposal prepared. Use /dev_diff then /dev_apply.");
      return;
    }

    const spec = await aiGenerateJson({
      task:
        "You are implementing changes in a Node.js Telegram bot project. " +
        "Return a JSON object with updated file contents for an allowlist of files only. " +
        "You MUST preserve all existing functionality unless asked. " +
        "Never include secrets; never add code that prints environment variables. " +
        "Allowed files: index.js, package.json.",
      schemaHint:
        '{"reason":"","files":{"index.js":"<full file text>","package.json":"<full file text>"}}\n' +
        `Request: ${req}\n\n` +
        `Current index.js:\n${currentIndex}\n\nCurrent package.json:\n${currentPkg}`
    });

    const files = spec && spec.files ? spec.files : {};
    const filtered = {};
    for (const k of Object.keys(files)) {
      if (DEV_ALLOWLIST.has(k)) filtered[k] = String(files[k] || "");
    }
    if (Object.keys(filtered).length === 0) {
      throw new Error("Dev request returned no allowlisted files");
    }

    devProposal = {
      created_at: nowIso(),
      reason: spec.reason || req,
      files: filtered
    };

    await appendRowIfReady("Tasks", [
      nowIso(),
      "dev_proposal",
      spec.reason || req,
      JSON.stringify({ files: Object.keys(filtered) }),
      "pending",
      ""
    ]);

    await bot.sendMessage(chatId, "Dev proposal prepared. Use /dev_diff then /dev_apply.");
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/dev_request error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.onText(/^\/dev_diff$/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;

  if (!devProposal) {
    await bot.sendMessage(chatId, "No pending dev proposal. Use /dev_request first.");
    return;
  }

  const summary = summarizeProposal(devProposal);
  await bot.sendMessage(chatId, trimForTelegram(summary));
});

bot.onText(/^\/dev_apply$/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;
  if (!devProposal) {
    await bot.sendMessage(chatId, "No pending dev proposal. Use /dev_request first.");
    return;
  }

  try {
    requireCodeGithubEnv();
    await bot.sendChatAction(chatId, "typing");

    const files = devProposal.files || {};
    for (const f of Object.keys(files)) {
      if (!DEV_ALLOWLIST.has(f)) continue;
      const content = String(files[f] || "");
      if (!content.trim()) throw new Error(`Refusing to write empty file: ${f}`);

      await codeGithubUpsertFile(f, content, `Apply update to ${f}`);
      writeLocalFileSafe(f, content);
    }

    await appendRowIfReady("Tasks", [
      nowIso(),
      "dev_apply",
      devProposal.reason || "apply",
      JSON.stringify({ files: Object.keys(files) }),
      "done",
      "restart_required"
    ]);

    devProposal = null;
    await bot.sendMessage(chatId, "Update applied. Please Restart the server in Pterodactyl.");
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/dev_apply error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.onText(/^\/landing_create(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;
  const raw = (match && match[1] ? String(match[1]) : "").trim();
  if (!raw) {
    await bot.sendMessage(
      chatId,
      "Usage: /landing_create <topic> OR /landing_create <redirect_url> | <topic>"
    );
    return;
  }

  const parts = raw.split("|").map((s) => s.trim()).filter(Boolean);
  const redirectUrl = parts.length >= 2 ? parts[0] : "";
  const topic = parts.length >= 2 ? parts.slice(1).join(" | ") : raw;

  try {
    requireGithubEnv();
    await bot.sendChatAction(chatId, "typing");

    const baseUrl = getPagesBaseUrl();
    if (!baseUrl) throw new Error("GitHub Pages base URL is not configured");

    const data = await aiGenerateJson({
      task:
        "Generate a simple, compliant EN landing page content for organic testing. " +
        "Avoid prohibited claims. Keep it suitable for B2B/Mobile apps. " +
        "Return short punchy copy.",
      schemaHint:
        '{"title":"","headline":"","subheadline":"","bullets":[""],"cta_text":"","disclaimer":""}\nTopic: ' +
        topic
    });

    const slug = slugify(`${topic}-${Date.now()}`);
    const ctaUrl = redirectUrl ? `${baseUrl}/go/${slug}` : baseUrl;
    const html = renderLandingHtml({
      title: data.title || "Landing",
      headline: data.headline || topic,
      subheadline: data.subheadline || "",
      bullets: Array.isArray(data.bullets) ? data.bullets.slice(0, 6) : [],
      ctaText: data.cta_text || "Learn more",
      ctaUrl,
      disclaimer: data.disclaimer || "This page is for informational purposes only."
    });

    const landingPath = `landings/${slug}/index.html`;
    await githubUpsertFile(landingPath, html, `Add landing ${slug}`);

    if (redirectUrl) {
      const redirectHtml = `<!doctype html><html><head><meta charset="utf-8" /><meta http-equiv="refresh" content="0; url=${escapeHtml(redirectUrl)}" /></head><body>Redirecting...</body></html>`;
      await githubUpsertFile(`go/${slug}.html`, redirectHtml, `Add redirect ${slug}`);
    }

    const landingUrl = `${baseUrl}/landings/${slug}/`;
    await appendRow("Landings", [
      nowIso(),
      topic,
      slug,
      landingUrl,
      "published",
      redirectUrl ? `redirect_url=${redirectUrl}` : ""
    ]);

    await bot.sendMessage(chatId, `Landing published: ${landingUrl}`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/landing_create error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.onText(/^\/utm_create(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;
  const raw = (match && match[1] ? String(match[1]) : "").trim();
  if (!raw) {
    await bot.sendMessage(chatId, "Usage: /utm_create <base_url or landing_url> [optional notes]");
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");

    const data = await aiGenerateJson({
      task:
        "Create 3 UTM templates for organic posting on X, LinkedIn, TikTok. " +
        "Return items with utm_source/utm_medium/utm_campaign/utm_content. " +
        "utm_campaign should be short slug-like.",
      schemaHint:
        '{"base_url":"","items":[{"utm_source":"","utm_medium":"","utm_campaign":"","utm_content":""}]}' +
        "\nInput: " +
        raw
    });

    const baseUrl = (data.base_url || raw).trim();
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw new Error("No UTM items returned by AI");

    const makeUrl = (u) => {
      const sep = u.includes("?") ? "&" : "?";
      return (
        u +
        sep +
        `utm_source=${encodeURIComponent(String(u.utm_source || ""))}`
      );
    };

    for (const it of items.slice(0, 10)) {
      const fullUrl =
        baseUrl +
        (baseUrl.includes("?") ? "&" : "?") +
        `utm_source=${encodeURIComponent(it.utm_source || "")}` +
        `&utm_medium=${encodeURIComponent(it.utm_medium || "")}` +
        `&utm_campaign=${encodeURIComponent(it.utm_campaign || "")}` +
        `&utm_content=${encodeURIComponent(it.utm_content || "")}`;

      await appendRow("UTM_Templates", [
        nowIso(),
        baseUrl,
        it.utm_source || "",
        it.utm_medium || "",
        it.utm_campaign || "",
        it.utm_content || "",
        fullUrl,
        ""
      ]);
    }

    await bot.sendMessage(chatId, "UTM templates saved to sheet: UTM_Templates");
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/utm_create error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

const openai = new OpenAI({
  apiKey: AI_API_KEY,
  baseURL: AI_BASE_URL
});

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY
});

const gemini = new GoogleGenerativeAI(GEMINI_API_KEY);

let sheetsClient = null;

const DEV_ALLOWLIST = new Set(["index.js", "package.json"]);
let devProposal = null;

async function appendRowIfReady(sheetTitle, values) {
  try {
    if (!sheetsClient) return;
    await appendRow(sheetTitle, values);
  } catch (e) {
    console.error("appendRowIfReady error:", e && e.message ? e.message : String(e));
  }
}

function insertMyIdCommand(indexJsSource) {
  if (indexJsSource.includes("/^\\/my_id")) return indexJsSource;

  const marker = "bot.onText(/^\\/dev_bootstrap$/i";
  const snippet = `\n\nbot.onText(/^\\/my_id$/i, async (msg) => {\n  const chatId = msg.chat.id;\n  if (!isAllowedUser(msg)) return;\n  const id = msg?.from?.id;\n  await bot.sendMessage(chatId, String(id || \"\"));\n});\n`;

  const idx = indexJsSource.indexOf(marker);
  if (idx === -1) return indexJsSource + snippet;
  return indexJsSource.slice(0, idx) + snippet + indexJsSource.slice(idx);
}

function nowIso() {
  return new Date().toISOString();
}

function isAllowedUser(msg) {
  if (!TELEGRAM_ALLOWED_USER_IDS || TELEGRAM_ALLOWED_USER_IDS.length === 0) return true;
  const id = msg?.from?.id;
  return typeof id === "number" && TELEGRAM_ALLOWED_USER_IDS.includes(id);
}

function decodeServiceAccountJsonFromB64(b64) {
  let raw;
  try {
    raw = Buffer.from(String(b64), "base64").toString("utf8");
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not valid base64");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_B64 does not decode to valid JSON");
  }
}

async function initGoogleSheets() {
  if (!GOOGLE_SHEET_ID && !GOOGLE_SERVICE_ACCOUNT_JSON_B64) {
    console.log("Google Sheets integration disabled (no GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON_B64). ");
    return null;
  }

  if (!GOOGLE_SHEET_ID) {
    throw new Error("Missing required environment variable: GOOGLE_SHEET_ID");
  }
  if (!GOOGLE_SERVICE_ACCOUNT_JSON_B64) {
    throw new Error("Missing required environment variable: GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  }

  const creds = decodeServiceAccountJsonFromB64(GOOGLE_SERVICE_ACCOUNT_JSON_B64);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });

  const desired = [
    {
      title: "Offers",
      headers: [
        "created_at",
        "source_url",
        "network",
        "offer_name",
        "vertical",
        "geo",
        "payout",
        "currency",
        "allowed_sources",
        "restrictions",
        "status",
        "notes"
      ]
    },
    {
      title: "Hypotheses",
      headers: [
        "created_at",
        "offer_name",
        "platform",
        "audience",
        "angle",
        "content_type",
        "status",
        "priority",
        "notes"
      ]
    },
    {
      title: "Creatives",
      headers: [
        "created_at",
        "hypothesis_ref",
        "format",
        "hook",
        "primary_text",
        "cta",
        "landing_outline",
        "notes"
      ]
    },
    {
      title: "Campaigns",
      headers: [
        "created_at",
        "platform",
        "offer_name",
        "utm",
        "budget",
        "spend",
        "clicks",
        "conversions",
        "revenue",
        "roi",
        "status",
        "notes"
      ]
    },
    {
      title: "Landings",
      headers: [
        "created_at",
        "topic",
        "slug",
        "url",
        "status",
        "notes"
      ]
    },
    {
      title: "UTM_Templates",
      headers: [
        "created_at",
        "base_url",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "full_url",
        "notes"
      ]
    },
    {
      title: "Tasks",
      headers: [
        "created_at",
        "type",
        "title",
        "payload",
        "status",
        "notes"
      ]
    }
  ];

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID
  });

  const existingTitles = new Set(
    (spreadsheet.data.sheets || [])
      .map((s) => s.properties && s.properties.title)
      .filter(Boolean)
  );

  const toAdd = desired.filter((d) => !existingTitles.has(d.title));
  if (toAdd.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        requests: toAdd.map((d) => ({
          addSheet: {
            properties: {
              title: d.title
            }
          }
        }))
      }
    });
  }

  for (const d of desired) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${d.title}!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [d.headers]
      }
    });
  }

  return { sheets };
}

function assertSheetsReady() {
  if (!sheetsClient) {
    throw new Error(
      "Google Sheets is not ready. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON_B64 and restart."
    );
  }
}

async function appendRow(sheetTitle, values) {
  assertSheetsReady();
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetTitle}!A:Z`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values]
    }
  });
}

function requireGithubEnv() {
  if (!GITHUB_TOKEN) throw new Error("Missing required environment variable: GITHUB_TOKEN");
  if (!GITHUB_OWNER) throw new Error("Missing required environment variable: GITHUB_OWNER");
  if (!GITHUB_REPO) throw new Error("Missing required environment variable: GITHUB_REPO");
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function getPagesBaseUrl() {
  if (GITHUB_PAGES_BASE_URL) return GITHUB_PAGES_BASE_URL.replace(/\/$/, "");
  if (GITHUB_OWNER && GITHUB_REPO) {
    return `https://${GITHUB_OWNER}.github.io/${GITHUB_REPO}`;
  }
  return "";
}

async function githubRequest(path, options) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options && options.headers ? options.headers : {})
    }
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = (json && (json.message || json.error)) ? (json.message || json.error) : text;
    throw new Error(`GitHub API error ${res.status}: ${msg}`);
  }
  return json;
}

async function githubGetFileSha(repoPath) {
  try {
    const data = await githubRequest(
      `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${repoPath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
      { method: "GET" }
    );
    return data && data.sha ? data.sha : null;
  } catch (e) {
    if (String(e?.message || e).includes("404")) return null;
    throw e;
  }
}

async function githubUpsertFile(repoPath, contentUtf8, commitMessage) {
  const sha = await githubGetFileSha(repoPath);
  const body = {
    message: commitMessage,
    content: Buffer.from(contentUtf8, "utf8").toString("base64"),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  await githubRequest(
    `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${repoPath}`,
    {
      method: "PUT",
      body: JSON.stringify(body)
    }
  );
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderLandingHtml({ title, headline, subheadline, bullets, ctaText, ctaUrl, disclaimer }) {
  const safeBullets = Array.isArray(bullets) ? bullets : [];
  const list = safeBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#0b0f17;color:#e8eefc;}
    .wrap{max-width:920px;margin:0 auto;padding:56px 20px;}
    .card{background:#121a2a;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px;}
    h1{font-size:40px;line-height:1.1;margin:0 0 14px;}
    p{font-size:18px;line-height:1.6;margin:0 0 18px;color:rgba(232,238,252,.86);}
    ul{margin:16px 0 0 20px;}
    li{margin:10px 0;font-size:18px;line-height:1.5;}
    .cta{display:inline-block;margin-top:22px;background:#4f7cff;color:white;text-decoration:none;padding:14px 18px;border-radius:12px;font-weight:700;}
    .small{margin-top:22px;font-size:13px;color:rgba(232,238,252,.6);}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(headline)}</h1>
      <p>${escapeHtml(subheadline)}</p>
      <ul>
        ${list}
      </ul>
      <a class="cta" href="${escapeHtml(ctaUrl)}">${escapeHtml(ctaText)}</a>
      <div class="small">${escapeHtml(disclaimer)}</div>
    </div>
  </div>
</body>
</html>`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractLikelyJson(text) {
  const s = String(text || "").trim();
  if (!s) return "";

  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();

  const firstObj = s.indexOf("{");
  const lastObj = s.lastIndexOf("}");
  if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
    return s.slice(firstObj, lastObj + 1).trim();
  }

  const firstArr = s.indexOf("[");
  const lastArr = s.lastIndexOf("]");
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
    return s.slice(firstArr, lastArr + 1).trim();
  }

  return s;
}

async function aiRepairToJson(badText) {
  const repairPrompt =
    "Convert the following content to STRICT valid JSON. Output ONLY JSON.\n" +
    "If it contains multiple things, preserve all information in JSON.\n\n" +
    badText;

  if (AI_PROVIDER === "gemini" || AI_PROVIDER === "google") {
    const model = gemini.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(repairPrompt);
    const response = await result.response;
    return response && typeof response.text === "function" ? response.text() : "";
  }

  if (AI_PROVIDER === "anthropic" || AI_PROVIDER === "claude") {
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 900,
      system: "Return ONLY valid JSON. No markdown.",
      messages: [{ role: "user", content: repairPrompt }]
    });
    const first = resp?.content?.[0];
    return first && first.type === "text" ? first.text : "";
  }

  const resp = await openai.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.1,
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No markdown." },
      { role: "user", content: repairPrompt }
    ]
  });
  return resp?.choices?.[0]?.message?.content || "";
}

async function aiGenerateJson({ task, schemaHint }) {
  const prompt =
    `You are an expert growth/affiliate operator. Return ONLY valid JSON.\n` +
    `Task: ${task}\n` +
    (schemaHint ? `Schema hint: ${schemaHint}\n` : "") +
    `No markdown, no explanations.`;

  const parseOrRepair = async (rawText) => {
    const extracted = extractLikelyJson(rawText);
    let parsed = safeJsonParse(extracted);
    if (parsed) return parsed;

    const repairedText = await aiRepairToJson(rawText);
    parsed = safeJsonParse(extractLikelyJson(repairedText));
    if (parsed) return parsed;
    throw new Error("AI did not return valid JSON");
  };

  if (AI_PROVIDER === "gemini" || AI_PROVIDER === "google") {
    if (!GEMINI_API_KEY) throw new Error("Missing required environment variable: GEMINI_API_KEY");
    const model = gemini.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response && typeof response.text === "function" ? response.text() : "";
    return await parseOrRepair(text);
  }

  if (AI_PROVIDER === "anthropic" || AI_PROVIDER === "claude") {
    if (!ANTHROPIC_API_KEY) throw new Error("Missing required environment variable: ANTHROPIC_API_KEY");
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 900,
      system: "Return ONLY valid JSON. No markdown.",
      messages: [{ role: "user", content: prompt }]
    });
    const first = resp?.content?.[0];
    const text = first && first.type === "text" ? first.text : "";
    return await parseOrRepair(text);
  }

  if (!AI_API_KEY) throw new Error("Missing required environment variable: AI_API_KEY");
  const resp = await openai.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.4,
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No markdown." },
      { role: "user", content: prompt }
    ]
  });
  const text = resp?.choices?.[0]?.message?.content || "";
  return await parseOrRepair(text);
}

const MAX_TELEGRAM_MESSAGE = 3800;

function trimForTelegram(text) {
  const s = String(text ?? "");
  if (s.length <= MAX_TELEGRAM_MESSAGE) return s;
  return s.slice(0, MAX_TELEGRAM_MESSAGE - 20) + "\n\n[сообщение обрезано]";
}

async function generateAssistantReply({ userText, chatId, username }) {
  const messages = [
    { role: "system", content: AI_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Пользователь: ${username || "unknown"}\n` +
        `ChatId: ${chatId}\n\n` +
        `Сообщение: ${userText}`
    }
  ];

  if (AI_PROVIDER === "anthropic" || AI_PROVIDER === "claude") {
    if (!ANTHROPIC_API_KEY) {
      throw new Error("Missing required environment variable: ANTHROPIC_API_KEY");
    }

    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      system: AI_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Пользователь: ${username || "unknown"}\n` +
            `ChatId: ${chatId}\n\n` +
            `Сообщение: ${userText}`
        }
      ]
    });

    const first = resp?.content?.[0];
    const text = first && first.type === "text" ? first.text : "";
    if (!text) return "Не получилось получить ответ от AI.";
    return text;
  }

  if (AI_PROVIDER === "gemini" || AI_PROVIDER === "google") {
    if (!GEMINI_API_KEY) {
      throw new Error("Missing required environment variable: GEMINI_API_KEY");
    }

    const model = gemini.getGenerativeModel({ model: GEMINI_MODEL });
    const prompt =
      `${AI_SYSTEM_PROMPT}\n\n` +
      `Пользователь: ${username || "unknown"}\n` +
      `ChatId: ${chatId}\n\n` +
      `Сообщение: ${userText}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response && typeof response.text === "function" ? response.text() : "";
    if (!text) return "Не получилось получить ответ от AI.";
    return text;
  }

  if (!AI_API_KEY) {
    throw new Error("Missing required environment variable: AI_API_KEY");
  }

  const resp = await openai.chat.completions.create({
    model: AI_MODEL,
    messages,
    temperature: 0.7
  });

  const content = resp?.choices?.[0]?.message?.content;
  if (!content) return "Не получилось получить ответ от AI.";
  return content;
}

bot.onText(/^(\/start|\/help)$/, async (msg) => {
  const chatId = msg.chat.id;
  const text =
    "Привет. Я OpenClaw — AI ассистент. Просто напиши сообщение, и я отвечу.";
  await bot.sendMessage(chatId, text);
});

bot.onText(/^\/offer_add(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;
  const raw = (match && match[1] ? String(match[1]) : "").trim();
  if (!raw) {
    await bot.sendMessage(chatId, "Usage: /offer_add <link or description>");
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const offer = await aiGenerateJson({
      task:
        "Extract an affiliate/partner offer from the following text/link and normalize fields. " +
        "If unknown, use empty string. Vertical must be one of: B2B, Mobile apps, iGaming. " +
        "Geo should be short like US, UK, WW. " +
        "Allowed_sources is comma-separated.",
      schemaHint:
        '{"source_url":"","network":"","offer_name":"","vertical":"","geo":"","payout":"","currency":"","allowed_sources":"","restrictions":"","notes":""}\nInput: ' +
        raw
    });

    await appendRow("Offers", [
      nowIso(),
      offer.source_url || "",
      offer.network || "",
      offer.offer_name || "",
      offer.vertical || "",
      offer.geo || "",
      offer.payout || "",
      offer.currency || "",
      offer.allowed_sources || "",
      offer.restrictions || "",
      "new",
      offer.notes || ""
    ]);

    await bot.sendMessage(chatId, "Added to Offers sheet: " + (offer.offer_name || "(no name)"));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/offer_add error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.onText(/^\/hypotheses_generate(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;

  const arg = (match && match[1] ? String(match[1]) : "").trim();
  const vertical = arg || "B2B";

  try {
    await bot.sendChatAction(chatId, "typing");
    const data = await aiGenerateJson({
      task:
        `Generate 12 growth/affiliate hypotheses for vertical=${vertical} targeting EN market. ` +
        "Each hypothesis should include platform in [X, LinkedIn, TikTok, Telegram] and a clear angle and audience. " +
        "Keep them whitehat.",
      schemaHint:
        '{"items":[{"offer_name":"","platform":"","audience":"","angle":"","content_type":"","priority":"low|medium|high","notes":""}]}'
    });

    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) throw new Error("No hypotheses returned by AI");

    for (const it of items.slice(0, 30)) {
      await appendRow("Hypotheses", [
        nowIso(),
        it.offer_name || "",
        it.platform || "",
        it.audience || "",
        it.angle || "",
        it.content_type || "",
        "new",
        it.priority || "medium",
        it.notes || ""
      ]);
    }

    await bot.sendMessage(chatId, `Added ${Math.min(items.length, 30)} hypotheses to sheet (${vertical}).`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/hypotheses_generate error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.onText(/^\/content_pack(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowedUser(msg)) return;
  const topic = (match && match[1] ? String(match[1]) : "").trim();
  if (!topic) {
    await bot.sendMessage(chatId, "Usage: /content_pack <topic or angle>");
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const pack = await aiGenerateJson({
      task:
        "Create an EN content pack for affiliate/growth testing. " +
        "Return variants for X, LinkedIn, TikTok. " +
        "Keep it whitehat and professional. Provide hook, body, cta, and a short landing outline.",
      schemaHint:
        '{"x":{"hook":"","primary_text":"","cta":"","landing_outline":""},"linkedin":{"hook":"","primary_text":"","cta":"","landing_outline":""},"tiktok":{"hook":"","primary_text":"","cta":"","landing_outline":""}}\nTopic: ' +
        topic
    });

    const formats = [
      { key: "x", name: "X" },
      { key: "linkedin", name: "LinkedIn" },
      { key: "tiktok", name: "TikTok" }
    ];

    for (const f of formats) {
      const v = pack[f.key] || {};
      await appendRow("Creatives", [
        nowIso(),
        topic,
        f.name,
        v.hook || "",
        v.primary_text || "",
        v.cta || "",
        v.landing_outline || "",
        ""
      ]);
    }

    await bot.sendMessage(chatId, "Content pack generated and saved to Creatives (X/LinkedIn/TikTok).");
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("/content_pack error:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith("/")) return;

  try {
    await bot.sendChatAction(chatId, "typing");

    const reply = await generateAssistantReply({
      userText: text,
      chatId,
      username: msg.from?.username || msg.from?.first_name
    });

    await bot.sendMessage(chatId, trimForTelegram(reply), {
      disable_web_page_preview: true
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error("Error while handling message:", message);
    await bot.sendMessage(chatId, "Ошибка: " + trimForTelegram(message));
  }
});

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err?.message || err);
});

console.log("ClawdBot started. Polling Telegram updates...");

initGoogleSheets()
  .then((res) => {
    if (res) {
      sheetsClient = res.sheets;
      console.log("Google Sheets integration ready.");
    }
  })
  .catch((err) => {
    console.error("Google Sheets init error:", err?.message || err);
  });
