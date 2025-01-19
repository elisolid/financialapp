/**************************************************************
 index.js (ES module using pdf-parse version 1.1.1)

 This script:
   1) Reads a record from "Customer Financial Documents" in Airtable.
   2) Downloads the PDF from the "Document" field.
   3) Parses the PDF text using pdf-parse.
   4) Splits the text into ~1000-character chunks.
   5) Creates embeddings for each chunk.
   6) Retrieves the most relevant chunks for a user query and calls GPT.
   7) Stores the final answer in "Validation Results" with "Validation Date."
***************************************************************/

import 'dotenv/config';
import fetch from 'node-fetch';     // node-fetch@2
import pdfParse from 'pdf-parse';
import OpenAI from "openai";         // OpenAI Node library v4.x
import Airtable from 'airtable';
import readline from 'readline';

/**************************************************************
 1) Load environment variables from .env
**************************************************************/
const {
  OPENAI_API_KEY,
  OPENAI_ORG_ID,
  OPENAI_PROJECT_ID,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID
} = process.env;

if (!OPENAI_API_KEY || !OPENAI_ORG_ID || !OPENAI_PROJECT_ID) {
  console.error("Missing required OpenAI env vars.");
  process.exit(1);
}
if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
  console.error("Missing required Airtable env vars.");
  process.exit(1);
}

/**************************************************************
 2) Configure OpenAI using project-based keys
**************************************************************/
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  organization: OPENAI_ORG_ID,
  project: OPENAI_PROJECT_ID
});

/**************************************************************
 3) Configure Airtable
**************************************************************/
Airtable.configure({ apiKey: AIRTABLE_TOKEN });
const base = Airtable.base(AIRTABLE_BASE_ID);

/**************************************************************
 4) Helper: Chunk text by approximately 1000 characters
**************************************************************/
function chunkTextByChars(text, chunkSize = 1000) {
  let chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

/**************************************************************
 5) Compute cosine similarity for embeddings
**************************************************************/
function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**************************************************************
 6) Retrieve top N chunks by similarity
**************************************************************/
function retrieveTopChunks(queryEmbedding, chunks, embeddings, topN = 3) {
  const scores = embeddings.map((embed, idx) => ({
    index: idx,
    sim: cosineSimilarity(queryEmbedding, embed)
  }));
  scores.sort((a, b) => b.sim - a.sim);
  return scores.slice(0, topN).map(s => chunks[s.index]);
}

/**************************************************************
 7) Main function
**************************************************************/
async function main() {
  console.log("Looking for a record in 'Customer Financial Documents'...");

  // A: Get a record with a PDF attachment.
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

  // B: Download the PDF.
  const pdfResp = await fetch(pdfUrl);
  if (!pdfResp.ok) {
    throw new Error(`Failed to download PDF: HTTP ${pdfResp.status}`);
  }
  const pdfBuffer = await pdfResp.buffer();
  console.log("pdfBuffer length:", pdfBuffer.length);

  // C: Parse PDF text.
  let pdfData;
  try {
    pdfData = await pdfParse(pdfBuffer);
  } catch (err) {
    console.error("Error parsing PDF:", err);
    process.exit(1);
  }
  const pdfText = pdfData.text;
  console.log(`Extracted ${pdfText.length} characters from PDF text.`);

  // D: Chunk the PDF text by characters.
  const chunks = chunkTextByChars(pdfText, 1000);
  console.log(`Created ${chunks.length} chunks.`);

  // E: Generate embeddings for each chunk.
  let chunkEmbeddings;
  try {
    const embeddingResp = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: chunks
    });
    // Expecting an array of objects with property 'embedding'
    chunkEmbeddings = embeddingResp.data.map(item => item.embedding);
  } catch (err) {
    console.error("Error getting embeddings:", err.response?.data || err);
    process.exit(1);
  }
  console.log("Obtained embeddings for chunks.");

  // F: Ask user for a question.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Enter your question about the PDF: ", async (userQuery) => {
    if (!userQuery) {
      console.log("No question entered, exiting...");
      process.exit(0);
    }

    // Embed the user's query.
    let queryEmbedding;
    try {
      const queryResp = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: [userQuery]
      });
      queryEmbedding = queryResp.data[0].embedding;
    } catch (err) {
      console.error("Error embedding query:", err.response?.data || err);
      process.exit(1);
    }

    // Retrieve the top 3 chunks most relevant to the query.
    const topChunks = retrieveTopChunks(queryEmbedding, chunks, chunkEmbeddings, 3);
    console.log("Retrieved top chunks. Calling GPT for final answer...");

    const systemMessage = "You are an AI reading PDF-based content.";
    const userPrompt = `
CONTEXT SECTIONS:
${topChunks.join("\n---\n")}

USER QUESTION:
${userQuery}

Answer succinctly using only the above context. If unsure, say you don't know.
`.trim();

    // G: Call the chat completion endpoint. Adjust model if necessary.
    let chatResp;
    try {
      chatResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",  // change to the model available to your project if needed.
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
    const finalAnswer = chatResp.choices[0].message.content.trim();
    console.log("GPT answer:\n", finalAnswer);

    // H: Create a new record in "Validation Results".
    try {
      const newRec = await base("Validation Results").create([
        {
          fields: {
            "Validation Result ID": `pdf-rag-demo-${Date.now()}`,
            "Validation Date": new Date().toISOString(),
            "Red flags": finalAnswer
          }
        }
      ]);
      console.log("Created new record in Validation Results:", newRec[0].getId());
    } catch (err) {
      console.error("Error writing to Validation Results:", err);
    }
    process.exit(0);
  });
}

// Run main
main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
