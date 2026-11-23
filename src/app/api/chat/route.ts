import { NextRequest, NextResponse } from "next/server";
import { getStoreProducts } from "@/lib/products";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "Messages array is required." },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY || "";
    const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

    // Fetch live product data from Google Sheet
    const { allProducts } = await getStoreProducts();

    const catalogList = allProducts
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

    // Format chat messages for Gemini v1beta API
    // Gemini expects alternating user and model roles
    const contents = messages
      .filter((m: { role: string; content: string }) => m.content && m.content.trim() !== "")
      .map((m: { role: string; content: string }) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    // Ensure the last message is from user
    if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
      return NextResponse.json(
        { error: "Last message must be from the user." },
        { status: 400 }
      );
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let geminiRes: Response | null = null;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      geminiRes = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemInstruction }],
          },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 250,
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        }),
      });

      if (geminiRes.ok) {
        break;
      }

      // If 503 (temporarily overloaded) or 429 (rate limit), wait and retry
      if (geminiRes.status === 503 || geminiRes.status === 429) {
        console.warn(`Gemini returned status ${geminiRes.status}. Retrying attempt ${attempts}...`);
        await new Promise((r) => setTimeout(r, 1200 * attempts));
      } else {
        break;
      }
    }

    if (!geminiRes || !geminiRes.ok) {
      const errorText = geminiRes ? await geminiRes.text() : "No response";
      console.error("Gemini API error:", geminiRes?.status, errorText);
      return NextResponse.json(
        {
          error: "Failed to generate response from Gemini.",
          details: errorText,
        },
        { status: geminiRes ? geminiRes.status : 500 }
      );
    }

    const data = await geminiRes.json();
    const rawReply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I'm sorry, I couldn't formulate a response right now. Please try again!";

    // Strictly ensure maximum length is at most 50 words
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

