import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import FormData from "form-data";

const {
  BOT_TOKEN,
  DISCORD_WEBHOOK_URL,
  PUBLIC_URL,            // e.g. https://your-service.onrender.com
  TELEGRAM_CHANNEL_ID,   // e.g. @splitthepicks (optional filter)
  PORT = 3000
} = process.env;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL");

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ---- SplitThePicks contact formatting ----
const DISCORD_CONTACT_USER_ID =
  process.env.DISCORD_CONTACT_USER_ID || "1374514852701143091";
const TELEGRAM_CONTACT_URL =
  process.env.TELEGRAM_CONTACT_URL || "https://t.me/splitthepicks";

function transformContent(raw) {
  let text = (raw ?? "");

  const footer = `DM 👉 <@${DISCORD_CONTACT_USER_ID}> • ${TELEGRAM_CONTACT_URL}`;

  // 1) Remove malformed links like https://@VEGASKILLER but KEEP line breaks
  text = text.replace(/https?:\/\/@\S+/gi, "");

  // 2) Detect any SplitThePicks reference anywhere
  const hasSTP = /@splitthepicks\b|t\.me\/splitthepicks\b|https?:\/\/t\.me\/splitthepicks\b|\bsplitthepicks\b/i.test(text);

  if (!hasSTP) {
    return text;
  }

  // 3) If there is already a "DM 👉 ..." line, replace ONLY that line with our clean footer
  //    (preserves all other formatting + spacing)
  const lines = text.split(/\r?\n/);

  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Any DM line OR any line that contains splitthepicks / t.me/splitthepicks
    if (/^\s*DM\s*👉/i.test(line) || /splitthepicks|t\.me\/splitthepicks/i.test(line)) {
      lines[i] = footer;
      replaced = true;
    }
  }

  let out = lines.join("\n");

  // 4) If we didn't replace an existing DM line, append footer as a new line block
  if (!replaced) {
    // Keep original spacing; just ensure there’s a blank line before footer if needed
    if (!out.endsWith("\n")) out += "\n";
    out += "\n" + footer;
  }

  // 5) Remove duplicate footers if multiple lines matched
  // (keep first instance)
  const outLines = out.split("\n");
  let seenFooter = false;
  const deduped = outLines.filter((l) => {
    const isFooter = l.trim() === footer.trim();
    if (!isFooter) return true;
    if (seenFooter) return false;
    seenFooter = true;
    return true;
  });

  return deduped.join("\n");
}


// Telegram will POST JSON updates here
app.use(express.json());

// ---- Album buffering (media_group_id) ----
const albumBuffer = new Map(); // key -> { caption, items: [], timer }

function normalizeCaption(msg) {
  return msg?.caption || msg?.text || "";
}

// Build a Telegram file URL (Telegram hosts files at this URL)
async function getTelegramFileUrl(fileId) {
  const r = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const j = await r.json();
  const filePath = j?.result?.file_path;
  if (!filePath) throw new Error("Could not resolve Telegram file path");
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
}

async function sendToDiscord({ content, files }) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content: (content || "").slice(0, 1900) })
  );

  for (let i = 0; i < files.length; i++) {
    const { url, filename } = files[i];
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch media: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    form.append(`files[${i}]`, buf, { filename: filename || `media-${i}.jpg` });
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: form });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${txt}`);
  }
}

// Optional: only forward posts from a specific channel
function passesChannelFilter(ctx) {
  if (!TELEGRAM_CHANNEL_ID) return true;
  const chat = ctx.update?.channel_post?.chat;
  if (!chat) return false;

  const asAt = chat.username ? `@${chat.username}` : null;
  return (
    asAt === TELEGRAM_CHANNEL_ID ||
    chat.id?.toString() === TELEGRAM_CHANNEL_ID
  );
}

bot.on("channel_post", async (ctx) => {
  if (!passesChannelFilter(ctx)) return;

  const msg = ctx.update.channel_post;

  const photo = msg.photo?.[msg.photo.length - 1];
  const video = msg.video;
  const doc = msg.document;

  const mediaGroupId = msg.media_group_id;
  const caption = transformContent(normalizeCaption(msg));

  let fileId = null;
  let filename = null;

  if (photo) {
    fileId = photo.file_id;
    filename = `image-${msg.message_id}.jpg`;
  } else if (video) {
    fileId = video.file_id;
    filename = `video-${msg.message_id}.mp4`;
  } else if (doc) {
    fileId = doc.file_id;
    filename = doc.file_name || `file-${msg.message_id}`;
  } else {
    await sendToDiscord({ content: caption || "(no text)", files: [] });
    return;
  }

  const fileUrl = await getTelegramFileUrl(fileId);

  // ---- Album handling ----
  if (mediaGroupId) {
    const key = `${msg.chat.id}:${mediaGroupId}`;
    const existing = albumBuffer.get(key) || { caption: "", items: [], timer: null };

    if (!existing.caption && caption) existing.caption = caption;

    existing.items.push({ url: fileUrl, filename });

    if (existing.timer) clearTimeout(existing.timer);

    existing.timer = setTimeout(async () => {
      albumBuffer.delete(key);

      const files = existing.items.slice(0, 10);

      try {
        await sendToDiscord({
          content: existing.caption || "",
          files
        });
      } catch (e) {
        console.error("Album send failed:", e);
      }
    }, 1500);

    albumBuffer.set(key, existing);
    return;
  }

  await sendToDiscord({
    content: caption || "",
    files: [{ url: fileUrl, filename }]
  });
});

app.post("/telegram-webhook", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.status(200).send("ok"));

app.listen(PORT, async () => {
  console.log(`Listening on :${PORT}`);

  const webhookUrl = `${PUBLIC_URL}/telegram-webhook`;
  await bot.telegram.setWebhook(webhookUrl);
  console.log("Webhook set to:", webhookUrl);
});
