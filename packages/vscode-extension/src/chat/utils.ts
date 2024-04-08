// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  CancellationToken,
  ChatRequest,
  ChatResponseStream,
  LanguageModelChatMessage,
  LanguageModelChatSystemMessage,
  LanguageModelChatUserMessage,
  lm,
} from "vscode";

import { sampleProvider } from "@microsoft/teamsfx-core";
import { BaseTokensPerCompletion, BaseTokensPerMessage, BaseTokensPerName } from "./consts";
import { buildDynamicPrompt } from "./dynamicPrompt";
import { inputRai, outputRai } from "./dynamicPrompt/formats";
import { Tokenizer } from "./tokenizer";

export async function verbatimCopilotInteraction(
  model: "copilot-gpt-3.5-turbo" | "copilot-gpt-4",
  messages: LanguageModelChatMessage[],
  response: ChatResponseStream,
  token: CancellationToken
) {
  const chatRequest = await lm.sendChatRequest(model, messages, {}, token);
  for await (const fragment of chatRequest.stream) {
    response.markdown(fragment);
  }
}

export async function getCopilotResponseAsString(
  model: "copilot-gpt-3.5-turbo" | "copilot-gpt-4",
  messages: LanguageModelChatMessage[],
  token: CancellationToken
): Promise<string> {
  const chatRequest = await lm.sendChatRequest(model, messages, {}, token);
  let response = "";
  for await (const fragment of chatRequest.stream) {
    response += fragment;
  }
  return response;
}

export async function getSampleDownloadUrlInfo(sampleId: string) {
  const sampleCollection = await sampleProvider.SampleCollection;
  const sample = sampleCollection.samples.find((sample) => sample.id === sampleId);
  if (!sample) {
    throw new Error("Sample not found");
  }
  return sample.downloadUrlInfo;
}

// count message token for GPT3.5 and GPT4 message
// refer to vscode copilot tokenizer solution
export function countMessageTokens(message: LanguageModelChatMessage): number {
  let numTokens = BaseTokensPerMessage;
  const tokenizer = Tokenizer.getInstance();
  for (const [key, value] of Object.entries(message)) {
    if (!value) {
      continue;
    }
    numTokens += tokenizer.tokenLength(value);
    if (key === "name") {
      numTokens += BaseTokensPerName;
    }
  }
  return numTokens;
}

export function countMessagesTokens(messages: LanguageModelChatMessage[]): number {
  let numTokens = 0;
  for (const message of messages) {
    numTokens += countMessageTokens(message);
  }
  numTokens += BaseTokensPerCompletion;
  return numTokens;
}

export async function purifyUserMessage(
  message: string,
  token: CancellationToken
): Promise<string> {
  const userMessagePrompt = `
  Please help to rephrase the following meesage in a more accurate and professional way. Message: ${message}
  `;
  const systemPrompt = `
  You should only return the rephrased message, without any explanation or additional information.
  `;
  const purifyUserMessage = [
    new LanguageModelChatUserMessage(userMessagePrompt),
    new LanguageModelChatSystemMessage(systemPrompt),
  ];
  const purifiedResult = await getCopilotResponseAsString(
    "copilot-gpt-4",
    purifyUserMessage,
    token
  );
  if (
    !purifiedResult ||
    purifiedResult.length === 0 ||
    purifiedResult.indexOf("Sorry, I can't") === 0
  ) {
    return message;
  }
  return purifiedResult;
}

export async function isInputHarmful(
  request: ChatRequest,
  token: CancellationToken
): Promise<boolean> {
  const messages = buildDynamicPrompt(inputRai, request.prompt).messages;
  let response = await getCopilotResponseAsString("copilot-gpt-4", messages, token);
  if (!response) {
    throw new Error("Got empty response");
  }

  const separatorIndex = response.indexOf("```");
  if (separatorIndex >= 0) {
    response = response.substring(0, separatorIndex);
  }
  const resultJson = JSON.parse(response);

  if (typeof resultJson.isHarmful !== "boolean") {
    throw new Error(`Failed to parse response: isHarmful is not a boolean.`);
  }

  return resultJson.isHarmful;
}

export async function isOutputHarmful(output: string, token: CancellationToken): Promise<boolean> {
  const messages = buildDynamicPrompt(outputRai, output).messages;
  return await isContentHarmful(messages, token);
}

async function isContentHarmful(
  messages: LanguageModelChatMessage[],
  token: CancellationToken
): Promise<boolean> {
  async function getIsHarmfulResponseAsync() {
    const isHarmfulResponse = await getCopilotResponseAsString("copilot-gpt-4", messages, token);
    if (
      !isHarmfulResponse ||
      isHarmfulResponse === "" ||
      isHarmfulResponse.indexOf("Sorry, I can't") === 0
    ) {
      return true;
    }
    return Number.parseInt(isHarmfulResponse) > 15; // This is a number we have to tune.
  }
  const promises = Array(1)
    .fill(null)
    .map(() => getIsHarmfulResponseAsync());
  const results = await Promise.all(promises);
  const isHarmful = results.filter((result) => result === true).length > 0;
  return isHarmful;
}