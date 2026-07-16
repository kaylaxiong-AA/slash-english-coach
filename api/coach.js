const crypto = require("node:crypto");
const OpenAI = require("openai");

const buckets = new Map();

function sameSecret(received, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(received || ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function allowRequest(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const current = buckets.get(ip);
  if (!current || now - current.startedAt > hour) {
    buckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 30;
}

const feedbackSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "dimensions", "summary", "strengths", "corrections", "improved_answer", "next_action"],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    dimensions: {
      type: "object",
      additionalProperties: false,
      required: ["grammar", "vocabulary", "clarity", "naturalness"],
      properties: {
        grammar: { type: "integer", minimum: 0, maximum: 100 },
        vocabulary: { type: "integer", minimum: 0, maximum: 100 },
        clarity: { type: "integer", minimum: 0, maximum: 100 },
        naturalness: { type: "integer", minimum: 0, maximum: 100 }
      }
    },
    summary: { type: "string" },
    strengths: { type: "array", maxItems: 3, items: { type: "string" } },
    corrections: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original", "corrected", "explanation_cn"],
        properties: {
          original: { type: "string" },
          corrected: { type: "string" },
          explanation_cn: { type: "string" }
        }
      }
    },
    improved_answer: { type: "string" },
    next_action: { type: "string" }
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "只支持POST请求。" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "服务器尚未配置OPENAI_API_KEY。" });
  if (!sameSecret(req.headers["x-app-code"], process.env.COACH_ACCESS_CODE)) return res.status(401).json({ error: "访问码不正确。" });

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!allowRequest(ip)) return res.status(429).json({ error: "本小时AI点评次数已达到上限，请稍后再试。" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: "请求格式不正确。" }); }
  }
  const type = body?.type === "speaking" ? "speaking" : body?.type === "writing" ? "writing" : null;
  const answer = String(body?.answer || "").trim().slice(0, 5000);
  if (!type || answer.length < 5) return res.status(400).json({ error: "缺少有效的练习内容。" });

  const input = {
    exercise_type: type,
    learner_level: String(body?.level || "A2"),
    topic: String(body?.topic || "English practice").slice(0, 120),
    task: String(body?.prompt || "").slice(0, 1000),
    reference_material: String(body?.reference || "").slice(0, 4000),
    learner_answer: answer
  };

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.responses.create({
      model: process.env.OPENAI_COACH_MODEL || "gpt-5.6-luna",
      store: false,
      max_output_tokens: 1400,
      reasoning: { effort: "low" },
      instructions: [
        "You are a precise and encouraging English coach for a Chinese adult learner.",
        "Evaluate only the learner answer against the task and stated CEFR-like level.",
        "Explain corrections in concise Simplified Chinese; keep corrected English natural and useful for work.",
        "For speaking input, the answer is a transcript. Do not claim to assess accent, stress, or acoustic pronunciation.",
        "Prefer two or three high-value corrections over trivial stylistic changes.",
        "Return only the requested structured result."
      ].join(" "),
      input: JSON.stringify(input),
      text: {
        format: {
          type: "json_schema",
          name: "english_coach_feedback",
          strict: true,
          schema: feedbackSchema
        }
      }
    });

    const feedback = JSON.parse(response.output_text);
    return res.status(200).json({ feedback, model: process.env.OPENAI_COACH_MODEL || "gpt-5.6-luna" });
  } catch (error) {
    console.error("AI coach error", error);
    return res.status(500).json({ error: "AI点评暂时失败，请稍后重试。" });
  }
};
