import { GoogleGenAI } from "@google/genai";
import { GEMINI_API_KEY } from "../server/src/config.ts";

const CANDIDATES = ["gemini-3.8-flash", "gemini-flash-latest"];

async function main() {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  for (const model of CANDIDATES) {
    let ok = false;
    for (let i = 1; i <= 3 && !ok; i++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: 'Return JSON {"ok":true}',
          config: { responseMimeType: "application/json" },
        });
        console.log(`WORKS  ${model}  try ${i}  ${res.text?.slice(0, 80)}`);
        ok = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`FAIL   ${model}  try ${i}  ${msg.slice(0, 160).replace(/\n/g, " ")}`);
        await new Promise((r) => setTimeout(r, 2000 * i));
      }
    }
  }
}

main();
