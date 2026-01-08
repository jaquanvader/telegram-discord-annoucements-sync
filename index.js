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

// Parse JSON even if Content-Type is weird/missing (prevents req.body undefined)
app.use(express.json({ type: "*/*" }));

// ---- Telegram CTA only ----
const TELEGRAM_CONTACT_URL =
  process.env.TELEGRAM_CONTACT_URL || "https://t.me/splitthepicks";

function telegramFooter() {
  return `Message me on telegram:\n👉 ${TELEGRAM_CONTACT_URL}`;
}




function transformContent(raw) {
  if (!raw) return raw;

  let text = raw;

  // Remove malformed https://@username junk ONLY
  text = text.replace(/https?:\/\/@\S+/gi, "");

  // Replace @splitthepicks inline with the Telegram link (space prevents emoji bleed)
  const inline = `${TELEGRAM_CONTACT_URL} `;
  text = text.replace(/@splitthepicks\b/gi, inline);
  text = text.replace(/@vegaskiller\b/gi, inline); // optional

  // Normalize DM arrow spacing
  text = text.replace(/DM\s*👉\s*/gi, "DM👉 ");

  // ---- Bold the FIRST line only ----
  const lines = text.split("\n");
  if (lines[0]?.trim()) {
    lines[0] = `**${lines[0].trim()}**`;
  }
  text = lines.join("\n");

  // ---- Append footer ONLY if link is not already present ----
  if (!/https?:\/\/t\.me\/splitthepicks/i.test(text)) {
    text += `\n\n${telegramFooter()}`;
  }

  return text;
}









// ---- Album buffering (media_group_id) ----
const albumBuffer = new Map(); // key -> { caption, items: [], timer }

function normalizeCaption(msg) {
  return msg?.caption || msg?.text || "";
}

function passesChannelFilter(ctx) {
  const chat = ctx.update?.channel_post?.chat;
  if (!chat) return false;

  const channelUsername = chat.username ? `@${chat.username}` : null;
  const channelId = chat.id?.toString();

  const allowedChannels = [
    process.env.TELEGRAM_CHANNEL_ID,
    process.env.TELEGRAM_CHANNEL_ID_TEST
  ].filter(Boolean); // remove undefined

  // Allow if username OR numeric ID matches any allowed channel
  return allowedChannels.some(
    (allowed) => allowed === channelUsername || allowed === channelId
  );
}


// Build a Telegram file URL (Telegram hosts files at this URL)
async function getTelegramFileUrl(fileId) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const j = await r.json();
  const filePath = j?.result?.file_path;
  if (!filePath) throw new Error("Could not resolve Telegram file path");
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
}

async function sendToDiscord({ content, files }) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: (content || "").slice(0, 1900) }));

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
    // Pure text post
    await sendToDiscord({ content: caption || "(no text)", files: [] });
    return;
  }

  const fileUrl = await getTelegramFileUrl(fileId);

  // ---- Album handling ----
  if (mediaGroupId) {
    const key = `${msg.chat.id}:${mediaGroupId}`;
    const existing = albumBuffer.get(key) || { caption: "", items: [], timer: null };

    // Keep first non-empty caption (already transformed)
    if (!existing.caption && caption) existing.caption = caption;

    existing.items.push({ url: fileUrl, filename });

    if (existing.timer) clearTimeout(existing.timer);

    existing.timer = setTimeout(async () => {
      albumBuffer.delete(key);

      // Discord file count/size limits—keep it reasonable
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

  // Single media post
  await sendToDiscord({
    content: caption || "",
    files: [{ url: fileUrl, filename }]
  });
});

// Telegram webhook endpoint (robust against undefined body)
app.post("/telegram-webhook", (req, res) => {
  try {
    const update = req.body;

    if (!update || typeof update !== "object") {
      console.error("Telegram webhook: missing/invalid JSON body");
      return res.sendStatus(400);
    }

    if (update.update_id === undefined) {
      console.error("Telegram webhook: unexpected payload:", JSON.stringify(update).slice(0, 500));
      return res.sendStatus(400);
    }

    // Pass res in webhook mode
    return bot.handleUpdate(update, res);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(500);
  }
});

// Health check
app.get("/", (req, res) => res.status(200).send("ok"));

app.listen(PORT, async () => {
  console.log(`Listening on :${PORT}`);

  const webhookUrl = `${PUBLIC_URL}/telegram-webhook`;
  await bot.telegram.setWebhook(webhookUrl);
  console.log("Webhook set to:", webhookUrl);
});
