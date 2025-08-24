# CalcAI Server (Fly.io-ready)

This service acts as both the API server and an HTTP relay-friendly endpoint for ESP32 devices.

- GET /gpt/ask?question=...
- POST /gpt/ask-image (Content-Type: image/jpeg; optional ?prompt=...)

Run locally:
- npm install
- npm start

Deploy to Fly.io:
- fly launch (answer prompts)
- fly deploy
- Set OPENAI_API_KEY in Fly.io secrets: fly secrets set OPENAI_API_KEY=sk-...

