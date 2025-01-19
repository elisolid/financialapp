/***************************************************************
  index.js (ES module, Node 18+)

  Demonstrates:
  - Using OpenAI project-based keys (sk-proj-...)
  - Specifying "organization" and "project" for the new system
  - Fetching a PDF from Airtable, parsing with pdf-parse
  - Splitting text by characters (~1000 chars each)
  - Generating embeddings (text-embedding-ada-002)
  - Simple similarity retrieval
  - Asking a GPT-4O model for an answer
  - Storing answer in "Validation Results" with "Validation Date"
***************************************************************/

import 'dotenv/config';             // loads .env
import fetch from 'node-fetch';     // node-fetch@2
import pdfParse from 'pdf-parse';
import OpenAI from 'openai';        // new openai library v4.x
import Airtable from 'airtable';
import readline from 'readline';

/***************************************************************
  1) gather env vars
***************************************************************/
const {
  OPENAI_API_KEY,
  OPENAI_ORG_ID,
  OPENAI_PROJECT_ID,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID
} = process.env;

// check minimal presence
if (!OPENAI_API_KEY || !OPENAI_ORG_ID || !OPENAI_PROJECT_ID) {
  console.error("Missing OpenAI info. Ensure OPENAI_API_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID are in .env");
  process.exit(1);
}
if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
  console.error("Missing Airtable info. Ensure AIRTABLE_TOKEN, AIRTABLE_BASE_ID are in .env");
  process.exit(1);
}

/***************************************************************
  2) configure openai with new project-based approach
     - organization: "org-BuzjqWPJ1Uq1MjbZY0w13Vmq"
     - project:      "proj_vryVb3mt61QVmTA8IKE5GpS8"
     - apiKey:       "sk-proj-..."
***************************************************************/
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  organization: OPENAI_ORG_ID,
  project: OPENAI_PROJECT_ID
});

/***************************************************************
  3) configure airtable
***************************************************************/
Airtable.configure({ apiKey: AIRTABLE_TOKEN });
const base = Airtable.base(AIRTABLE_BASE_ID);

/***************************************************************
  4) helper: chunk text by ~1000 characters
***************************************************************/
function chunkTextByChars(text, chunkSize = 1000) {
  let chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

/***************************************************************
  5) compute cosine similarity
***************************************************************/
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

/***************************************************************
  6) retrieve top N chunks
***************************************************************/
function retrieveTopChunks(queryEmbedding, chunks, embeddings, topN = 3) {
  let scores = embeddings.map((embed, idx) => {
    return { index: idx, sim: cosineSimilarity(queryEmbedding, embed) };
  });
  scores.sort((a, b) => b.sim - a.sim);
  let top = scores.slice(0, topN).map(s => chunks[s.index]);
  return top;
}

/***************************************************************
  7) main
***************************************************************/
async function main() {
  // We'll prompt user for a question
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("Searching for a PDF in 'Customer Financial Documents' table...");

  // step A: find record with a PDF
  let records = await base("Customer Financial Documents").select({
    maxRecords: 1,
    filterByFormula: `NOT({Document} = '')`
  }).all();

  if (records.length === 0) {
    console.log("No records found with a PDF attachment.");
    process.exit(0);
  }
  let record = records[0];
  let attachments = record.get("Document");
  if (!attachments || attachments.length === 0) {
    console.log("Document field empty.");
    process.exit(0);
  }

  // take the first attachment
  let pdfUrl = attachments[0].url;
  console.log("Found PDF URL:", pdfUrl);

  // step B: fetch the PDF
  let pdfResp = await fetch(pdfUrl);
  if (!pdfResp.ok) {
    throw new Error(`Failed to download PDF: HTTP ${pdfResp.status}`);
  }
  let pdfBuffer = await pdfResp.buffer();

  // step C: parse pdf to text
  let pdfData = await pdfParse(pdfBuffer);
  let pdfText = pdfData.text;
  console.log(`Extracted ${pdfText.length} characters from PDF text.`);

  // step D: chunk the text
  let chunks = chunkTextByChars(pdfText, 1000);
  console.log(`Created ${chunks.length} chunks.`);

  // step E: embed each chunk
  let chunkEmbeddings;
  try {
    let embeddingResp = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: chunks
    });
    // each item => { embedding: number[] }
    chunkEmbeddings = embeddingResp.data.map(d => d.embedding);
  } catch (err) {
    console.error("Error embedding chunks:", err);
    process.exit(1);
  }
  console.log("Embeddings created for chunks.");

  // step F: ask user for question
  rl.question("Enter your question about the PDF: ", async (userQuery) => {
    if (!userQuery) {
      console.log("No question entered, exiting...");
      process.exit(0);
    }

    // embed the user query
    let queryEmbedding;
    try {
      let queryResp = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: [userQuery]
      });
      queryEmbedding = queryResp.data[0].embedding;
    } catch (err) {
      console.error("Error embedding query:", err);
      process.exit(1);
    }

    // retrieve top chunks
    let topChunks = retrieveTopChunks(queryEmbedding, chunks, chunkEmbeddings, 3);
    console.log("Top chunks retrieved. Calling GPT...");

    // step G: call a chat model (like gpt-4o-mini or gpt-4o)
    // Replace "gpt-4o-mini" with an actual model your project has access to
    let systemMessage = "You are an AI reading PDF-based content.";
    let userPrompt = `
CONTEXT SECTIONS:
${topChunks.join("\n---\n")}

USER QUESTION:
${userQuery}

Answer succinctly using only the above context. If unsure, say you don't know.
`.trim();

    let answer;
    try {
      let chatResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",  // or "gpt-4o", "gpt-4o-large", etc. depends on your project
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.0
      });
      // response is array of choices
      answer = chatResp.choices[0].message.content.trim();
    } catch (err) {
      console.error("Error calling GPT model:", err);
      process.exit(1);
    }

    console.log("GPT answer:\n", answer);

    // step H: create new record in "Validation Results"
    try {
      let newRec = await base("Validation Results").create([
        {
          fields: {
            "Validation Result ID": `pdf-rag-demo-${Date.now()}`,
            "Validation Date": new Date().toISOString(),
            "Red flags": answer
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

// run
main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
