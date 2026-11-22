import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Product } from "@/types/product.types";

let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedCreds: any = null;
let cachedProducts: { products: Product[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 60 * 1000; // Cache products for 60 seconds to eliminate network latency

async function getGoogleAccessToken(creds: {
  client_email: string;
  private_key: string;
  token_uri: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: creds.token_uri,
    exp: now + 3600,
    iat: now,
  };

  function base64UrlEncode(obj: unknown) {
    return Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  const encodedHeader = base64UrlEncode(header);
  const encodedClaimSet = base64UrlEncode(claimSet);
  const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signatureInput);
  const signature = signer
    .sign(creds.private_key, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${signatureInput}.${signature}`;

  const tokenRes = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    throw new Error(`Google OAuth error: ${errorText}`);
  }

  const tokenData = await tokenRes.json();
  cachedToken = {
    token: tokenData.access_token,
    expiresAt: now + (tokenData.expires_in || 3600),
  };

  return cachedToken.token;
}

// Map curated fallback images based on product name / category
function resolveProductImage(title: string, category: string, index: number): string {
  const lowerTitle = title.toLowerCase();
  const lowerCat = category.toLowerCase();

  if (lowerTitle.includes("jean")) return "/images/pic2.png";
  if (lowerTitle.includes("cardigan")) return "/images/pic4.png";
  if (lowerTitle.includes("shirt") || lowerTitle.includes("t-shirt")) return "/images/pic1.png";
  if (lowerTitle.includes("short")) return "/images/pic7.png";
  if (lowerTitle.includes("purse") || lowerTitle.includes("bag")) return "/images/pic8.png";
  if (lowerTitle.includes("primer")) return "/images/pic12.png";
  if (lowerTitle.includes("blush")) return "/images/pic10.png";
  if (lowerTitle.includes("lipstick")) return "/images/pic11.png";
  if (lowerTitle.includes("liner") || lowerTitle.includes("eye")) return "/images/pic13.png";
  if (lowerTitle.includes("powder")) return "/images/pic14.png";
  if (lowerTitle.includes("perfume")) return "/images/pic15.png";

  if (lowerCat === "beauty") return `/images/pic${10 + (index % 5)}.png`;
  if (lowerCat === "perfume") return "/images/pic15.png";
  if (lowerCat === "accessory") return "/images/pic8.png";

  return `/images/pic${(index % 15) + 1}.png`;
}

export async function fetchProductsFromGoogleSheet(): Promise<Product[]> {
  try {
    const now = Date.now();
    if (cachedProducts && now - cachedProducts.timestamp < CACHE_TTL_MS) {
      return cachedProducts.products;
    }

    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || "ecommerceai-514910-f20236f6f622.json";
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID || "1s2UkSygy1RZUsQEA8LNgfCZcH_pMqgPw6hOJ4IDr2RE";
    const range = process.env.GOOGLE_SHEET_RANGE || "Sheet1!A1:Z100";

    if (!cachedCreds) {
      const keyPath = path.isAbsolute(keyFile)
        ? keyFile
        : path.join(process.cwd(), keyFile);

      if (!fs.existsSync(keyPath)) {
        console.warn(`Service account key not found at: ${keyPath}. Using fallback data.`);
        return cachedProducts ? cachedProducts.products : [];
      }

      cachedCreds = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    }

    const creds = cachedCreds;
    const accessToken = await getGoogleAccessToken(creds);

    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        next: { revalidate: 60 },
      }
    );

    if (!sheetRes.ok) {
      console.error("Sheets API error:", await sheetRes.text());
      return [];
    }

    const data = await sheetRes.json();
    const rows: string[][] = data.values || [];

    if (rows.length < 2) {
      return [];
    }

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const nameIdx = headers.findIndex(
      (h) => h.includes("product") || h.includes("name") || h.includes("title")
    );
    const catIdx = headers.findIndex((h) => h.includes("category"));
    const priceIdx = headers.findIndex((h) => h.includes("price"));
    const stockIdx = headers.findIndex((h) => h.includes("stock"));
    const descIdx = headers.findIndex((h) => h.includes("desc"));
    const imgIdx = headers.findIndex((h) => h.includes("image") || h.includes("img") || h.includes("photo") || h.includes("url"));
    const ratingIdx = headers.findIndex((h) => h.includes("rating"));
    const discountIdx = headers.findIndex((h) => h.includes("discount"));

    const products: Product[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const rawTitle = nameIdx !== -1 && row[nameIdx] ? row[nameIdx].trim() : `Product ${i}`;
      if (!rawTitle) continue;

      // Capitalize title words nicely
      const title = rawTitle
        .split(" ")
        .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
        .join(" ");

      const category = catIdx !== -1 && row[catIdx] ? row[catIdx].trim() : "General";
      const rawPrice = priceIdx !== -1 && row[priceIdx] ? row[priceIdx].toString() : "0";
      const cleanPrice = parseFloat(rawPrice.replace(/[^0-9.]/g, "")) || 50;

      const stockStatus = stockIdx !== -1 && row[stockIdx] ? row[stockIdx].trim() : "in stock";
      const description = descIdx !== -1 && row[descIdx] ? row[descIdx].trim() : "";

      const customImg = imgIdx !== -1 && row[imgIdx] ? row[imgIdx].trim() : "";
      const srcUrl = customImg || resolveProductImage(rawTitle, category, i - 1);

      const parsedRating = ratingIdx !== -1 && row[ratingIdx] ? parseFloat(row[ratingIdx]) : null;
      const rating = parsedRating && !isNaN(parsedRating) ? parsedRating : 4.5;

      const parsedDiscount = discountIdx !== -1 && row[discountIdx] ? parseInt(row[discountIdx].replace(/[^0-9]/g, ""), 10) : 0;
      const discountPercentage = parsedDiscount && !isNaN(parsedDiscount) ? parsedDiscount : (i % 3 === 0 ? 20 : 0);

      products.push({
        id: i,
        title,
        category,
        price: cleanPrice,
        stockStatus,
        description,
        srcUrl,
        gallery: [srcUrl],
        rating,
        discount: {
          amount: 0,
          percentage: discountPercentage,
        },
      });
    }

    if (products.length > 0) {
      cachedProducts = {
        products,
        timestamp: Date.now(),
      };
    }

    return products;
  } catch (error) {
    console.error("Error fetching products from Google Sheet:", error);
    return cachedProducts ? cachedProducts.products : [];
  }
}

