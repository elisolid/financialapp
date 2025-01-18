/**************************************************************
 index.js (CommonJS version) 
 Uses tiktoken.encodingForModel("gpt-4") or "gpt-3.5-turbo" for chunking.

 This script:
   1) Reads a record from "Customer Financial Documents" in Airtable 
      using your personal access token (AIRTABLE_TOKEN).
   2) Downloads the PDF file from the "Document" field.
   3) Parses the PDF text (pdf-parse).
   4) Splits and embeds the text for retrieval-based question answering.
   5) Uses GPT-4 (or gpt-3.5-turbo/gpt-4o) to answer based on top chunks.
   6) Writes the answer into "Validation Results" with "Validation Date".

 Environment variables in .env:
   OPENAI_API_KEY
   AIRTABLE_TOKEN
   AIRTABLE_BASE_ID

 Usage:
   node index.js
   (It prompts for a question about the PDF)
**************************************************************/

require('dotenv/config');
const fetch = require('node-fetch'); // node-fetch@2
const pdfParse = require('pdf-parse');
const { Configuration, OpenAIApi } = require('openai');
const { encodingForModel } = require('tiktoken');
const Airtable = require('airtable');
const readline = require('readline');

/**************************************************************
  1) read env vars
**************************************************************/
const { OPENAI_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID } = process.env;
if (!OPENAI_API_KEY || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
  console.error("Missing required env vars (OPENAI_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID).");
  process.exit(1);
}

// openai config
const openaiConfig = new Configuration({ apiKey: OPENAI_API_KEY });
const openai = new OpenAIApi(openaiConfig);

// airtable config
Airtable.configure({ apiKey: AIRTABLE_TOKEN });
const base = Airtable.base(AIRTABLE_BASE_ID);

// for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**************************************************************
  2) helper: chunk text by approximate token count
     using encodingForModel("gpt-3.5-turbo") or "gpt-4"
**************************************************************/
function chunkText(text, chunkSize = 500) {
  // pick whichever model's encoding you want
  // "gpt-3.5-turbo" or "gpt-4" both typically use cl100k_base under the hood.
  const encoder = encodingForModel("gpt-3.5-turbo");

  const paragraphs = text.split("\n\n");
  let chunks = [];
  let currentTokens = [];
  let tokenCount = 0;

  for (let para of paragraphs) {
    let tokens = encoder.encode(para);

    // if adding these tokens to the current chunk exceeds chunkSize, finalize current chunk
    if (tokenCount + tokens.length > chunkSize) {
      chunks.push(encoder.decode(currentTokens));
      currentTokens = tokens;
      tokenCount = tokens.length;
    } else {
      // accumulate tokens in current chunk
      currentTokens.push(...tokens);
      tokenCount += tokens.length;
    }
  }

  // push final chunk
  if (currentTokens.length > 0) {
    chunks.push(encoder.decode(currentTokens));
  }

  return chunks;
}

/**************************************************************
  3) get embeddings for an array of strings
**************************************************************/
async function getEmbeddingsForChunks(chunks) {
  const response = await openai.createEmbedding({
    model: "text-embedding-ada-002",
    input: chunks
  });
  // each item in response.data.data => { embedding: number[] }
  return response.data.data.map(item => item.embedding);
}

/**************************************************************
  4) compute cosine similarity
**************************************************************/
function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**************************************************************
  5) retrieve top N chunks by similarity
**************************************************************/
function retrieveTopChunks(queryEmbedding, chunks, embeddings, topN = 3) {
  const scores = embeddings.map((embed, idx) => {
    return { index: idx, sim: cosineSimilarity(queryEmbedding, embed) };
  });
  scores.sort((a, b) => b.sim - a.sim);
  const top = scores.slice(0, topN).map(s => chunks[s.index]);
  return top;
}

/**************************************************************
  main logic
**************************************************************/
async function main() {
  console.log("Looking for a record in 'Customer Financial Documents'...");

  // step A: get a record with a PDF attachment
  const records = await base("Customer Financial Documents").select({
    maxRecords: 1,
    filterByFormula: `NOT({Document} = '')`
  }).all();

  if (records.length === 0) {
    console.log("No records found with a PDF attachment.");
    process.exit(0);
  }

  const record = records[0];
  const attachments = record.get("Document");
  if (!attachments || attachments.length === 0) {
    console.log("Document field is empty for that record.");
    process.exit(0);
  }

  const pdfUrl = attachments[0].url;
  console.log("Found PDF URL:", pdfUrl);

  // step B: download pdf
  const pdfResp = await fetch(pdfUrl);
  if (!pdfResp.ok) {
    throw new Error(`Failed to download PDF: HTTP ${pdfResp.status}`);
  }
  const pdfBuffer = await pdfResp.buffer();

  // step C: parse pdf
  const pdfData = await pdfParse(pdfBuffer);
  const pdfText = pdfData.text;
  console.log(`Extracted ${pdfText.length} characters from PDF text.`);

  // step D: chunk & embed
  const chunks = chunkText(pdfText, 500);
  console.log(`Created ${chunks.length} chunks.`);
  const chunkEmbeddings = await getEmbeddingsForChunks(chunks);
  console.log("Obtained chunk embeddings.");

  // step E: ask user for question
  rl.question("Enter your question about the PDF: ", async (userQuery) => {
    if (!userQuery) {
      console.log("No question entered, exiting...");
      process.exit(0);
    }

    // embed the question
    const queryResp = await openai.createEmbedding({
      model: "text-embedding-ada-002",
      input: [userQuery]
    });
    const queryEmbedding = queryResp.data.data[0].embedding;

    // retrieve top chunks
    const topChunks = retrieveTopChunks(queryEmbedding, chunks, chunkEmbeddings, 3);
    console.log(`Retrieved top ${topChunks.length} chunks. Calling GPT-4 for final answer...`);

    // system + user messages
    const systemMessage = "You are an AI reading PDF-based content.";
    const userPrompt = `
CONTEXT SECTIONS:
${topChunks.join("\n---\n")}

USER QUESTION:
${userQuery}

Answer succinctly using only the above context. If unsure, say you don't know.
`.trim();

    // step F: call GPT-4 (or gpt-4o, or gpt-3.5-turbo)
    let chatResp;
    try {
      chatResp = await openai.createChatCompletion({
        model: "gpt-4", // or "gpt-4o" if you have it, or "gpt-3.5-turbo"
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.0
      });
    } catch (err) {
      console.error("Error calling GPT model:", err.response?.data || err);
      process.exit(1);
    }

    const finalAnswer = chatResp.data.choices[0].message.content.trim();
    console.log("GPT-4 answer:\n", finalAnswer);

    // step G: create new record in "Validation Results"
    try {
      const result = await base("Validation Results").create([
        {
          fields: {
            "Validation Result ID": `pdf-rag-demo-${Date.now()}`,
            "Validation Date": new Date().toISOString(),
            "Red flags": finalAnswer
          }
        }
      ]);
      console.log("Created new record in 'Validation Results':", result[0].getId());
    } catch (err) {
      console.error("Error writing to Validation Results:", err);
    }

    // done
    process.exit(0);
  });
}

// run main
main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
