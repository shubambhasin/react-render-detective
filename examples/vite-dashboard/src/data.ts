export interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number;
  updatedAt: string;
}

const CATEGORIES = ["Hardware", "Software", "Services", "Support"];

export const PRODUCTS: Product[] = Array.from({ length: 240 }, (_, i) => ({
  id: i + 1,
  name: `Product ${String(i + 1).padStart(3, "0")}`,
  category: CATEGORIES[i % CATEGORIES.length] as string,
  price: 20 + ((i * 37) % 900),
  stock: (i * 13) % 120,
  updatedAt: new Date(2026, 0, 1 + (i % 240)).toISOString().slice(0, 10),
}));

/** Stands in for a data-fetching layer; deliberately returns a new array each call. */
export function queryProducts(query: string, category: string): Product[] {
  const q = query.trim().toLowerCase();
  return PRODUCTS.filter(
    (p) =>
      (category === "All" || p.category === category) &&
      (q === "" || p.name.toLowerCase().includes(q)),
  );
}

export { CATEGORIES };
