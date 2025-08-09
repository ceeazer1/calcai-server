import express from "express";
import openai from "openai";
import i264 from "image-to-base64";
import Jimp from "jimp";

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

  // existing: solve a math equation from an image (now ensures raw body parsing here)
  routes.post(
    "/solve",
    express.raw({ type: ["image/jpeg", "image/jpg"], limit: "5mb" }),
    async (req, res) => {
      try {
        const contentType = req.headers["content-type"];
        console.log("content-type:", contentType);

        if (!contentType || !contentType.startsWith("image/")) {
          res.status(400);
          res.send(`bad content-type: ${contentType}`);
          return;
        }

        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).type("text/plain").send("No image body provided");
          return;
        }

        const image_data = await new Promise((resolve, reject) => {
          Jimp.read(req.body, (err, value) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(value);
          });
        });

        const image_path = "./to_solve.jpg";
        await image_data.writeAsync(image_path);
        const encoded_image = await i264(image_path);
        console.log("Encoded Image: ", encoded_image.length, "bytes");
        console.log(encoded_image.substring(0, 100));

        const question_number = req.query.n;
        const question = question_number
          ? `What is the answer to question ${question_number}?`
          : "What is the answer to this question?";

        console.log("prompt:", question);

        const result = await gpt.chat.completions.create({
          messages: [
            {
              role: "system",
              content:
                "You are a helpful math tutor, specifically designed to help with basic arithmetic, but also can answer a broad range of math questions from uploaded images. You should provide answers as succinctly as possible. Be as accurate as possible.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${question} Do not explain how you found the answer. If the question is multiple-choice, give the letter answer.`,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${encoded_image}`,
                    detail: "high",
                  },
                },
              ],
            },
          ],
          model: "gpt-4o",
        });

        res.send(result.choices[0]?.message?.content ?? "no response");
      } catch (e) {
        console.error(e);
        res.sendStatus(500);
      }
    }
  );

  return routes;
}
