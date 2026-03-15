import OpenAI from "openai";

const ALLOWED_ORIGINS = ["https://docs.formulatrinity.ie"];

export default async function handler(req, res) {
  const origin = req.headers.origin || "";

  // CORS preflight
  if (req.method === "OPTIONS") {
    if (ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    return res.status(204).end();
  }

  // Block requests from unlisted origins
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message, threadId } = req.body ?? {};

  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    message.length > 1000
  ) {
    return res
      .status(400)
      .json({ error: "message must be a non-empty string under 1000 chars" });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Reuse thread for multi-turn conversation, or create a new one
  const thread =
    typeof threadId === "string" && threadId.startsWith("thread_")
      ? { id: threadId }
      : await client.beta.threads.create();

  await client.beta.threads.messages.create(thread.id, {
    role: "user",
    content: message.trim(),
  });

  // Stream SSE back to client
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  let sentThreadId = false;

  const stream = client.beta.threads.runs.stream(thread.id, {
    assistant_id: process.env.ASSISTANT_ID,
  });

  stream.on("textDelta", (delta) => {
    if (!sentThreadId) {
      // Send thread ID on the first delta so the client can persist it for
      // follow-up turns within the same session.
      res.write(
        `data: ${JSON.stringify({ threadId: thread.id, text: delta.value })}\n\n`
      );
      sentThreadId = true;
    } else {
      res.write(`data: ${JSON.stringify({ text: delta.value })}\n\n`);
    }
  });

  stream.on("end", () => {
    res.write("data: [DONE]\n\n");
    res.end();
  });

  stream.on("error", (err) => {
    console.error("Stream error:", err);
    res.write(`data: ${JSON.stringify({ error: "Stream error. Please try again." })}\n\n`);
    res.end();
  });
}
