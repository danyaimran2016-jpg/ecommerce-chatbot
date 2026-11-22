import { NextResponse } from "next/server";
import { getStoreProducts } from "@/lib/products";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const products = await getStoreProducts();
    return NextResponse.json(products);
  } catch (error) {
    console.error("API error fetching products:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 }
    );
  }
}

