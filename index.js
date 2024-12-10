import Fastify from "fastify";
import dotenv from "dotenv";
import WebSocket from "ws";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import {
  getOpenaiWebsocketInstance,
  sendSessionUpdate,
  LOG_EVENT_TYPES,
  processTranscriptAndSend,
} from "./openai.service.js";


dotenv.config();

// Constants
const PORT = process.env.PORT || 3000;
// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY, WEBHOOK_URL } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Session management
const sessions = new Map();
// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Media Stream Server is running!" });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all("/incoming-call", async (req, res) => {
  console.log("📲 Incoming call");
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Hi, you have called to BoSar Agency. How can we help you today?</Say>
                              <Connect>
                                  <Stream url="wss://${req.headers.host}/media-stream" />
                              </Connect>
                          </Response>`);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    const sessionId =
      req.headers["x-twilio-call-sid"] || `session_${Date.now()}`;
    let session = sessions.get(sessionId) || {
      transcript: "",
      streamSid: null,
    };
    sessions.set(sessionId, session);

    // Get an instance of the OpenAI WebSocket
    const openAiWs = getOpenaiWebsocketInstance();

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("🖇️ Connected to the OpenAI Realtime API");
      setTimeout(async () => {
        await sendSessionUpdate(openAiWs);
      }, 250);
    });

    // Listen for messages from the OpenAI WebSocket
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`📩 Received event: ${response.type}`, response);
        }

        // User message transcription handling
        if (
          response.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          const userMessage = response.transcript.trim();
          session.transcript += `User: ${userMessage}\n`;
          console.log(`🙆🏻‍♂️ User (${sessionId}): ${userMessage}`);
        }

        // Agent message handling
        if (response.type === "response.done") {
          const agentMessage =
            response.response.output[0]?.content?.find(
              (content) => content.transcript
            )?.transcript || "Agent message not found";
          session.transcript += `Agent: ${agentMessage}\n`;
          console.log(`🤖 Agent (${sessionId}): ${agentMessage}`);
        }

        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: session.streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error(
          "❗️ Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };

              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            session.streamSid = data.start.streamSid;
            console.log("Incoming stream has started", session.streamSid);
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("❗️ Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close and log transcript
    connection.on("close", async () => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
      console.log(`⛓️‍💥 Client disconnected (${sessionId}).`);
      console.log("=========================");
      console.log("📋 ===Full Transcript===");
      console.log(session.transcript);
      console.log("=========================");

      // Process the transcript and send it to the webhook
      await processTranscriptAndSend(
        session.transcript,
        WEBHOOK_URL,
        sessionId
      );

      // Clean up the session
      sessions.delete(sessionId);
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("⛓️‍💥 Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("❗️ Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🔥 Server is listening on port ${PORT}`);
});
