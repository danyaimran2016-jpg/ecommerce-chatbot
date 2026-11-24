import { NextRequest, NextResponse } from "next/server";
import { getStoreProducts } from "@/lib/products";
import { Product } from "@/types/product.types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ---- Product cache: avoid re-fetching the Google Sheet on every message ----
const CACHE_TTL_MS = 60 * 1000; // refresh sheet data at most once per minute
let cachedData: { catalogText: string; products: Product[]; time: number } | null = null;

async function getStoreData(): Promise<{ catalogText: string; products: Product[] }> {
  if (cachedData && Date.now() - cachedData.time < CACHE_TTL_MS) {
    return cachedData;
  }

  const { allProducts } = await getStoreProducts();

  const catalogText = allProducts
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

  cachedData = { catalogText, products: allProducts, time: Date.now() };
  return cachedData;
}

// Fallback catalog assistant when Gemini API hits free-tier rate limits or high-demand 503s
function generateCatalogFallbackReply(userText: string, products: Product[]): string {
  const query = userText.toLowerCase().trim();

  // Rule 7: Immediate support escalation for orders, refunds, cancellations, delays
  if (
    query.includes("cancel") ||
    query.includes("refund") ||
    query.includes("delay") ||
    query.includes("shipping") ||
    query.includes("track") ||
    query.includes("order") ||
    query.includes("return") ||
    query.includes("dispute") ||
    query.includes("damage") ||
    query.includes("broken")
  ) {
    return "For order cancellations, shipping delays, or refund disputes, please email our support immediately at test@gmail.com with your order details.";
  }

  // Greetings
  if (
    query === "hi" ||
    query === "hello" ||
    query === "hey" ||
    query.startsWith("hi ") ||
    query.startsWith("hello ") ||
    query === "help"
  ) {
    return "Hello! Welcome to Shop.co. I can check product prices, stock status, and details from our live catalog. For support, email test@gmail.com.";
  }

  // Stock / available items queries
  if (
    query.includes("in stock") ||
    query.includes("available") ||
    query.includes("what products") ||
    query.includes("all products") ||
    query.includes("collection")
  ) {
    const inStock = products.filter((p) =>
      (p.stockStatus || "in stock").toLowerCase().includes("in")
    );
    const samples = (inStock.length > 0 ? inStock : products).slice(0, 2);
    const list = samples
      .map(
        (p) =>
          `[${p.title}](/shop/product/${p.id}/${encodeURIComponent(
            p.title.split(" ").join("-")
          )}) ($${p.price}, ${p.stockStatus || "in stock"})`
      )
      .join(", and ");
    return `We currently have ${list}. Check our shop or email test@gmail.com for help!`;
  }

  // Keyword / product search
  const words = query.split(/\s+/).filter((w) => w.length > 2);
  const matched = products.filter((p) => {
    const titleLower = p.title.toLowerCase();
    const catLower = (p.category || "").toLowerCase();
    const descLower = (p.description || "").toLowerCase();

    return (
      titleLower.includes(query) ||
      catLower.includes(query) ||
      words.some((w) => titleLower.includes(w) || catLower.includes(w) || descLower.includes(w))
    );
  });

  if (matched.length > 0) {
    const top = matched.slice(0, 2);
    const mentions = top
      .map(
        (p) =>
          `[${p.title}](/shop/product/${p.id}/${encodeURIComponent(
            p.title.split(" ").join("-")
          )}) is $${p.price} (${p.stockStatus || "in stock"})`
      )
      .join(", and ");
    return `We have ${mentions}. For questions, please reach test@gmail.com.`;
  }

  // Rule 5: Never guess or assume
  return "We do not currently have that item in our inventory. Please check back later or contact test@gmail.com for inquiries.";
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

    const { catalogText, products } = await getStoreData();

    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    const apiKey = process.env.GEMINI_API_KEY;
    const configuredModel = process.env.GEMINI_MODEL || "gemini-3.6-flash";

    // If an API key is configured, try calling Gemini models with graceful fallbacks
    if (apiKey) {
      const candidateModels = Array.from(
        new Set([configuredModel, "gemini-flash-lite-latest", "gemini-3.5-flash-lite"])
      );

      const systemInstruction = `You are the official AI Shopping Assistant for "Shop.co", a trendy fashion and lifestyle store.

CORE RULES:
1. BE POLITE & COURTEOUS: Always communicate warmly, respectfully, and politely.
2. BE CONCISE: Deliver clear, direct, and compact answers.
3. STRICT LENGTH LIMIT: The maximum size of your answer MUST NOT exceed 50 words under any circumstance.
4. FOLLOW SHEET PRICES STRICTLY: Always cite the exact price listed in the inventory below. Never round, discount without authorization, or alter prices.
5. NEVER GUESS OR ASSUME: Only provide information that is explicitly stated in the inventory. If an item, price, size, or detail is not in the inventory, politely state that we do not have it. Never invent, hallucinate, or guess.
6. STOCK & LINKS: Always specify if an item is "in stock" or "out of stock", and format product mentions as Markdown links: [Product Name](/shop/product/id/slug).
7. IMMEDIATE SUPPORT ESCALATION (test@gmail.com): For issues such as order cancellations, shipping delays, tracking issues, damaged items, or refund disputes, IMMEDIATELY offer our customer support email: test@gmail.com. Do not guess order details or delay — politely direct the customer to email test@gmail.com with their order number.

CURRENT STORE INVENTORY (Synced live from Google Sheet):
${catalogText}`;

      const contents = messages
        .slice(-10)
        .filter((m: { role: string; content: string }) => m.content && m.content.trim() !== "")
        .map((m: { role: string; content: string }) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      for (const model of candidateModels) {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const generationConfig: Record<string, any> = {
          temperature: 0.7,
          maxOutputTokens: 250,
        };

        if (model.includes("3.6")) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const body = JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig,
        });

        try {
          const geminiRes = await fetch(apiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body,
            signal: AbortSignal.timeout(5000), // Quick timeout so user gets response without delay
          });

          if (geminiRes.ok) {
            const data = await geminiRes.json();
            const parts = data.candidates?.[0]?.content?.parts || [];
            const textPart = parts.find((p: any) => p.text && !p.thought) || parts[0];
            const rawReply = textPart?.text;

            if (rawReply) {
              const words = rawReply.trim().split(/\s+/);
              const reply =
                words.length > 50 ? words.slice(0, 50).join(" ") + "..." : rawReply;
              return NextResponse.json({ reply });
            }
          }
        } catch {
          // Timeout or connection error: proceed to next fallback
        }
      }
    }

    // If Gemini API is unavailable, busy (503), or quota exhausted (429), use catalog assistant
    const fallbackReply = generateCatalogFallbackReply(lastUserMessage, products);
    return NextResponse.json({ reply: fallbackReply });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      {
        reply:
          "Welcome to Shop.co! For immediate assistance with orders or questions, please contact our team at test@gmail.com.",
      },
      { status: 200 }
    );
  }
}
