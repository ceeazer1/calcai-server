import express from "express";
import openai from "openai";

export function chatgpt() {
  const routes = express.Router();

  const gpt = new openai.OpenAI();

  // simply answer a question
  routes.get("/ask", async (req, res) => {
    const question = req.query.question ?? "";
    if (Array.isArray(question)) {
      res.sendStatus(400);
      return;
    }

    try {
      const result = await gpt.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "Do not use emojis. ",
          },
          { role: "user", content: question },
        ],
        model: "gpt-4o",
      });

      res.send(result.choices[0]?.message?.content ?? "no response");
    } catch (e) {
      console.error(e);
      res.sendStatus(500);
    }
  });

  // New: accept raw JPEG and ask GPT-4o with vision; returns plain text
  routes.post(
    "/ask-image",
    express.raw({ type: ["image/jpeg", "image/jpg"], limit: "5mb" }),
    async (req, res) => {
      try {
        const prompt = String(
          (typeof req.query.prompt === "string" && req.query.prompt) ||
            "Describe and solve any math shown as succinctly as possible."
        );

        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).type("text/plain").send("No image body provided");
          return;
        }

        const encoded_image = req.body.toString("base64");

        const result = await gpt.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "Do not use emojis. Be concise and accurate. If multiple-choice, return just the letter.",
            },
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${encoded_image}` },
                },
              ],
            },
          ],
        });

        const text = result.choices?.[0]?.message?.content?.trim() || "no response";
        res.type("text/plain").send(text);
      } catch (e) {
        console.error(e);
        res.sendStatus(500);
      }
    }
  );

  return routes;
}
