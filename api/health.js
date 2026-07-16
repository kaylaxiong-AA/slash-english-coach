module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  return res.status(200).json({
    online: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    accessCodeRequired: Boolean(process.env.COACH_ACCESS_CODE)
  });
};
