import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import morgan from "morgan";
import dot from "dotenv";
import { chatgpt } from "./routes/chatgpt.mjs";
import { images } from "./routes/images.mjs";
import { chat } from "./routes/chat.mjs";
import { programs } from "./routes/programs.mjs";
import { googleApi } from "./routes/googleApi.mjs";
dot.config();

const app = express();
app.use(morgan("dev"));
app.use(cors("*"));
app.use(
  bodyParser.raw({
    type: "image/jpg",
    limit: "10mb",
  })
);
app.use((req, res, next) => {
  console.log(req.headers.authorization);
  next();
});

// Root route
app.get("/", (req, res) => {
  res.json({
    status: "CalcAI Server is running",
    timestamp: new Date().toISOString(),
    endpoints: ["/gpt/ask", "/programs/list", "/chats/messages", "/image/list"]
  });
});

// Favicon routes to prevent 404s
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/favicon.png", (req, res) => {
  res.status(204).end();
});

// Programs
app.use("/programs", programs());

// OpenAI API
chatgpt().then(gptRoutes => {
  app.use("/gpt", gptRoutes);
});

// Google API
//app.use("/google", await googleApi());

// Chat
app.use("/chats", chat());

// Images
app.use("/image", images());

// For local development
if (process.env.NODE_ENV !== 'production') {
  const port = +(process.env.PORT ?? 8080);
  app.listen(port, () => {
    console.log(`listening on ${port}`);
  });
}

// Export for Vercel
export default app;