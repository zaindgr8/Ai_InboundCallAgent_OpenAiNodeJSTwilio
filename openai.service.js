import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export function getOpenaiWebsocketInstance() {
  return new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );
}

export const SYSTEM_MESSAGE =
  "You are an AI receptionist for BoSar Agency (AI Automation Agency). Your job is to politely engage with the client and obtain their name, availability, and service/work required (what type of AI agent needs to be developed) and schedule a call to talk details. Ask one question at a time. Do not ask for other contact information, and do not check availability, assume we are free. Be careful with the user's name. If you are not sure, please ask to clarify. Ensure the conversation remains friendly and professional, and guide the user to provide these details naturally. If necessary, ask follow-up questions to gather the required information.";
export const VOICE = "alloy";

// List of Event Types to log to the console
export const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "response.text.done",
  "conversation.item.input_audio_transcription.completed",
];

export async function sendSessionUpdate(connection) {
  const sessionUpdate = {
    type: "session.update",
    session: {
      turn_detection: { type: "server_vad" },
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      voice: VOICE,
      instructions: SYSTEM_MESSAGE,
      modalities: ["text", "audio"],
      temperature: 0.8,
      input_audio_transcription: {
        model: "whisper-1",
      },
    },
  };
  console.log("Sending session update:", JSON.stringify(sessionUpdate));
  connection.send(JSON.stringify(sessionUpdate));
}

// Function to make ChatGPT API completion call with structured outputs
async function makeChatGPTCompletion(transcript) {
  console.log("Starting ChatGPT API call...");
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-08-06",
        messages: [
          {
            role: "system",
            content:
              "Extract customer details: name, availability, and any special notes from the transcript (you can add the customer's problem to the special notes). Return customer's availability as a date in ISO 8601 format. Today's date is " +
              new Date().toLocaleString(),
          },
          { role: "user", content: transcript },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "customer_details_extraction",
            schema: {
              type: "object",
              properties: {
                customerName: { type: "string" },
                customerAvailability: { type: "string" },
                specialNotes: { type: "string" },
              },
              required: [
                "customerName",
                "customerAvailability",
                "specialNotes",
              ],
            },
          },
        },
      }),
    });

    console.log("ChatGPT API response status:", response.status);
    const data = await response.json();
    console.log("Full ChatGPT API response:", JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error("Error making ChatGPT completion call:", error);
    throw error;
  }
}

// Function to send data to Make.com webhook
async function sendToWebhook(url, payload) {
  console.log("Sending data to webhook:", JSON.stringify(payload, null, 2));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("Webhook response status:", response.status);
    if (response.ok) {
      console.log("Data successfully sent to webhook.");
    } else {
      console.error("Failed to send data to webhook:", response.statusText);
    }
  } catch (error) {
    console.error("Error sending data to webhook:", error);
  }
}

// Main function to extract and send customer details
export async function processTranscriptAndSend(
  transcript,
  url,
  sessionId = null
) {
  console.log(`Starting transcript processing for session ${sessionId}...`);
  try {
    // Make the ChatGPT completion call
    const result = await makeChatGPTCompletion(transcript);

    console.log("Raw result from ChatGPT:", JSON.stringify(result, null, 2));

    if (
      result.choices &&
      result.choices[0] &&
      result.choices[0].message &&
      result.choices[0].message.content
    ) {
      try {
        const parsedContent = JSON.parse(result.choices[0].message.content);
        console.log("Parsed content:", JSON.stringify(parsedContent, null, 2));

        if (parsedContent) {
          // Send the parsed content directly to the webhook
          await sendToWebhook(url, parsedContent);
          console.log("Extracted and sent customer details:", parsedContent);
        } else {
          console.error("Unexpected JSON structure in ChatGPT response");
        }
      } catch (parseError) {
        console.error("Error parsing JSON from ChatGPT response:", parseError);
      }
    } else {
      console.error("Unexpected response structure from ChatGPT API");
    }
  } catch (error) {
    console.error("Error in processTranscriptAndSend:", error);
  }
}
