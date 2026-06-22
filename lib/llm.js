import OpenAI from "openai";

let sharedClient;

export function getLlmClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  if (!sharedClient) {
    sharedClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  return sharedClient;
}

export function getLlmModel() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

export async function createChatCompletion(options, client = getLlmClient()) {
  return client.chat.completions.create({
    model: getLlmModel(),
    ...options
  });
}
