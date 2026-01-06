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
  if (!raw) return raw;

  let text = raw;

  // Remove malformed https://@username junk ONLY
  text = text.replace(/https?:\/\/@\S+/gi, "");

  // Replace @splitthepicks with Discord mention ONLY
  text = text.replace(/@splitthepicks\b/gi, `<@${DISCORD_CONTACT_USER_ID}>`);

  // If you ALSO want to replace @VEGASKILLER in that DM line, keep this line:
  text = text.replace(/@vegaskiller\b/gi, `<@${DISCORD_CONTACT_USER_ID}>`);

  // Append Telegram footer once
  if (!/t\.me\/splitthepicks/i.test(text)) {
    text += `

You can contact @splitthepicks right away on Telegram:
${TELEGRAM_CONTACT_URL}`;
  }

  return text;
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

// Telegram webhook: parse JSON ONLY for this route
app.post("/telegram-webhook", express.json(), (req, res) => {
  try {
    // Telegram should send an update object with update_id
    if (!req.body || typeof req.body !== "object") {
      console.error("Webhook received non-JSON body:", typeof req.body);
      return res.sendStatus(400);
    }

    if (req.body.update_id === undefined) {
      console.error("Webhook received unexpected payload:", JSON.stringify(req.body).slice(0, 500));
      return res.sendStatus(400);
    }

    bot.handleUpdate(req.body);
    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(500);
  }
});

