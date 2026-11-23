import { NextRequest, NextResponse } from "next/server";
import { getStoreProducts } from "@/lib/products";

export const dynamic = "force-dynamic";
// Run the function close to Pakistan (Mumbai) instead of the default US region
export const preferredRegion = "bom1";
export const maxDuration = 30;

// ---- Product cache: avoid re-fetching the Google Sheet on every message ----
const CACHE_TTL_MS = 60 * 1000; // refresh sheet data at most once per minute
let cachedCatalog: { text: string; time: number } | null = null;

async function getCatalogText(): Promise<string> {
  if (cachedCatalog && Date.now() - cachedCatalog.time < CACHE_TTL_MS) {
    return cachedCatalog.text;
  }

  const { allProducts } = await getStoreProducts();

  const text = allProducts
    .map(
      (p) =>
        `* ${p.title}
  - Category: ${p.category || "General"}
  - Price: $${p.price}
  - Stock Status: ${p.stockStatus || "in stock"}
  - Description: ${p.description || "N/A"}
  - Store Page Link: /shop/product/${p.id}/${encodeURIComponent(
          p.title.split(" ").join("-")
        )}`
    )
    .join("\n\n");

  cachedCatalog = { text, time: Date.now() };
  return text;
}

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "Messages array is required." },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is not set");
      return NextResponse.json(
        { error: "Chat is not configured." },
        { status: 500 }
      );
    }
    const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

    const catalogList = await getCatalogText();

    const systemInstruction = `You are the official AI Shopping Assistant for "Shop.co", a trendy and modern fashion and lifestyle store.

CORE RULES:
1. BE POLITE & COURTEOUS: Always communicate warmly, respectfully, and politely.
2. BE CONCISE: Deliver clear, direct, and compact answers.
3. STRICT LENGTH LIMIT: The maximum size of your answer MUST NOT exceed 50 words under any circumstance.
4. FOLLOW SHEET PRICES STRICTLY: Always cite the exact price listed in the inventory below. Never round, discount without authorization, or alter prices.
5. NEVER GUESS OR ASSUME: Only provide information that is explicitly stated in the inventory. If an item, price, size, or detail is not in the inventory, politely state that we do not have it. Never invent, hallucinate, or guess.
6. STOCK & LINKS: Always specify if an item is "in stock" or "out of stock", and format product mentions as Markdown links: [Product Name](/shop/product/id/slug).
7. IMMEDIATE SUPPORT ESCALATION (test@gmail.com): For issues such as order cancellations, shipping delays, tracking issues, damaged items, or refund disputes, IMMEDIATELY offer our customer support email: test@gmail.com. Do not guess order details or delay — politely direct the customer to email test@gmail.com with their order number.

CURRENT STORE INVENTORY (Synced live from Google Sheet):
${catalogList}`;

    // Only send the last 10 messages to keep the request small and fast
    const contents = messages
      .slice(-10)
      .filter((m: { role: string; content: string }) => m.content && m.content.trim() !== "")
      .map((m: { role: string; content: string }) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
      return NextResponse.json(
        { error: "Last message must be from the user." },
        { status: 400 }
      );
    }

    // Key goes in a header instead of the URL (keeps it out of logs)
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const body = JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 250,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    let geminiRes: Response | null = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        geminiRes = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body,
          // Give up on a stuck request instead of hanging forever
          signal: AbortSignal.timeout(12000),
        });
      } catch (err) {
        console.warn(`Gemini request failed/timed out (attempt ${attempt})`, err);
        geminiRes = null;
        continue;
      }

      if (geminiRes.ok) break;

      if (geminiRes.status === 503 || geminiRes.status === 429) {
        console.warn(`Gemini returned ${geminiRes.status}. Retrying (attempt ${attempt})...`);
        await new Promise((r) => setTimeout(r, 600));
      } else {
        break;
      }
    }

    if (!geminiRes || !geminiRes.ok) {
      const errorText = geminiRes ? await geminiRes.text() : "No response / timeout";
      console.error("Gemini API error:", geminiRes?.status, errorText);
      return NextResponse.json(
        { error: "The assistant is busy right now. Please try again in a moment." },
        { status: geminiRes ? geminiRes.status : 504 }
      );
    }

    const data = await geminiRes.json();
    const rawReply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I'm sorry, I couldn't formulate a response right now. Please try again!";

    const words = rawReply.trim().split(/\s+/);
    const reply =
      words.length > 50 ? words.slice(0, 50).join(" ") + "..." : rawReply;

    return NextResponse.json({ reply });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
