/**************************************************************
 index.js (CommonJS) - character-based chunking, no tiktoken

 This script:
   1) Reads a record from "Customer Financial Documents" in Airtable 
      using AIRTABLE_TOKEN.
   2) Downloads a PDF from the "Document" field.
   3) Parses text with pdf-parse.
   4) Splits text into ~1000-char chunks (no token counting).
   5) Creates embeddings for each chunk, retrieves the most relevant ones
      for a user query, then uses GPT-4 to produce a final answer.
   6) Stores the answer in "Validation Results" with "Validation Date."

 Environment variables (in .env):
   OPENAI_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID

 Usage:
   node index.js
**************************************************************/

require('dotenv/config');
const fetch = require('node-fetch'); // node-fetch@2
const pdfParse = require('pdf-parse');
const { Configuration, OpenAIApi } = require('openai');
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
  2) helper: chunk text by character length (~1000 chars)
     no token-based chunking
**************************************************************/
function chunkTextByChars(text, chunkSize = 1000) {
  let chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
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
  // each item => { embedding: number[] }
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
  5) retrieve top N chunks
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
  main
**************************************************************/
async function main() {
  console.log("Looking for a record in 'Customer Financial Documents'...");

  // step A: get a record with a PDF
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

  // step D: chunk ~1000 chars each
  const chunks = chunkTextByChars(pdfText, 1000);
  console.log(`Created ${chunks.length} chunks.`);

  // embed each chunk
  let chunkEmbeddings;
  try {
    chunkEmbeddings = await getEmbeddingsForChunks(chunks);
  } catch (err) {
    console.error("Error getting embeddings:", err.response?.data || err);
    process.exit(1);
  }

  console.log("Obtained chunk embeddings.");

  // step E: ask user for question
  rl.question("Enter your question about the PDF: ", async (userQuery) => {
    if (!userQuery) {
      console.log("No question entered, exiting...");
      process.exit(0);
    }

    // embed the question
    let queryEmbedding;
    try {
      const queryResp = await openai.createEmbedding({
        model: "text-embedding-ada-002",
        input: [userQuery]
      });
      queryEmbedding = queryResp.data.data[0].embedding;
    } catch (err) {
      console.error("Error embedding query:", err.response?.data || err);
      process.exit(1);
    }

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

    // step F: call GPT-4
    let chatResp;
    try {
      chatResp = await openai.createChatCompletion({
        model: "gpt-4", // or "gpt-3.5-turbo" if needed
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
